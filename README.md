[![make.fun bounty](https://make.fun/badge/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed.svg)](https://make.fun/bounty/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed?utm_source=github&utm_medium=readme&utm_campaign=badge)
[![rank](https://make.fun/badge/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed/soedirman566-stack/bot-sprint-bot/rank.svg)](https://make.fun/bounty/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed?utm_source=github&utm_medium=readme&utm_campaign=badge)
[![reward](https://make.fun/badge/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed/soedirman566-stack/bot-sprint-bot/reward.svg)](https://make.fun/bounty/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed?utm_source=github&utm_medium=readme&utm_campaign=badge)

# Dip-Bounce Scalper — Pump.fun Bot Sprint

A paper trading bot for the pump.fun replay (agent-fun/replay/v2), written
against the kit's TypeScript shim (`vendor/makefun-bot.ts`).

## Strategy

The first build chased strength — buying coins whose tape was already hot —
and the local grade punished it (win rate under 30%, fees ate the account).
The shipped bot buys capitulation instead, and only qualified capitulation:

- **Proven demand first:** inside a 96-slot tape window the coin must have
  run up at least 1.8x from its window low to its window high.
- **A real pullback:** the current price sits 25–55% below that high.
- **Buyers returning:** in the last 48 slots, buy flow is at least 0.4 SOL
  and net flow is at least +15% of total flow.
- **Curve sanity:** real SOL reserve between 2 and 60 SOL (enough room for
  the 1%-of-reserve order cap, not yet near graduation).

Risk rails do the rest: 0.15 SOL per position, at most 5 open, entries paced
to one per 60 slots, at most 2 entries per coin with a 3000-slot cooldown,
take profit at +25%, stop loss at −15%, a time stop for positions that never
bounce, and a drawdown brake that stops fresh entries once equity falls
below 65% of its peak — far inside the 50% max-drawdown guardrail.

Everything is decided from the batch stream alone (no clock, no randomness,
no environment reads), so repeated executions agree byte for byte.

## Local grade (dev window)

Iterated four times against `grade-local`; the shipped parameters were the
best of the runs: net PnL −0.19 SOL on the dev sample with max drawdown
3.2%, 86 coins carrying a qualifying round trip, all guardrails met. The
dev window is a small calibration sample; the final grade runs on a fresh
6-hour window collected after entries close.
