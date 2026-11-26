/**
 * StockGuard XL — find tokenized-stock pools on Uniswap v3 (X Layer, chain 196).
 *
 * The deep xStocks liquidity on X Layer sits on Uniswap v3, not v4. GeckoTerminal is used only as a
 * phone book (which pool addresses exist); every pool is then verified on X Layer itself before it is
 * kept:
 *   1. pool.factory() is the official Uniswap v3 factory on X Layer
 *   2. factory.getPool(token0, token1, fee) returns this same address (so it is not a look-alike contract)
 *   3. token symbol / name / decimals are read from the token contracts, not from the listing
 *
 *   npx tsx apps/worker/src/xl/discover-v3.ts            # writes .data/xl-v3-pools.json
 *   npx tsx apps/worker/src/xl/discover-v3.ts --pages 5  # search more result pages
 *
 * Read-only: no key, no transactions.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createPublicClient, defineChain, getAddress, http, parseAbi, type Address } from 'viem';
import { tickerOf } from './metrics.js';

const RPC = process.env.XLAYER_RPC_URL || 'https://rpc.xlayer.tech';
// Official Uniswap v3 deployment on X Layer (developers.uniswap.org/docs/protocols/v3/deployments/v3-xlayer-deployments)
export const V3_FACTORY: Address = '0x4B2ab38DBF28D31D467aA8993f6c2585981D6804';

const here = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = process.env.STOCKGUARD_DATA_DIR ? resolve(process.env.STOCKGUARD_DATA_DIR) : resolve(here, '../../../../.data');
const OUT_FILE = resolve(DATA_DIR, 'xl-v3-pools.json');

const xLayer = defineChain({
  id: 196,
  name: 'X Layer',
  nativeCurrency: { name: 'OKB', symbol: 'OKB', decimals: 18 },
  rpcUrls: { default: { http: [RPC] } },
});
const client = createPublicClient({ chain: xLayer, transport: http(RPC, { timeout: 30_000, retryCount: 6, retryDelay: 2_000 }) });
const poolAbi = parseAbi([
  'function factory() view returns (address)',
  'function token0() view returns (address)',
  'function token1() view returns (address)',
  'function fee() view returns (uint24)',
]);
const factoryAbi = parseAbi(['function getPool(address, address, uint24) view returns (address)']);
const erc20 = parseAbi([
  'function symbol() view returns (string)',
  'function name() view returns (string)',
  'function decimals() view returns (uint8)',
]);

type Tok = { address: Address; symbol: string; name: string; decimals: number };
export type V3PoolRow = {
  pool: Address;
  token0: Tok;
  token1: Tok;
  fee: number;
  listing: { liquidityUsd: number; volume24hUsd: number; name: string };
};

/** Stock tokens on X Layer are xStocks ("AAPLx") or their wrapped form ("wAAPLx"). */
export function isStockToken(t: { symbol: string; name: string }): boolean {
  return !!tickerOf(t.symbol) && (/xStock/i.test(t.name) || /^w[A-Z.]+x$/.test(t.symbol));
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function listingCandidates(pages: number) {
  const seen = new Map<string, { liquidityUsd: number; volume24hUsd: number; name: string }>();
  for (let page = 1; page <= pages; page++) {
    const url = `https://api.geckoterminal.com/api/v2/search/pools?query=xstock&network=x-layer&page=${page}`;
    try {
      const res = await fetch(url, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(20_000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const j = (await res.json()) as { data?: any[] };
      if (!j.data?.length) break;
      for (const p of j.data) {
        if (p.relationships?.dex?.data?.id !== 'uniswap-v3-x-layer') continue;
        const a = p.attributes;
        seen.set(String(a.address).toLowerCase(), {
          liquidityUsd: Math.round(Number(a.reserve_in_usd) || 0),
          volume24hUsd: Math.round(Number(a.volume_usd?.h24) || 0),
          name: String(a.name),
        });
      }
    } catch (e) {
      console.warn(`[xl-v3] listing page ${page} failed:`, e instanceof Error ? e.message : e);
    }
    await sleep(2_500); // GeckoTerminal free tier: ~30 requests / minute
  }
  return seen;
}

const tokenCache = new Map<string, Tok>();
async function token(address: Address): Promise<Tok> {
  const k = address.toLowerCase();
  const hit = tokenCache.get(k);
  if (hit) return hit;
  const [symbol, name, decimals] = await Promise.all([
    client.readContract({ address, abi: erc20, functionName: 'symbol' }),
    client.readContract({ address, abi: erc20, functionName: 'name' }),
    client.readContract({ address, abi: erc20, functionName: 'decimals' }),
  ]);
  const t = { address: getAddress(address), symbol, name, decimals: Number(decimals) };
  tokenCache.set(k, t);
  return t;
}

async function verify(pool: Address): Promise<{ ok: true; row: Omit<V3PoolRow, 'listing'> } | { ok: false; why: string }> {
  const [factory, t0, t1, fee] = await Promise.all([
    client.readContract({ address: pool, abi: poolAbi, functionName: 'factory' }),
    client.readContract({ address: pool, abi: poolAbi, functionName: 'token0' }),
    client.readContract({ address: pool, abi: poolAbi, functionName: 'token1' }),
    client.readContract({ address: pool, abi: poolAbi, functionName: 'fee' }),
  ]);
  if (factory.toLowerCase() !== V3_FACTORY.toLowerCase()) return { ok: false, why: `factory ${factory} is not the official v3 factory` };
  const canonical = await client.readContract({ address: V3_FACTORY, abi: factoryAbi, functionName: 'getPool', args: [t0, t1, fee] });
  if (canonical.toLowerCase() !== pool.toLowerCase()) return { ok: false, why: `factory.getPool returns ${canonical}, not this pool` };
  const [token0, token1] = [await token(t0), await token(t1)];
  if (!isStockToken(token0) && !isStockToken(token1)) return { ok: false, why: `no stock token (${token0.symbol}/${token1.symbol})` };
  return { ok: true, row: { pool: getAddress(pool), token0, token1, fee: Number(fee) } };
}

async function main() {
  const i = process.argv.indexOf('--pages');
  const pages = i > 0 ? Math.max(1, Number(process.argv[i + 1]) || 3) : 3;
  const candidates = await listingCandidates(pages);
  console.log(`[xl-v3] ${candidates.size} Uniswap v3 candidates from the listing (${pages} pages)`);

  const pools: V3PoolRow[] = [];
  const rejected: { pool: string; why: string }[] = [];
  for (const [addr, listing] of candidates) {
    try {
      const v = await verify(getAddress(addr));
      if (v.ok) pools.push({ ...v.row, listing });
      else rejected.push({ pool: addr, why: v.why });
    } catch (e) {
      rejected.push({ pool: addr, why: `read failed: ${e instanceof Error ? e.message.split('\n')[0] : e}` });
    }
  }
  pools.sort((a, b) => b.listing.liquidityUsd - a.listing.liquidityUsd);

  mkdirSync(DATA_DIR, { recursive: true });
  writeFileSync(OUT_FILE, JSON.stringify({ version: 1, generatedAt: Date.now(), chainId: 196, factory: V3_FACTORY, pools, rejected }, null, 2));

  console.log(`[xl-v3] verified on-chain: ${pools.length} · rejected: ${rejected.length}`);
  for (const p of pools)
    console.log(
      `  ✓ ${`${p.token0.symbol}/${p.token1.symbol}`.padEnd(18)} fee ${(p.fee / 10_000).toFixed(2)}%  listed liq $${String(p.listing.liquidityUsd).padEnd(9)} ${p.pool}`,
    );
  for (const r of rejected) console.log(`  ✗ ${r.pool} — ${r.why}`);
  console.log(`[xl-v3] saved ${OUT_FILE}`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
