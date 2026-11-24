// Sunrise Surge v2 — a pump.fun paper-trading bot for agent-fun/replay/v2.
//
// Concept: scalp confirmed breakouts. A coin becomes a buy only when it proves
// itself — at least 8 SOL of net inflow and 5 buys from 8 distinct wallets over
// a 100-slot window, price up at least 5% and near the window high. The bot starts
// small (0.1 SOL), pyramids into strength only, and banks the pump fast: take
// profit at +12%, stop loss at −12%, a fade exit when inflow reverses, and a
// 600-slot time limit so dead money never sits. Paper money only: no real funds,
// no network, no clock, no randomness — every decision is a pure function of the
// batches the harness sends.
//
// Guardrails the bot is built to clear: at least 20 distinct mints with round trips of
// at least 0.01 SOL each, max drawdown far under 50%, net PnL above 0 after every fee.

import {
  LAMPORTS_PER_SOL,
  type Batch,
  type Bot,
  type BotState,
  type BuyInput,
  type Curve,
  type Pubkey,
  type SellInput,
} from './vendor/makefun-bot.ts';

// --------------------------------------------------------------------------- tuning
export interface StrategyParams {
  /** Rolling signal window, in slots. */
  windowSlots: number;
  /** Entry needs at least this net SOL (buys minus sells) over the window. */
  minNetSolLamports: bigint;
  /** Entry needs at least this many buy trades in the window. */
  minBuys: number;
  /** Entry needs at least this many distinct buyers in the window. */
  minBuyers: number;
  /** Entry needs the price up at least this much over the window (percent). */
  minRisePct: bigint;
  /** Entry refuses a coin already up more than this over the window (percent). */
  maxRisePct: bigint;
  /** Newer-half net inflow must be at least this multiple of the older half's. */
  accelMin: number;
  /** Entry needs the price at least this share of the window's high (percent). */
  nearHighPct: bigint;
  /** Entry needs real SOL in the curve between these bounds. */
  minRqSolLamports: bigint;
  maxRqSolLamports: bigint;
  /** Slots since CreateEvent before an entry is allowed (fresh curves dump). */
  minAgeSlots: number;
  /** First buy of a position (lamports). */
  initialLamports: bigint;
  /** Each pyramid add (lamports). */
  addLamports: bigint;
  /** Most lamports ever put into one position. */
  maxStakeLamports: bigint;
  /** Most pyramid adds per position. */
  maxAdds: number;
  /** Stop loss: sell when the mark value falls to this share of cost (percent). */
  stopLossPct: bigint;
  /** Take profit: sell when the mark value reaches this share of cost (percent). */
  takeProfitPct: bigint;
  /** Trailing exit arms once the value reaches this share of cost (percent). */
  trailArmPct: bigint;
  /** ... and fires when the value falls back to this share of the peak (percent). */
  trailGivebackPct: bigint;
  /** Exit when net SOL over the fade window falls below this (lamports, negative). */
  fadeNetLamports: bigint;
  /** Fade window, in slots. */
  fadeWindowSlots: number;
  /** Exit a position held longer than this (slots). */
  maxHoldSlots: number;
  /** Slots to wait after an exit before the same curve may be bought again. */
  cooldownSlots: number;
  /** Most entries per curve over the run. */
  maxEntries: number;
  /** Buys tolerate this much adverse price move between decision and fill (bps). */
  buySlippageBps: number;
  /** Sells tolerate this much adverse price move between decision and fill (bps). */
  sellSlippageBps: number;
}

export const DEFAULT_PARAMS: StrategyParams = {
  windowSlots: 100,
  minNetSolLamports: 8n * LAMPORTS_PER_SOL, // 8 SOL
  minBuys: 5,
  minBuyers: 8,
  minRisePct: 5n,
  maxRisePct: 100n,
  accelMin: 1,
  nearHighPct: 90n,
  minRqSolLamports: LAMPORTS_PER_SOL, // 1 SOL
  maxRqSolLamports: 60n * LAMPORTS_PER_SOL,
  minAgeSlots: 30,
  initialLamports: LAMPORTS_PER_SOL / 10n, // 0.1 SOL
  addLamports: LAMPORTS_PER_SOL / 10n, // 0.1 SOL
  maxStakeLamports: (LAMPORTS_PER_SOL * 3n) / 10n, // 0.3 SOL
  maxAdds: 2,
  stopLossPct: 88n,
  takeProfitPct: 112n, // tight scalp target: bank the pump, don't ride the dump
  trailArmPct: 1000n, // trailing off: the take-profit does the banking
  trailGivebackPct: 85n,
  fadeNetLamports: -LAMPORTS_PER_SOL, // -1 SOL
  fadeWindowSlots: 30,
  maxHoldSlots: 600,
  cooldownSlots: 150,
  maxEntries: 2,
  buySlippageBps: 1500,
  sellSlippageBps: 10000,
};

// --------------------------------------------------------------------------- price math
// A price is a (virtual quote, virtual token) reserve pair. Ratios are compared in
// integers by cross-multiplication, so no floats ever enter a price decision.

interface Price {
  vq: bigint;
  vt: bigint;
}

function curvePrice(curve: Curve): Price {
  return { vq: curve.virtual_quote_reserves, vt: curve.virtual_token_reserves };
}

/** True when price `now` is at least `pct` percent above price `ref`. */
function isUpAtLeast(now: Price, ref: Price, pct: bigint): boolean {
  return now.vq * ref.vt * 100n >= ref.vq * now.vt * (100n + pct);
}

/** True when price `now` is at most `pct` percent above price `ref`. */
function isUpAtMost(now: Price, ref: Price, pct: bigint): boolean {
  return now.vq * ref.vt * 100n <= ref.vq * now.vt * (100n + pct);
}

/** Mark value of `tokens` at `price`, in lamports (integer division, rounds down). */
function markValueLamports(tokens: bigint, price: Price): bigint {
  if (price.vt === 0n) return 0n;
  return (tokens * price.vq) / price.vt;
}

// --------------------------------------------------------------------------- tape
/** One recorded trade on a curve. */
interface TapeTrade {
  slot: number;
  buy: boolean;
  /** SOL side of the trade, in lamports (always positive). */
  sol: bigint;
  user: string;
  /** Post-trade price. */
  price: Price;
}

interface CoinBook {
  createdSlot: number;
  /** Price at creation (virtual reserves from the CreateEvent). */
  createPrice: Price;
  /** Trades seen on this curve, oldest first (pruned to the signal window). */
  tape: TapeTrade[];
  /** Entries (first buys) taken on this curve so far. */
  entries: number;
  /** Slot of the last exit from this curve (-1 if never exited). */
  lastExitSlot: number;
  /** Slot the current position's first buy was decided on (-1 when flat). */
  buySlot: number;
  /** Highest mark value the current position has reached, in lamports. */
  peakValue: bigint;
  /** Lamports ever spent on the current position (buys decided, fees excluded). */
  invested: bigint;
  /** Pyramid adds taken on the current position. */
  adds: number;
  /** Price the last buy of the current position was decided at. */
  lastAddPrice: Price | null;
  /** A sell for the current position is decided and not yet resolved. */
  exiting: boolean;
}

// --------------------------------------------------------------------------- the bot
export function createStrategy(p: StrategyParams = DEFAULT_PARAMS): Bot {
  // Fresh book per strategy instance, so one process can grade many parameter sets.
  const book = new Map<Pubkey, CoinBook>();

  function noteCreate(mint: Pubkey, slot: number, price: Price): void {
    if (book.has(mint)) return;
    book.set(mint, {
      createdSlot: slot,
      createPrice: price,
      tape: [],
      entries: 0,
      lastExitSlot: -1,
      buySlot: -1,
      peakValue: 0n,
      invested: 0n,
      adds: 0,
      lastAddPrice: null,
      exiting: false,
    });
  }

  /** Signal over the rolling window ending at the current slot. */
  function signal(entry: CoinBook, nowSlot: number): {
    ok: boolean;
    net: bigint;
    buys: number;
    buyers: number;
    riseOk: boolean;
    nearHighOk: boolean;
    accelOk: boolean;
  } {
    const from = nowSlot - p.windowSlots;
    const win = entry.tape.filter((t) => t.slot > from);
    let net = 0n;
    let buys = 0;
    const buyers = new Set<string>();
    let high = win.length > 0 ? win[0]!.price : entry.createPrice;
    for (const t of win) {
      net += t.buy ? t.sol : -t.sol;
      if (t.buy) {
        buys++;
        buyers.add(t.user);
      }
      // Track the window high by comparing ratios without floats.
      if (t.price.vq * high.vt > high.vq * t.price.vt) high = t.price;
    }
    const first = win.length > 0 ? win[0]!.price : entry.createPrice;
    const last = win.length > 0 ? win[win.length - 1]!.price : entry.createPrice;
    const riseOk = isUpAtLeast(last, first, p.minRisePct) && isUpAtMost(last, first, p.maxRisePct);
    // Price now at least nearHighPct of the window high: last * 100 >= high * nearHighPct.
    const nearHighOk = last.vq * high.vt * 100n >= high.vq * last.vt * p.nearHighPct;
    // Acceleration: net inflow in the newer half vs the older half of the window.
    const mid = from + p.windowSlots / 2;
    let netOld = 0n;
    let netNew = 0n;
    for (const t of win) {
      const d = t.buy ? t.sol : -t.sol;
      if (t.slot <= mid) netOld += d;
      else netNew += d;
    }
    const accelOk = netOld <= 0n ? netNew > 0n : Number(netNew) >= p.accelMin * Number(netOld);
    const ok =
      net >= p.minNetSolLamports && buys >= p.minBuys && buyers.size >= p.minBuyers && riseOk && nearHighOk && accelOk;
    return { ok, net, buys, buyers: buyers.size, riseOk, nearHighOk, accelOk };
  }

  /** Net SOL flow over the fade window (buys minus sells, lamports). */
  function fadeNet(entry: CoinBook, nowSlot: number): bigint {
    const from = nowSlot - p.fadeWindowSlots;
    let net = 0n;
    for (const t of entry.tape) {
      if (t.slot <= from) continue;
      net += t.buy ? t.sol : -t.sol;
    }
    return net;
  }

  /** Prune a coin's tape to the longest window any signal reads. */
  function prune(entry: CoinBook, nowSlot: number): void {
    const keep = Math.max(p.windowSlots, p.fadeWindowSlots);
    const from = nowSlot - keep;
    while (entry.tape.length > 0 && entry.tape[0]!.slot <= from) entry.tape.shift();
  }

  function entryOrders(state: BotState, batch: Batch): BuyInput[] {
    const { caps } = state.hello;
    const tx = state.txFeeLamports();
    const orders: BuyInput[] = [];
    let free = state.freeCashLamports();
    let slots = caps.max_open_positions - state.committedPositionCount();

    // Coins touched by this batch, in event order.
    const touched = new Set<Pubkey>();
    for (const e of batch.events) {
      if (e.event === 'TradeEvent') touched.add(e.mint);
    }

    for (const mint of touched) {
      const entry = book.get(mint);
      if (entry === undefined) continue;
      const curve = state.curves.get(mint);
      if (curve === undefined || curve.complete) continue;
      const age = state.slot - entry.createdSlot;
      if (age < p.minAgeSlots) continue;
      if (curve.real_quote_reserves < p.minRqSolLamports || curve.real_quote_reserves > p.maxRqSolLamports) continue;

      const held = state.positions.get(mint);
      if (held !== undefined) {
        // Pyramid: add while the signal still holds, the price is at or above the
        // last buy's, and the position is still under its max stake. An add opens no
        // new position, so it needs no free position slot — only reply room and cash.
        if (
          entry.adds < p.maxAdds &&
          entry.invested + p.addLamports <= p.maxStakeLamports &&
          entry.lastAddPrice !== null &&
          orders.length < caps.max_orders_per_batch
        ) {
          const price = curvePrice(curve);
          const sig = signal(entry, state.slot);
          const atOrAboveLast =
            price.vq * entry.lastAddPrice.vt >= entry.lastAddPrice.vq * price.vt;
          if (sig.ok && atOrAboveLast) {
            const cap = state.maxBuyLamports(mint);
            const amount = cap < p.addLamports ? cap : p.addLamports;
            if (amount >= LAMPORTS_PER_SOL / 100n && free >= amount + tx) {
              entry.adds++;
              entry.invested += amount;
              entry.lastAddPrice = price;
              orders.push({ side: 'buy', mint, quote_lamports: amount, max_slippage_bps: p.buySlippageBps });
              free -= amount + tx;
            }
          }
        }
        continue;
      }

      // Flat: a first buy needs a fresh entry (entries left, cooldown passed, a free slot).
      if (entry.entries >= p.maxEntries) continue;
      if (entry.lastExitSlot >= 0 && state.slot - entry.lastExitSlot < p.cooldownSlots) continue;
      if (orders.length >= caps.max_orders_per_batch || slots <= 0) continue;
      if (!signal(entry, state.slot).ok) continue;
      const cap = state.maxBuyLamports(mint);
      const amount = cap < p.initialLamports ? cap : p.initialLamports;
      if (amount < LAMPORTS_PER_SOL / 100n || free < amount + tx) continue;
      entry.entries++;
      entry.buySlot = state.slot;
      entry.peakValue = 0n;
      entry.invested = amount;
      entry.adds = 0;
      entry.lastAddPrice = curvePrice(curve);
      orders.push({ side: 'buy', mint, quote_lamports: amount, max_slippage_bps: p.buySlippageBps });
      free -= amount + tx;
      slots -= 1;
    }
    return orders;
  }

  function exitOrders(state: BotState): SellInput[] {
    const orders: SellInput[] = [];
    for (const [mint, holding] of state.positions) {
      const curve = state.curves.get(mint);
      if (curve === undefined || curve.complete) continue; // the harness closes completes itself
      const entry = book.get(mint);
      if (entry === undefined || entry.exiting) continue;
      const price = curvePrice(curve);
      const value = markValueLamports(holding.token_amount, price);
      const cost = holding.cost_lamports;
      if (cost === 0n || value === 0n) continue;

      const sellAll = (): void => {
        orders.push({ side: 'sell', mint, token_amount: holding.token_amount, max_slippage_bps: p.sellSlippageBps });
        entry.exiting = true;
        entry.lastExitSlot = state.slot;
        entry.buySlot = -1;
      };

      if (value > entry.peakValue) entry.peakValue = value;

      // Take profit: bank the winner at the target (when set).
      if (value * 100n >= cost * p.takeProfitPct) {
        sellAll();
        continue;
      }
      // Stop loss: cut the loser before it eats the stake.
      if (value * 100n <= cost * p.stopLossPct) {
        sellAll();
        continue;
      }
      // Trailing exit: once the position peaks past the arm level, sell when it
      // gives back to the give-back share of that peak.
      if (entry.peakValue * 100n >= cost * p.trailArmPct) {
        if (value * 100n <= entry.peakValue * p.trailGivebackPct) {
          sellAll();
          continue;
        }
      }
      // Fade exit: the inflow that carried the coin has reversed.
      if (fadeNet(entry, state.slot) <= p.fadeNetLamports) {
        sellAll();
        continue;
      }
      // Time limit: a position that has sat past its hold window is closed.
      if (entry.buySlot >= 0 && state.slot - entry.buySlot > p.maxHoldSlots) {
        sellAll();
        continue;
      }
    }
    return orders;
  }

  return {
    onBatch(state, batch) {
      // A sell decided on an earlier batch resolves after the latency: while it is
      // pending the position stays in the account, so never sell it twice. Clear the
      // flag once the position is gone (filled) or no sell is pending any more
      // (rejected/failed: the exit may be retried).
      for (const [mint, entry] of book) {
        if (!entry.exiting) continue;
        if (!state.positions.has(mint)) {
          entry.exiting = false;
          continue;
        }
        let sellPending = false;
        for (const pend of state.pending.values()) {
          if (pend.order.mint === mint && pend.order.side === 'sell') {
            sellPending = true;
            break;
          }
        }
        if (!sellPending) entry.exiting = false;
      }
      // Fold this batch's events into the books first.
      for (const e of batch.events) {
        if (e.event === 'CreateEvent') {
          noteCreate(e.mint, e.slot, { vq: BigInt(e.virtual_quote_reserves), vt: BigInt(e.virtual_token_reserves) });
        } else if (e.event === 'TradeEvent') {
          const entry = book.get(e.mint);
          if (entry !== undefined) {
            entry.tape.push({
              slot: e.slot,
              buy: e.is_buy,
              sol: BigInt(e.sol_amount),
              user: e.user,
              price: { vq: BigInt(e.virtual_quote_reserves), vt: BigInt(e.virtual_token_reserves) },
            });
            prune(entry, state.slot);
          }
        }
      }
      // Exits first: a sell frees a position slot (and cash, once it fills) that an
      // entry decided on the same batch can then use.
      const exits = exitOrders(state);
      const entries = entryOrders(state, batch);
      const orders: (BuyInput | SellInput)[] = [...exits, ...entries];
      const cap = state.hello.caps.max_orders_per_batch;
      return orders.slice(0, cap);
    },
  };
}
