// Pump.fun Bot Sprint entry: a dip-buying scalper with hard risk rails.
//
// First version chased strength (buy the coins whose tape is already hot)
// and the local grade punished it: win rate under 30%, fees ate the account.
// So this bot buys capitulation instead. A coin that has fallen hard from
// its recent high while buy flow starts coming back has, on this tape, a
// better next few minutes than a coin at its highs. Entries are small,
// paced, capped per coin, and every position leaves on a take profit, a
// stop loss or a time stop. An equity drawdown brake stops fresh entries
// long before the 50% drawdown guardrail is in danger.
//
// Everything is decided from the batch stream alone (no clock, no random,
// no environment), so the two grading executions agree byte for byte.

import { runBot, LAMPORTS_PER_SOL } from './vendor/makefun-bot.ts';
import type { BotState, Batch, OrderInput } from './vendor/makefun-bot.ts';

// ---- tunables ---------------------------------------------------------------
const FLOW_WINDOW_SLOTS = 96; // tape window the dip is measured over
const RECENT_WINDOW_SLOTS = 48; // sub-window whose flow must turn back up
const MIN_RECENT_TRADES = 4; // trades in the recent sub-window
const MIN_RECENT_BUY_FLOW = 400_000_000n; // 0.4 SOL of buy flow, recent window
const MIN_RECENT_NET_RATIO = 0.15; // buyers back in charge, recent window
const MIN_RUNUP = 1.8; // window high / window low: the coin must have run first
const DIP_DEEP = -0.55; // buy the pullback, not a total collapse
const DIP_SHALLOW = -0.25; // ... and not a dip too small to matter
const MIN_REAL_RESERVE = 2_000_000_000n; // 2 SOL: below this the cap starves us
const MAX_REAL_RESERVE = 60_000_000_000n; // 60 SOL: avoid near-graduation curves
const BASE_SIZE = 150_000_000n; // 0.15 SOL a position
const MIN_SIZE = 12_000_000n; // a round trip only counts from 0.01 SOL up
const TAKE_PROFIT = 1.25; // mark value / cost at which we sell
const STOP_LOSS = 0.85;
const BUY_SLIPPAGE_BPS = 1200;
const SELL_SLIPPAGE_BPS = 1500;
const REENTRY_COOLDOWN_SLOTS = 3000;
const MAX_ENTRIES_PER_MINT = 2;
const ENTRY_PACING_SLOTS = 60; // at most one fresh entry per this many slots
const DD_BRAKE = 0.65; // stop entering when equity is under 65% of its peak
const MAX_ORDERS_OUT = 10; // stay well under the per-batch cap of 16

// ---- per-coin memory ----------------------------------------------------------
interface Obs {
  slot: number;
  buy: boolean;
  quote: bigint;
  price: number;
}

const tape = new Map<string, Obs[]>();
const entrySlot = new Map<string, number>();
const lastExitSlot = new Map<string, number>();
const tradedMints = new Set<string>();
const entriesPerMint = new Map<string, number>();
let firstSlot = -1;
let lastEntrySlot = -1;
let peakEquity = 0n;

function priceOf(vQuote: bigint, vToken: bigint): number {
  if (vToken === 0n) return 0;
  return Number(vQuote) / Number(vToken);
}

function noteEvents(state: BotState, batch: Batch): void {
  if (firstSlot < 0) firstSlot = batch.slot;
  for (const e of batch.events) {
    if (e.event !== 'TradeEvent') continue;
    let arr = tape.get(e.mint);
    if (arr === undefined) {
      arr = [];
      tape.set(e.mint, arr);
    }
    arr.push({
      slot: batch.slot,
      buy: e.is_buy,
      quote: BigInt(e.quote_amount),
      price: priceOf(BigInt(e.virtual_quote_reserves), BigInt(e.virtual_token_reserves)),
    });
  }
  const cutoff = batch.slot - FLOW_WINDOW_SLOTS;
  for (const [mint, arr] of tape) {
    let drop = 0;
    while (drop < arr.length && arr[drop].slot < cutoff) drop++;
    if (drop > 0) arr.splice(0, drop);
    if (arr.length === 0 && !state.positions.has(mint)) tape.delete(mint);
  }
}

function noteFills(batch: Batch): void {
  for (const f of batch.fills) {
    if (f.status !== 'filled') continue;
    if (f.side === 'buy') {
      tradedMints.add(f.mint);
      if (!entrySlot.has(f.mint)) entrySlot.set(f.mint, f.slot);
    } else {
      lastExitSlot.set(f.mint, f.slot);
      entrySlot.delete(f.mint);
    }
  }
}

function hasPending(state: BotState, mint: string, side: 'buy' | 'sell'): boolean {
  for (const p of state.pending.values()) {
    if (p.order.mint === mint && p.order.side === side) return true;
  }
  return false;
}

// Equity now: cash plus every position marked at its curve. Also feeds the
// drawdown brake via the running peak.
function equityNow(state: BotState): bigint {
  let eq = state.cash;
  for (const [mint, held] of state.positions) {
    const curve = state.curves.get(mint);
    if (curve === undefined || curve.virtual_token_reserves === 0n) continue;
    eq += (held.token_amount * curve.virtual_quote_reserves) / curve.virtual_token_reserves;
  }
  if (eq > peakEquity) peakEquity = eq;
  return eq;
}

// ---- exits ----------------------------------------------------------------------
function exitOrders(state: BotState): OrderInput[] {
  const out: OrderInput[] = [];
  for (const [mint, held] of state.positions) {
    if (hasPending(state, mint, 'sell')) continue;
    const curve = state.curves.get(mint);
    if (curve === undefined || curve.complete) continue;
    const value = (held.token_amount * curve.virtual_quote_reserves) / curve.virtual_token_reserves;
    const ratio = Number(value) / Number(held.cost_lamports);
    const since = entrySlot.get(mint);
    const heldSlots = since === undefined ? 0 : state.slot - since;
    const stale = heldSlots >= 900 && ratio < 1.02; // no bounce came: free the slot
    if (ratio >= TAKE_PROFIT || ratio <= STOP_LOSS || stale || heldSlots >= 1800) {
      out.push({ side: 'sell', mint, token_amount: held.token_amount, max_slippage_bps: SELL_SLIPPAGE_BPS });
    }
  }
  return out;
}

// ---- entries ----------------------------------------------------------------------
interface Candidate {
  mint: string;
  score: number;
  size: bigint;
}

function entryOrders(state: BotState, batch: Batch): OrderInput[] {
  if (batch.slot - lastEntrySlot < ENTRY_PACING_SLOTS) return [];
  const room = state.hello.caps.max_open_positions - state.committedPositionCount();
  if (room <= 0) return [];
  // Drawdown brake: once equity is well under its peak, protect what is left.
  if (peakEquity > 0n && equityNow(state) * 100n < peakEquity * BigInt(Math.round(DD_BRAKE * 100))) return [];

  const recentCutoff = batch.slot - RECENT_WINDOW_SLOTS;
  const cands: Candidate[] = [];
  for (const [mint, arr] of tape) {
    if (state.positions.has(mint) || hasPending(state, mint, 'buy')) continue;
    if ((entriesPerMint.get(mint) ?? 0) >= MAX_ENTRIES_PER_MINT) continue;
    const lastExit = lastExitSlot.get(mint);
    if (lastExit !== undefined && batch.slot - lastExit < REENTRY_COOLDOWN_SLOTS) continue;
    const curve = state.curves.get(mint);
    if (curve === undefined || curve.complete) continue;
    if (curve.real_quote_reserves < MIN_REAL_RESERVE || curve.real_quote_reserves > MAX_REAL_RESERVE) continue;

    let high = 0;
    let low = Infinity;
    let recentTrades = 0;
    let recentBuy = 0n;
    let recentSell = 0n;
    for (const o of arr) {
      if (o.price > high) high = o.price;
      if (o.price > 0 && o.price < low) low = o.price;
      if (o.slot >= recentCutoff) {
        recentTrades++;
        if (o.buy) recentBuy += o.quote;
        else recentSell += o.quote;
      }
    }
    if (recentTrades < MIN_RECENT_TRADES || recentBuy < MIN_RECENT_BUY_FLOW) continue;
    const recentTotal = recentBuy + recentSell;
    if (recentTotal === 0n) continue;
    const netRatio = Number(recentBuy - recentSell) / Number(recentTotal);
    if (netRatio < MIN_RECENT_NET_RATIO) continue;
    const nowPrice = priceOf(curve.virtual_quote_reserves, curve.virtual_token_reserves);
    if (high <= 0 || nowPrice <= 0 || low === Infinity) continue;
    // Only coins that proved demand first: a real run-up inside the window,
    // then a pullback inside the buyable band.
    if (high / low < MIN_RUNUP) continue;
    const dip = nowPrice / high - 1;
    if (dip > DIP_SHALLOW || dip < DIP_DEEP) continue;

    const cap = state.maxBuyLamports(mint);
    let size = BASE_SIZE < cap ? BASE_SIZE : cap;
    const free = state.freeCashLamports() / 4n;
    if (free < size) size = free;
    if (size < MIN_SIZE) continue;
    cands.push({ mint, score: netRatio - dip, size });
  }
  cands.sort((a, b) => b.score - a.score || (a.mint < b.mint ? -1 : 1));
  const out: OrderInput[] = [];
  for (const c of cands) {
    if (out.length >= room) break;
    out.push({ side: 'buy', mint: c.mint, quote_lamports: c.size, max_slippage_bps: BUY_SLIPPAGE_BPS });
    entriesPerMint.set(c.mint, (entriesPerMint.get(c.mint) ?? 0) + 1);
    lastEntrySlot = batch.slot;
  }
  return out;
}

await runBot({
  onBatch(state: BotState, batch: Batch) {
    noteFills(batch);
    noteEvents(state, batch);
    equityNow(state);
    const orders: OrderInput[] = [];
    orders.push(...exitOrders(state));
    orders.push(...entryOrders(state, batch));
    return orders.slice(0, MAX_ORDERS_OUT);
  },
});
