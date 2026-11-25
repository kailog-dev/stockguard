# Reactive Omni Buildathon — submission draft

Track: **Every Second Counts** (DeFi where reaction time matters; Base Sepolia + Lasna)

## One-liner

StockGuard trips an on-chain circuit breaker for tokenized stocks on Base the moment their DEX price breaks away from NAV —
the Reactive contract is the only thing between the alert and the breaker. No keeper bot.

## Problem

Coinbase tokenized stocks on Base trade around the clock, but their Chainlink NAV only moves during US market hours.
Nights, weekends and thin pools let the DEX price drift. Protocols that accept these tokens (lending, vaults, agents)
need a "stop" signal that arrives in seconds and that they can read on-chain.

## How it works

1. The StockGuard worker compares NAV (Coinbase Tokenized Stocks API) with the deepest Base DEX pool every minute and
   confirms a ±2% gap on two consecutive checks.
2. It calls `StockGuardRegistry.reportMarket()` on Base Sepolia, which emits `DepegAlertEmitted`.
3. `DepegSentinelRSC` on Reactive Lasna is subscribed to that event. `react()` checks chain, emitter, topic and threshold,
   then requests a callback.
4. The Reactive callback proxy calls `triggerCircuitBreaker()` on the registry. The registry only accepts callbacks from
   the proxy **and** only when the proxy-injected sender is our own sentinel, so another RSC cannot trip it.
5. Any contract reads `isHealthy(asset)` before lending, minting or swapping.

## Why Reactive does real work here

Without Reactive, step 3–4 would be a server we run and you trust. With Reactive, the decision is a public contract and
the breaker trips even if our worker goes offline after reporting.

## Deployed contracts

| Contract | Chain | Address |
| --- | --- | --- |
| StockGuardRegistry | Base Sepolia (84532) | [`0xfBF0411b0F2b99680982e3dC69a83B5EF1fb44c4`](https://sepolia.basescan.org/address/0xfBF0411b0F2b99680982e3dC69a83B5EF1fb44c4) |
| DepegSentinelRSC | Reactive Lasna (5318007) | [`0xdF847EF0e8454362EaB6F5F4c2b0E235580739DE`](https://lasna.reactscan.net/address/0xdF847EF0e8454362EaB6F5F4c2b0E235580739DE) |

Both contracts are source-verified on Sourcify (Base Sepolia 84532, Lasna 5318007).

## Full loop transaction hashes (fire drill — synthetic price on testnet)

| Step | Tx |
| --- | --- |
| Origin: `reportMarket` → `DepegAlertEmitted` (Base Sepolia) | [`0xf91afac1…a3dc7`](https://sepolia.basescan.org/tx/0xf91afac1dcff5b7d80173462cb9ff8228113c45caf05f8d84d3df5cbdf0a3dc7) |
| Reactive: `react()` → `SentinelFired` + callback request (Lasna) | [`0x08418cdd…cb133`](https://lasna.reactscan.net/tx/0x08418cdddb59a1217e6f1098d0469755af2188c84b409c0aaf23b758ff9cb133) |
| Destination: `triggerCircuitBreaker` (Base Sepolia) | [`0x1cbec3e9…7611`](https://sepolia.basescan.org/tx/0x1cbec3e9c9bb58c150f2f309eeb5fc30e901bd9455dfe727c8ee6d763f6b7611) |
| Breaker cleared afterwards (`clearCircuitBreaker`) | [`0xefe27455…aa1f`](https://sepolia.basescan.org/tx/0xefe274559cfb52512ab9f094a9cb583ce4a2ba88f4a76dfbb607b9eb1076aa1f) |
| Measured latency | origin → breaker **1 s** (Base Sepolia block timestamps, 1-second resolution). The Lasna hop is shown by block, not seconds, because two chains' clocks are not comparable to the second. |

These come from `npm run drill -- --symbol AAPLc --bps 350` (also saved in `.data/drills.jsonl`). The DEX price in a drill is synthetic and labelled as such.

## Full loop on a real market event (live data, testnet breaker)

On 2026-11-23 17:43 UTC (US session) MSTRc's Base DEX price (Uniswap pool, $98.1k liquidity) was $87.26 against a NAV
of $85.20 (**+2.41%**), confirmed on two consecutive checks. No synthetic input: the same worker that posts the public
Telegram alerts reported it, the sentinel reacted, and the breaker tripped. Four minutes later the gap was back to +0.83%
and the breaker was cleared automatically.

| Step | Tx |
| --- | --- |
| Origin: `reportMarket` (+241 bps) → `DepegAlertEmitted` (Base Sepolia) | [`0x0469e2ea…60f6fb`](https://sepolia.basescan.org/tx/0x0469e2ea5ab6cd7eb9a69da23f3bf1773cc626cdcc54ef89b9d9fa74de60f6fb) |
| Reactive: `react()` → `SentinelFired` + callback request (Lasna, block 9,073,311) | [`0xef62524e…b5f732`](https://lasna.reactscan.net/tx/0xef62524eaa3bd45009f8de6c581425ee26567fe5eff61237a6bf83a920b5f732) |
| Destination: `triggerCircuitBreaker` (Base Sepolia) | [`0xb56ac62d…2daae4`](https://sepolia.basescan.org/tx/0xb56ac62ddf5ddf793b04caa221e645a9d613fe5bfcd5389124125d44922daae4) |
| Recovery report (+0.83%) | [`0x0995ebfb…8063d6`](https://sepolia.basescan.org/tx/0x0995ebfbba02d287d30ede59e70140b7383392a9aa09f46b27c4706dee8063d6) |
| Breaker auto-cleared (`AUTO_CLEAR_BREAKER=true`) | [`0x523042b2…f0063d`](https://sepolia.basescan.org/tx/0x523042b2978f0825c97d4ba703b2aaa0ac65d426930e78b13ab5dcd15ef0063d) |
| Observed latency | The worker saw the breaker active **about 4 s** after sending the report (worker clock). |

The Lasna transaction's log carries `chainId 84532`, emitter = our registry and topic1 = the MSTRc token address
(`0xb200…883d`), so it can be matched to the origin event by anyone. Matching alert and recovery messages are in the public
Telegram channel.

## Second real event, after the US close (live data, testnet breaker)

On 2026-11-24 02:26 UTC, after the US close, the NAV was frozen and MSTRc's Base DEX price drifted **+2.30%** above it
(peaking at +2.83% while the breaker was active). Same worker, same sentinel, no manual step. The gap closed to +0.79%
27 minutes later and the breaker was cleared automatically.

| Step | Tx |
| --- | --- |
| Origin: `reportMarket` (+230 bps) → `DepegAlertEmitted` (Base Sepolia) | [`0xd723b103…ade882`](https://sepolia.basescan.org/tx/0xd723b10399e1114dfcda40fe688762fcff9f7f2fa83b36b9f8c0008276ade882) |
| Reactive: `react()` → `SentinelFired` + callback request (Lasna, block 9,102,904) | [`0x45ba993e…9e3172b`](https://lasna.reactscan.net/tx/0x45ba993e7f5d4a661ba544d965a278e1fa66616137c9dca0f2c83601d9e3172b) |
| Destination: `triggerCircuitBreaker` (Base Sepolia) | [`0xfa64547b…68d424`](https://sepolia.basescan.org/tx/0xfa64547bc2969e8afb716523a4876f1de5151725891c7392358fef03fc68d424) |
| Recovery report (+0.79%) | [`0x2d9f1437…376e55`](https://sepolia.basescan.org/tx/0x2d9f14378f813c65a055e35eeef2791a72199e2ac0d8114fb7ac787cf2376e55) |
| Breaker auto-cleared | [`0xfdefc4b7…a30d74`](https://sepolia.basescan.org/tx/0xfdefc4b718ac417184a74e3e2db37fe06ec6c150745fd0d06f865aee28a30d74) |
| Observed latency | Breaker active **about 4 s** after the report (worker clock: 02:26:51.6 → 02:26:55.2 UTC). |

This is the case the project exists for: outside market hours the reference price cannot move, so only the DEX side can
drift, and an LP or lending protocol has no live NAV to fall back on.

## Tests

`cd contracts && forge test` — 33 tests, including an end-to-end test of report → react → callback → breaker, foreign-RSC
rejection, cooldown and callback-debt payment.

## Links

- Repo: https://github.com/kailog-dev/stockguard (public, MIT)
- Demo video (< 3 min): `TODO`
- Live board: https://stockguard.dev
