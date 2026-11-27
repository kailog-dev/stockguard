# Base Stocks Maxxing — submission draft

Recommended track: **Programmable Stock Markets** (the on-chain breaker any contract can read).
The x402 agent endpoint is the supporting "agentic" angle; mention it, don't switch tracks for it.

## X post (submission) — edit the numbers before posting

> Tokenized stocks on Base trade 24/7. Their NAV doesn't.
>
> StockGuard watches every Coinbase tokenized stock on Base, flags when the DEX price drifts from NAV, alerts on Telegram,
> and trips an on-chain circuit breaker via @0xReactive — no keeper bot.
>
> Live: https://stockguard.dev · Code: https://github.com/kailog-dev/stockguard
> Demo (2:26): https://youtu.be/do4QAVhfTRM
> <N> visitors / <N> alert subscribers in <N> days.
>
> @buildonbase #StocksMaxxing

## Links

- Live board: https://stockguard.dev
- Demo video (2:26): https://youtu.be/do4QAVhfTRM
- Code (MIT): https://github.com/kailog-dev/stockguard
- Alerts: https://t.me/stockguard_live
- Build log: https://x.com/kailog_dev

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
- Real alerts posted: 2 on MSTRc, both with on-chain breaker trip + auto-clear (Nov 23 +2.41%, Nov 24 +2.30% / peak +2.83%); tx links in `docs/SUBMISSION_REACTIVE.md`

**What is on-chain?**
StockGuardRegistry on Base Sepolia (`0xfBF0411b0F2b99680982e3dC69a83B5EF1fb44c4`), DepegSentinelRSC on Reactive Lasna
(`0xdF847EF0e8454362EaB6F5F4c2b0E235580739DE`), user attestations with a Base Builder Code (ERC-8021). Keeper
transactions carry no Builder Code.

**How does a protocol use it? (Programmable Stock Markets)**
One modifier. [`GuardedVault`](https://sepolia.basescan.org/address/0xe7F8abb356debAD44462fcf1e0B597C4CFFfDA06) on Base Sepolia accepts a tokenized stock as
collateral only while `isHealthy(asset)` is true, and fails closed if the registry cannot be read. Nov 27 drill on AAPLc
(synthetic depeg, labelled DRILL): deposit accepted [`0x1d601c26…d7c0`](https://sepolia.basescan.org/tx/0x1d601c26b8d38f878e8a24e32ef80cf7654d8d08915c4292d418cd21845ed7c0) → Reactive trips the breaker [`0x764362d5…de9f`](https://sepolia.basescan.org/tx/0x764362d56b3ff13c016005af0218b717fbd8f5f66b063fd54d696a663acede9f) →
deposit **refused** [`0x1646ef86…ea12`](https://sepolia.basescan.org/tx/0x1646ef86dfdcaf32bd5969e832de9a8548ad5f16fc678927f87ea7e109b3ea12) → real price reported and breaker cleared → deposit accepted [`0x42abfee0…13d0`](https://sepolia.basescan.org/tx/0x42abfee086124a7fd6bae4daffea956be27612ff20d6afe8a6e42aa3d37313d0).
Full table in `docs/SUBMISSION_REACTIVE.md`.

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
