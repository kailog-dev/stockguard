/**
 * StockGuard XL — step 1: find tokenized-stock pools on X Layer (chain 196).
 *
 * Read-only. Scans Uniswap v4 PoolManager `Initialize` events on X Layer mainnet,
 * reads both currencies (symbol/name/decimals) and the current pool price from StateView,
 * flags pools whose tokens look like the OKXICE launch stocks, and writes
 * .data/xl-pools.json.
 *
 *   npx tsx apps/worker/src/xl/discover.ts                                  # Nov 19-24 (OKXICE launch window)
 *   npx tsx apps/worker/src/xl/discover.ts --from 2026-11-01 --to 2026-11-25 --concurrency 6
 *
 * No private key, no transactions.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createPublicClient, defineChain, http, parseAbi, parseAbiItem, type Address, type Hex } from 'viem';

const RPC = process.env.XLAYER_RPC_URL || 'https://rpc.xlayer.tech';
// Official Uniswap v4 deployment on X Layer (developers.uniswap.org/docs/protocols/v4/deployments)
const POOL_MANAGER: Address = '0x360e68faccca8ca495c1b759fd9eee466db9fb32';
const STATE_VIEW: Address = '0x76fd297e2d437cd7f76d50f01afe6160f86e9990';
// OKXICE launch roster (Nov 20, 2026 public notice)
const WATCH = ['MSTR', 'COIN', 'HOOD', 'CRCL', 'BTGO', 'SECZ'];

const xLayer = defineChain({
  id: 196,
  name: 'X Layer',
  nativeCurrency: { name: 'OKB', symbol: 'OKB', decimals: 18 },
  rpcUrls: { default: { http: [RPC] } },
});
const client = createPublicClient({ chain: xLayer, transport: http(RPC, { timeout: 30_000, retryCount: 2 }) });

const initializeEvent = parseAbiItem(
  'event Initialize(bytes32 indexed id, address indexed currency0, address indexed currency1, uint24 fee, int24 tickSpacing, address hooks, uint160 sqrtPriceX96, int24 tick)',
);
const erc20 = parseAbi([
  'function symbol() view returns (string)',
  'function name() view returns (string)',
  'function decimals() view returns (uint8)',
]);
const stateView = parseAbi([
  'function getSlot0(bytes32 poolId) view returns (uint160 sqrtPriceX96, int24 tick, uint24 protocolFee, uint24 lpFee)',
  'function getLiquidity(bytes32 poolId) view returns (uint128 liquidity)',
]);

type TokenInfo = { address: Address; symbol: string; name: string; decimals: number };
const tokenCache = new Map<string, TokenInfo>();

async function token(address: Address): Promise<TokenInfo> {
  const key = address.toLowerCase();
  const hit = tokenCache.get(key);
  if (hit) return hit;
  let info: TokenInfo;
  if (BigInt(address) === 0n) {
    info = { address, symbol: 'OKB', name: 'OKB (native)', decimals: 18 };
  } else {
    const read = async <T>(fn: 'symbol' | 'name' | 'decimals', fallback: T): Promise<T> => {
      try {
        return (await client.readContract({ address, abi: erc20, functionName: fn })) as T;
      } catch {
        return fallback;
      }
    };
    info = {
      address,
      symbol: await read('symbol', '?'),
      name: await read('name', '?'),
      decimals: Number(await read('decimals', 18)),
    };
  }
  tokenCache.set(key, info);
  return info;
}

/** price of currency0 in units of currency1 */
function priceFromSqrt(sqrtPriceX96: bigint, dec0: number, dec1: number): number {
  const r = Number(sqrtPriceX96) / 2 ** 96;
  return r * r * 10 ** (dec0 - dec1);
}

/** first block at or after a unix timestamp (binary search on block timestamps) */
async function blockAt(ts: number, lo: bigint, hi: bigint): Promise<bigint> {
  while (lo < hi) {
    const mid = (lo + hi) / 2n;
    const b = await client.getBlock({ blockNumber: mid });
    if (Number(b.timestamp) < ts) lo = mid + 1n;
    else hi = mid;
  }
  return lo;
}

function argValue(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i > 0 ? process.argv[i + 1] : undefined;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * X Layer's public RPC allows at most 100 blocks per eth_getLogs, so the window is split into
 * 100-block chunks and fetched with limited concurrency and retry/backoff.
 */
async function scanLogs(from: bigint, to: bigint, concurrency: number) {
  const STEP = 100n;
  const chunks: [bigint, bigint][] = [];
  for (let a = from; a <= to; a += STEP) chunks.push([a, a + STEP - 1n > to ? to : a + STEP - 1n]);
  const results: Awaited<ReturnType<typeof fetchChunk>>[] = new Array(chunks.length);
  async function fetchChunk(a: bigint, b: bigint) {
    return client.getLogs({ address: POOL_MANAGER, event: initializeEvent, fromBlock: a, toBlock: b });
  }
  let next = 0;
  let done = 0;
  let found = 0;
  const t0 = Date.now();
  async function worker() {
    while (next < chunks.length) {
      const i = next++;
      const [a, b] = chunks[i];
      for (let attempt = 0; ; attempt++) {
        try {
          results[i] = await fetchChunk(a, b);
          found += results[i].length;
          break;
        } catch (e) {
          if (attempt >= 6) throw e;
          await sleep(500 * 2 ** attempt); // rate limit / transient error
        }
      }
      done++;
      if (done % 50 === 0 || done === chunks.length) {
        const secs = (Date.now() - t0) / 1000;
        const eta = (secs / done) * (chunks.length - done);
        process.stdout.write(`\r  ${done}/${chunks.length} chunks, ${found} pools, ~${Math.ceil(eta)}s left   `);
      }
    }
  }
  await Promise.all(Array.from({ length: concurrency }, worker));
  process.stdout.write('\n');
  return results.flat();
}

function looksLikeStock(t: TokenInfo): string | null {
  const hay = `${t.symbol} ${t.name}`.toUpperCase();
  return WATCH.find((s) => new RegExp(`(^|[^A-Z])${s}`).test(hay)) ?? null;
}

async function main() {
  // OKXICE launch notice: Nov 20, 2026; trading opened Nov 23 (noon ET). Pools were created in between.
  const fromDate = argValue('--from') ?? '2026-11-19';
  const toDate = argValue('--to') ?? '2026-11-24';
  const concurrency = Number(argValue('--concurrency') ?? 8);
  console.log(`X Layer RPC: ${RPC}`);
  const chainId = await client.getChainId();
  if (chainId !== 196) throw new Error(`expected chain 196, got ${chainId}`);
  const code = await client.getCode({ address: POOL_MANAGER });
  if (!code || code === '0x') throw new Error('no PoolManager bytecode at the expected address');

  const latest = await client.getBlock();
  const fromTs = Date.parse(`${fromDate}T00:00:00Z`) / 1000;
  const toTs = Math.min(Date.parse(`${toDate}T23:59:59Z`) / 1000, Number(latest.timestamp));
  const from = await blockAt(fromTs, 0n, latest.number);
  const to = (await blockAt(toTs, from, latest.number)) || latest.number;
  console.log(`Scanning Initialize events ${fromDate} .. ${toDate} UTC: blocks ${from}..${to} (${to - from + 1n} blocks, 100 per request, x${concurrency})`);
  const logs = await scanLogs(from, to, concurrency);
  const days = `${fromDate}..${toDate}`;

  const pools = [];
  for (const log of logs) {
    const a = log.args;
    const t0 = await token(a.currency0 as Address);
    const t1 = await token(a.currency1 as Address);
    const stock = looksLikeStock(t0) ?? looksLikeStock(t1);
    let price: number | null = null;
    let liquidity: string | null = null;
    try {
      const [sqrtP] = await client.readContract({ address: STATE_VIEW, abi: stateView, functionName: 'getSlot0', args: [a.id as Hex] });
      price = priceFromSqrt(sqrtP, t0.decimals, t1.decimals);
      liquidity = String(await client.readContract({ address: STATE_VIEW, abi: stateView, functionName: 'getLiquidity', args: [a.id as Hex] }));
    } catch {
      /* pool unreadable — keep the row anyway */
    }
    pools.push({
      poolId: a.id,
      block: String(log.blockNumber),
      tx: log.transactionHash,
      fee: a.fee,
      tickSpacing: a.tickSpacing,
      hooks: a.hooks,
      currency0: t0,
      currency1: t1,
      price0in1: price,
      liquidity,
      stockMatch: stock,
    });
  }

  const matches = pools.filter((p) => p.stockMatch);
  console.log(`\n${pools.length} pools initialized in window, ${matches.length} look like OKXICE stocks:\n`);
  for (const p of matches) {
    const px = p.price0in1 === null ? 'n/a' : p.price0in1.toPrecision(6);
    console.log(
      `${p.stockMatch?.padEnd(5)} ${p.currency0.symbol}/${p.currency1.symbol}  price(0 in 1)=${px}  liq=${p.liquidity}  hooks=${p.hooks}\n` +
        `      poolId=${p.poolId}\n      ${p.currency0.symbol} ${p.currency0.address} (${p.currency0.name})\n      ${p.currency1.symbol} ${p.currency1.address} (${p.currency1.name})`,
    );
  }
  if (!matches.length) {
    console.log('No name match. All pools in window (symbol0/symbol1):');
    for (const p of pools) console.log(`  ${p.currency0.symbol}/${p.currency1.symbol}  ${p.poolId}  hooks=${p.hooks}`);
  }

  const here = dirname(fileURLToPath(import.meta.url));
  const outFile = resolve(here, '../../../../.data/xl-pools.json');
  mkdirSync(dirname(outFile), { recursive: true });
  writeFileSync(
    outFile,
    JSON.stringify({ scannedAt: new Date().toISOString(), chainId, poolManager: POOL_MANAGER, stateView: STATE_VIEW, days, pools }, null, 2),
  );
  console.log(`\nSaved ${pools.length} pools to ${outFile}`);
}

main().catch((e) => {
  console.error('\nFAILED:', e instanceof Error ? e.message : e);
  process.exit(1);
});
