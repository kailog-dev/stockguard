# Deploy (testnet) — about 30 minutes

Everything here is testnet: Base Sepolia and Reactive Lasna. No real money is involved.

## 0. Tools and a burner wallet

```bash
curl -L https://foundry.paradigm.xyz | bash && foundryup
cast wallet new                       # NEW burner key — write down address + private key
cast wallet import stockguard-deployer --interactive   # paste that key, set a password
```

Fund the burner address with:

- **Base Sepolia ETH** — Coinbase Developer Platform, Alchemy or QuickNode faucet. Collect about 0.1 ETH (a few days of drips).
- **Lasna lREACT** — send Base Sepolia ETH to the official Reactive faucet contract on Base Sepolia
  (`0x2afaFD298b23b62760711756088F75B7409f5967`, listed at dev.reactive.network/debugging). lREACT arrives at the
  **same address** on Lasna at roughly 100 lREACT per ETH. Never send more than 5 ETH in one transaction (the excess is lost).

```bash
cast send 0x2afaFD298b23b62760711756088F75B7409f5967 --value 0.04ether \
  --rpc-url https://sepolia.base.org --account stockguard-deployer      # ≈ 4 lREACT on Lasna
cast balance <BURNER_ADDRESS> --rpc-url https://lasna-rpc.rnk.dev/ --ether
```

Budget: each reaction costs roughly 0.03 lREACT (measured by other buildathon teams), so 3 lREACT covers ~100
reactions. Our sentinel only reacts to confirmed depeg alerts, not every price report.

Never use a wallet that holds real funds. The same burner is owner, reporter and deployer on testnet.

## 1. Test

```bash
cd contracts && forge test        # 33 tests must pass
```

## 2. Registry on Base Sepolia

The constructor argument is the Reactive callback proxy on Base Sepolia.

```bash
forge create src/StockGuardRegistry.sol:StockGuardRegistry \
  --rpc-url https://sepolia.base.org --account stockguard-deployer --broadcast \
  --constructor-args 0x476F44b11F5C942c58f4c8E3d0300E5710743585
```

Copy `Deployed to:` → `STOCKGUARD_REGISTRY_ADDRESS` (and `VITE_STOCKGUARD_REGISTRY_ADDRESS`) in `.env`.

Fund callback fees with `depositTo()` on the callback proxy — the method Reactive's docs call the most reliable,
because it settles any debt first and keeps the rest as reserves for the registry:

```bash
cast send 0x476F44b11F5C942c58f4c8E3d0300E5710743585 "depositTo(address)" <REGISTRY> \
  --value 0.01ether --rpc-url https://sepolia.base.org --account stockguard-deployer
```

Verify the source on Sourcify (shows "verified" on the explorers judges open):

```bash
forge verify-contract --verifier sourcify --chain-id 84532 <REGISTRY> src/StockGuardRegistry.sol:StockGuardRegistry
```

## 3. Sentinel on Reactive Lasna

Arguments: origin chain 84532, destination chain 84532, registry address, trigger 200 bps. `--value 3ether` sends
3 lREACT with the deployment to pay for reactions (0.5 would run dry after ~15 reactions, and a sentinel in debt
stops silently).

```bash
forge create src/DepegSentinelRSC.sol:DepegSentinelRSC \
  --rpc-url https://lasna-rpc.rnk.dev/ --account stockguard-deployer --broadcast \
  --value 3ether \
  --constructor-args 84532 84532 <REGISTRY> 200

forge verify-contract --verifier sourcify --chain-id 5318007 <SENTINEL> src/DepegSentinelRSC.sol:DepegSentinelRSC
```

Copy the address → `STOCKGUARD_RSC_ADDRESS` in `.env`.

The sentinel requests 1,000,000 callback gas by default. Reactive ignores requests under 100,000 and the proxy
withholds part of the gas for its own accounting; our breaker itself uses well under 100,000 (EndToEndLoop.t.sol).
If a callback ever shows `CallbackFailure`, raise it without redeploying:

```bash
cast send <SENTINEL> "setCallbackGasLimit(uint64)" 1500000 --rpc-url https://lasna-rpc.rnk.dev/ --account stockguard-deployer
```

## 4. Wire it up

Put the burner private key in `.env` as `REPORTER_PRIVATE_KEY` (testnet only), then:

```bash
npm run onchain:setup      # setReporter + setReactiveSender, prints status
npm run onchain:status     # balances, debt and reserves on Lasna and Base Sepolia — run daily until the deadline
```

## 5. Fire drill (gives you the three transaction hashes the Reactive buildathon asks for)

```bash
npm run worker:once                          # makes sure the board has fresh NAVs
npm run drill -- --symbol AAPLc --bps 350     # origin → Lasna reaction → callback, with latency in seconds
```

The drill refuses to run if either side is in debt, prints all three explorer links plus the measured latency
(from block timestamps), and appends the result to `.data/drills.jsonl` for the submission.

If no callback arrives within 5 minutes: `npm run onchain:status` first, then check that `reactiveSender` equals
the sentinel address (`npm run onchain:setup` prints it).

Clear the breaker after the drill with `npm run drill -- --symbol AAPLc --bps 350 --clear` next time, or:

```bash
cast send <REGISTRY> "clearCircuitBreaker(address)" <ASSET> --rpc-url https://sepolia.base.org --account stockguard-deployer
```

## 6. Public hosting (needed for traction)

One small VPS (the Vultr box you already use is fine):

```bash
git clone <your public repo> && cd stockguard && npm ci
cp .env.example .env && nano .env            # fill in
npm run build:web
# run worker and API with pm2 so they survive restarts
npm i -g pm2
pm2 start "npm run worker" --name sg-worker
pm2 start "npm run start -w @stockguard/api" --name sg-api
pm2 save
```

Serve `apps/web/dist` with nginx or Caddy and proxy `/api` to `localhost:8787`. With Caddy:

```
stockguard.example {
  handle /api/* { reverse_proxy localhost:8787 }
  handle { root * /root/stockguard/apps/web/dist
           file_server }
}
```

Set `CORS_ORIGINS` and `PUBLIC_APP_URL` to the public URL.
