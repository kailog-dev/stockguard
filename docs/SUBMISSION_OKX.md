# OKX X Layer TapeOut — submission draft

> Draft. Fields marked `<…>` are filled after the tape-out on Dec 5.

## One-liner

StockGuard XL tells wallets, routers and AI agents which X Layer pools are safe to use for a tokenized stock, and which ones are not. The rule is a 16-gate NAND circuit taped out on X Layer.

## Problem

The same stock trades in many pools on X Layer, and they are not equal. Live readings from Nov 26–27, 2026 (US$1,000 buy, quoted on-chain through Uniswap QuoterV2):

| Stock | Healthy pool | Cost of a $1,000 buy | Thin pool | Cost of a $1,000 buy |
|---|---|---|---|---|
| TSLA | wTSLAx/USDC (Uniswap v3) | 0.07 % | wTSLAx/USDG (Uniswap v3) | 31,789 % |
| AAPL | wAAPLx/USDC (Uniswap v3) | 0.12 % | wAAPLx/USDG (Uniswap v3) | 2,129 % |
| CRCL | — | — | wCRCLx/USDG (Uniswap v3) | 94,087 % |

A router or an agent that picks a pool by name alone can lose the whole order. Many pools also use look-alike quote tokens, have broken prices (one wQQQx pool reads $3.4 × 10⁵⁰), or have no independent price to check against.

## What it does

Every 60 seconds StockGuard XL:

1. **Finds real pools.** Uniswap v3 pools are kept only if the official X Layer factory (`0x4B2ab38D…6804`) confirms them through `getPool(token0, token1, fee)`. Uniswap v4 pools come from `Initialize` events on the official PoolManager. Token details are read from the token contracts, not from a listing.
2. **Measures depth with a real quote.** Uniswap QuoterV2 on X Layer returns what a $1,000 buy actually receives, including the fee and every tick crossed. Cost over 1 % → `THIN`.
3. **Checks the price against an independent reference.** In order: the same token contract on another chain (e.g. Ink), the Coinbase tokenized-stock NAV, or the original xStock on another chain. Off by ≥ 2 % → `GAP`; the same on the next check → `CONFIRMED`. No reference at all → `STALE`.
4. **Trusts dollars only by address.** USDG (Paxos) and USDC (Circle, X Layer bridge) are pinned by contract address. A stock-for-stock pool (e.g. wAAPLx/wSPYx) is priced through the other stock's own healthy stablecoin pool, using on-chain data only.
5. **Asks the circuit.** Six signals go in, one verdict comes out: `ROUTE_OK`, `CAUTION` or `DO_NOT_ROUTE`.

## The circuit (what is taped out)

```
Inputs:  UNTRUSTED, THIN, GAP, CONFIRMED, CLOSED, STALE
DO_NOT_ROUTE = UNTRUSTED ∨ THIN ∨ (GAP ∧ CONFIRMED) ∨ (STALE ∧ ¬CLOSED)
CAUTION      = ¬DO_NOT_ROUTE ∧ (GAP ∨ CLOSED)
ROUTE_OK     = neither
```

- 16 NAND gates, 112 bytes, TAP-02 format.
- Netlist hash: `0x2dd9f975dc370f9d0042afba0587792c4cbc074de593b472c71d798aad9fbe7e`
- All 64 input combinations are checked against the reference rule in tests (64/64).
- Fail closed: a consumer that cannot evaluate the circuit must treat the pool as `DO_NOT_ROUTE`.
- `CLOSED` uses the NYSE calendar, holidays and 1 p.m. early closes included. Tokenized stocks trade 24/7, but the reference price freezes when the US market is closed, so verdicts drop to `CAUTION` instead of `ROUTE_OK`.

## Why a circuit on X Layer

The rule is small, fixed and easy to audit, which suits a circuit well. Once taped out, anyone can run `eval` on X Layer with a pool's six signals and get the same verdict StockGuard publishes. The rule cannot be quietly changed afterwards, because the netlist hash is public. Routers, vaults and agents can depend on it without trusting StockGuard's server for the decision itself.

## Live

- Verdict page with the live circuit: https://stockguard.dev/xl/ (click any pool to send its signals through the gates)
- JSON: https://stockguard.dev/api/xl
- Snapshot at submission: `<n>` pools judged (Uniswap v3 + v4), `<n>` ROUTE_OK, `<n>` CAUTION, `<n>` DO_NOT_ROUTE, `<n>` not judged (no trusted dollar price).

## On-chain (X Layer, chain 196)

| Item | Value |
|---|---|
| Processor (CPU) | `<address>` |
| Tape-out transaction | `<tx hash>` |
| Netlist hash on-chain | `<matches 0x2dd9…be7e>` |
| `eval` checks | `<4 calls: ROUTE_OK, CAUTION, DO_NOT_ROUTE (THIN), DO_NOT_ROUTE (STALE)>` |

## Read-only by design

StockGuard XL never routes, swaps or holds funds. It answers one question: "may this order go through this pool right now?" The answer is for other software to act on.

## Tests

- Circuit: 64/64 combinations plus real-pool cases (THIN, UNTRUSTED+GAP, CLOSED, GAP, GAP+CONFIRMED, STALE).
- Depth math in both token orders and the execution-cost formula.
- Market-hours check, holidays and early closes included.

## Links

- Repo: https://github.com/kailog-dev/stockguard (X Layer code in `apps/worker/src/xl/`, `apps/api/src/xl.ts`, `apps/web/public/xl/`)
- Demo video: `<link>`
- X: @kailog_dev
