# Base Stocks Maxxing — submission draft

Recommended track: **Programmable Stock Markets** (the on-chain breaker any contract can read).
The x402 agent endpoint is the supporting "agentic" angle; mention it, don't switch tracks for it.

## X post (submission) — edit the numbers before posting

> Tokenized stocks on Base trade 24/7. Their NAV doesn't.
>
> StockGuard watches every Coinbase tokenized stock on Base, flags when the DEX price drifts from NAV, alerts on Telegram,
> and trips an on-chain circuit breaker via @0xReactive — no keeper bot.
>
> Live: <URL> · Code: <repo>
> <N> visitors / <N> alert subscribers in <N> days.
>
> @buildonbase #StocksMaxxing

## Form answers

**What does it do?**
A live integrity monitor for Coinbase tokenized stocks on Base: NAV vs deepest DEX pool, premium/discount, liquidity and
plain-English risk notes; depeg alerts on Telegram; an on-chain breaker (`isHealthy(asset)`) other contracts can read;
a pay-per-call x402 endpoint for agents; and an "is this the official token?" checker.

**Who is it for?**
Non-US holders of tokenized stocks, protocols that accept them as collateral, and trading agents that need a
pre-trade sanity check.

**Traction** (fill from `.data/usage/*.json`, Telegram member count, x402 receipts)
- Daily unique visitors: …
- Telegram channel members: …
- Paid agent calls (x402): …
- Real alerts posted: … (link each)

**What is on-chain?**
StockGuardRegistry on Base Sepolia (address), DepegSentinelRSC on Reactive Lasna (address), user attestations with a
Base Builder Code (ERC-8021). Keeper transactions carry no Builder Code.

**Compliance**
StockGuard is read-only. It does not offer trading, routing or quotes for execution, and it states on every page and
alert that tokenized stocks are not offered to US persons.

## Build in public — daily post ideas (25% of the score)

1. Day 1: "Building a NAV-vs-DEX monitor for Base tokenized stocks" + board screenshot.
2. Which stocks have no Base pool at all (data from the board).
3. Weekend observation: how far DEX prices drift while NAV is frozen (sparkline screenshot).
4. Why we don't alert on multiplier ≠ 1 tokens (honesty thread).
5. The Reactive fire drill: three tx links, 20-second screen recording.
6. First real alert (or "zero alerts this week — here's why that's good").
7. x402: an agent paying $0.001 for a check, with the receipt.
8. Numbers update: visitors, subscribers, alerts.
Keep every post factual. Never present a drill as a real depeg.
