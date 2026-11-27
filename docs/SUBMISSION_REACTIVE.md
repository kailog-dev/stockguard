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
| GuardedVault (example consumer) | Base Sepolia (84532) | [`0xe7F8abb356debAD44462fcf1e0B597C4CFFfDA06`](https://sepolia.basescan.org/address/0xe7F8abb356debAD44462fcf1e0B597C4CFFfDA06) |

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

## The breaker stops money at a consumer contract (GuardedVault, Nov 27 drill)

[`GuardedVault`](https://sepolia.basescan.org/address/0xe7F8abb356debAD44462fcf1e0B597C4CFFfDA06) is an example lending-style consumer on Base Sepolia
(deploy tx [`0x2bb81f2a…5952`](https://sepolia.basescan.org/tx/0x2bb81f2ac2bf1129cda04ae01a10bff9d80fe60550960e39493aa0b6df765952)). Its whole
integration is one modifier that calls `isHealthy(asset)` on the registry, and it fails closed if the registry cannot be
read. The drill below ran end to end on AAPLc: accepted → refused → accepted. The depeg in step B is **synthetic (DRILL)**;
GuardedVault only keeps a ledger, no tokens move.

| Step | Event | Tx |
| --- | --- | --- |
| A. `tryDepositCollateral` while healthy | CollateralAccepted | [`0x1d601c26…d7c0`](https://sepolia.basescan.org/tx/0x1d601c26b8d38f878e8a24e32ef80cf7654d8d08915c4292d418cd21845ed7c0) |
| B. DRILL `reportMarket` (synthetic −3.50%) | DepegAlertEmitted | [`0x19cae295…8524`](https://sepolia.basescan.org/tx/0x19cae29546d7bfebbf574c63233739bafcaeade949b4778eaa47a3af9b038524) |
| B. Reactive callback `triggerCircuitBreaker` | CircuitBreakerTriggered | [`0x764362d5…de9f`](https://sepolia.basescan.org/tx/0x764362d56b3ff13c016005af0218b717fbd8f5f66b063fd54d696a663acede9f) |
| C. `tryDepositCollateral` while the breaker is on | **CollateralRefused** | [`0x1646ef86…ea12`](https://sepolia.basescan.org/tx/0x1646ef86dfdcaf32bd5969e832de9a8548ad5f16fc678927f87ea7e109b3ea12) |
| D. Real-price `reportMarket` (grade back to A) | MarketReported | [`0x87508f9e…ae93`](https://sepolia.basescan.org/tx/0x87508f9eb5da6b5ee0b8918aceb6f73af3bdc67fd6b1c74d1b1dc12dbf19ae93) |
| D. `clearCircuitBreaker` (owner) | CircuitBreakerCleared | [`0xb3ef089c…3ff9`](https://sepolia.basescan.org/tx/0xb3ef089cba3582554af86c6febc8524dd1b73ff0249859c03222edcbe4c03ff9) |
| D. `tryDepositCollateral` after clear | CollateralAccepted | [`0x42abfee0…13d0`](https://sepolia.basescan.org/tx/0x42abfee086124a7fd6bae4daffea956be27612ff20d6afe8a6e42aa3d37313d0) |

Reproduce: `cd apps/worker && npx tsx --env-file-if-exists=../../.env src/vault-drill.ts --vault 0xe7F8abb356debAD44462fcf1e0B597C4CFFfDA06 --symbol AAPLc --bps 350`
(results in `.data/vault-drills.jsonl`).

## Tests

`cd contracts && forge test` — 38 tests, including an end-to-end test of report → react → callback → breaker, foreign-RSC
rejection, cooldown, callback-debt payment, and GuardedVault (accepts when healthy, refuses when tripped, fails closed
when the registry cannot be read).

## Links

- Repo: https://github.com/kailog-dev/stockguard (public, MIT)
- Demo video (2:26): https://youtu.be/do4QAVhfTRM
- Live board: https://stockguard.dev
