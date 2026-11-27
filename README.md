# StockGuard

**Is your tokenized stock trading at its real price?**

**Live board:** https://stockguard.dev · **Demo (2:51):** https://youtu.be/vCOzmeiQNus · **Alerts:** https://t.me/stockguard_live

Coinbase tokenized stocks on Base trade 24/7 on DEXs, but their reference value (NAV) comes from a Chainlink feed that
only moves while the US market is open. Outside those hours, on thin pools, or during corporate actions, the DEX price can
drift away from what the token is actually worth. Holders and trading agents usually can't see that gap.

StockGuard watches every official tokenized stock on Base and shows, live:

- **NAV vs DEX board** — the Chainlink-based NAV from the Coinbase Tokenized Stocks API next to the deepest Base DEX pool
  price, the premium/discount, pool liquidity and plain-English risk notes.
- **Depeg alerts** — a gap of ±2% confirmed on two consecutive checks posts to a public Telegram channel, and posts again
  when the price is back within 1%. Thin pools, stale NAV and tokens with a non-1 multiplier never raise alerts, so the
  channel stays trustworthy.
- **An on-chain circuit breaker with no keeper bot** — a confirmed depeg is reported to `StockGuardRegistry` on Base
  Sepolia. `DepegSentinelRSC`, a Reactive Network contract on Lasna, sees the event and calls `triggerCircuitBreaker()`
  back on Base. Any contract can read `isHealthy(asset)` before acting.
- **A pay-per-check API for agents (x402)** — `GET /api/agent/risk?symbol=AAPLc`, settled per call in USDC. No API key,
  no account.
- **Token checker** — paste an address and see whether it is in the official Coinbase list.

StockGuard is read-only. It does not trade, quote for execution, route orders or hold funds.

## Architecture

```
Coinbase Tokenized Stocks API ─┐
                               ├─▶ apps/worker ──▶ .data/board.json ──▶ apps/api ──▶ apps/web
DexScreener (Base pools) ──────┘        │                                    └──▶ x402 agents
                                        ├─▶ Telegram channel
                                        └─▶ reportMarket()  Base Sepolia: StockGuardRegistry
                                                   │ DepegAlertEmitted
                                                   ▼
                                          Reactive Lasna: DepegSentinelRSC.react()
                                                   │ callback
                                                   ▼
                                          triggerCircuitBreaker()  Base Sepolia
```

| Path | What it is |
| --- | --- |
| `contracts/` | Foundry project: `StockGuardRegistry.sol`, `DepegSentinelRSC.sol`, 33 tests incl. an end-to-end loop test |
| `packages/core` | Risk engine (integer math identical to Solidity), board builder, alert state machine, data sources, file store, hash-chained audit log |
| `apps/worker` | Polls, builds the board, sends alerts, mirrors confirmed depegs on-chain; `setup` and `drill` commands |
| `apps/api` | Hono API (board, asset detail, history, token checker, on-chain log, x402 agent endpoint) |
| `apps/web` | React board |

## Run it

Requirements: Node 20+ (Node 22 recommended). Foundry only for the contracts.

```bash
npm install
cp .env.example .env      # optional — everything runs with an empty .env
npm run dev               # worker + API (:8787) + web (:5173) in one terminal
```

Open http://localhost:5173. The first board appears after the first poll (a few seconds).

Other commands:

```bash
npm run worker:once       # one poll, prints the top rows — quickest way to check the data sources
npm test                  # core + worker unit tests
npm run test:contracts    # forge test
npm run typecheck
npm run build:web
npm run onchain:setup     # after deploying contracts (docs/DEPLOY.md)
npm run drill -- --symbol AAPLc --bps 350   # testnet fire drill of the full Reactive loop
```

## Data honesty rules

- Contract addresses and NAVs come only from the Coinbase Tokenized Stocks API. Nothing is hard-coded.
- A missing DEX quote is shown as "no Base pool", never filled in.
- The Coinbase docs do not say whether `nav_price` is per token or per underlying share. When a token's multiplier is not 1,
  the row is flagged `NAV_BASIS_UNVERIFIED` and does not alert.
- Drills are synthetic prices on testnet. They are labelled `DRILL` everywhere and are never presented as market events.
- Keeper transactions carry no Base Builder Code; only user-signed attestations do. We do not farm our own traction.
- Tokenized stocks are not offered to US persons. StockGuard shows market data only.

## License

MIT
