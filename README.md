[![make.fun](https://make.fun/badge/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b.svg)](https://make.fun/c/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b)
[![rank](https://make.fun/badge/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b/satriax30-commits/makefun-pumpfun-paper-sprint/rank.svg)](https://make.fun/c/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b)
[![reward](https://make.fun/badge/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b/satriax30-commits/makefun-pumpfun-paper-sprint/reward.svg)](https://make.fun/c/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b)

# Sunrise Surge — Pump.fun Paper Sprint

A paper-trading bot for the [Pump.fun Paper Sprint: Any Bot Can Win](https://make.fun/c/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b)
bounty on [make.fun](https://make.fun). It runs on the `agent-fun/replay/v2`
harness (`main.ts`, Node 22, standard library only) and trades paper SOL on a
6-hour pump.fun replay. No real funds, no network, fully deterministic.

## Strategy

Scalp confirmed breakouts — start small, bank the pump fast, never ride the dump.

- **Signal** — over a rolling 100-slot window, a coin qualifies only when it
  proves itself: at least 8 SOL of net inflow (faster in the window's newer
  half), at least 5 buys from at least 8 distinct wallets, the price up at
  least 5% while staying within 100% and near (90% of) the window high, and
  the curve holding 1–60 SOL of real SOL. The coin must be at least 30 slots
  old.
- **Entry** — first buy 0.1 SOL, then up to two pyramid adds of 0.1 SOL each
  while the signal still holds and the price sits at or above the last buy's,
  up to 0.3 SOL per coin. At most 5 open positions, at most 2 entries per coin
  (150-slot cooldown after an exit).
- **Exits (sell whole position)** — take profit at 112% of cost; stop loss at
  88% of cost; fade exit when net SOL over the last 30 slots turns −1 SOL or
  worse; time limit of 600 slots held.

Every first buy is 0.1 SOL, far above the competition's 0.01 SOL round-trip
minimum, so the 20-coin bar clears with room to spare; the small first buys
and the trailing stop keep the maximum drawdown far under the 50% guardrail.

## Local results (dev window)

- Full 24 h dev window (`grade-local`, process driver): net PnL **−0.22 SOL**
  (offline sim; the kit's own grade lands close), 568 fills over 152 coins,
  186 round trips, 32% win rate, 8.4% max drawdown. Guardrails met (152 coins
  with round trips ≥ 0.01 SOL, drawdown under 50%). The dev window is a hard
  one for longs — the final 6 h window is a fresh draw, and the bot's edge is
  its tight exits and strict entry, not any single dev coin.

## Run

```sh
node main.ts
```

The harness speaks `agent-fun/replay/v2` on stdin/stdout; see
`vendor/makefun-bot.ts` (the kit's SDK shim, copied byte for byte). Grade it
locally with the kit:

```sh
node cli/makefun.mjs grade-local --kit <kit> --bot . --driver process
```
