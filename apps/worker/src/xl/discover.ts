/**
 * StockGuard XL — step 1: find tokenized-stock pools on X Layer (chain 196).
 *
 * Read-only. Scans Uniswap v4 PoolManager `Initialize` events on X Layer mainnet,
 * reads both currencies (symbol/name/decimals) and the current pool price from StateView,
 * flags pools whose tokens look like the OKXICE launch stocks, and writes
 * .data/xl-pools.json.
 *
 *   npx tsx apps/worker/src/xl/discover.ts            # pools created in the last 10 days
 *   npx tsx apps/worker/src/xl/discover.ts --days 60  # wider window
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

async function findStartBlock(days: number): Promise<{ from: bigint; to: bigint; secsPerBlock: number }> {
  const latest = await client.getBlock();
  const probeBack = 200_000n;
  const older = await client.getBlock({ blockNumber: latest.number > probeBack ? latest.number - probeBack : 0n });
  const secsPerBlock = Number(latest.timestamp - older.timestamp) / Number(latest.number - older.number || 1n);
  const blocksBack = BigInt(Math.ceil((days * 86_400) / Math.max(secsPerBlock, 0.1)));
  const from = latest.number > blocksBack ? latest.number - blocksBack : 0n;
  return { from, to: latest.number, secsPerBlock };
}

async function scanLogs(from: bigint, to: bigint) {
  const out: Awaited<ReturnType<typeof getChunk>> = [];
  let step = 50_000n;
  let cursor = from;
  async function getChunk(a: bigint, b: bigint) {
    return client.getLogs({ address: POOL_MANAGER, event: initializeEvent, fromBlock: a, toBlock: b });
  }
  while (cursor <= to) {
    const end = cursor + step - 1n > to ? to : cursor + step - 1n;
    try {
      const logs = await getChunk(cursor, end);
      out.push(...logs);
      process.stdout.write(`\r  scanned up to block ${end} (${out.length} pools)   `);
      cursor = end + 1n;
    } catch (e) {
      if (step <= 500n) throw e;
      step /= 2n; // RPC range limit — retry smaller
    }
  }
  process.stdout.write('\n');
  return out;
}

function looksLikeStock(t: TokenInfo): string | null {
  const hay = `${t.symbol} ${t.name}`.toUpperCase();
  return WATCH.find((s) => new RegExp(`(^|[^A-Z])${s}`).test(hay)) ?? null;
}

async function main() {
  const daysArg = process.argv.indexOf('--days');
  const days = daysArg > 0 ? Number(process.argv[daysArg + 1]) : 10;
  console.log(`X Layer RPC: ${RPC}`);
  const chainId = await client.getChainId();
  if (chainId !== 196) throw new Error(`expected chain 196, got ${chainId}`);
  const code = await client.getCode({ address: POOL_MANAGER });
  if (!code || code === '0x') throw new Error('no PoolManager bytecode at the expected address');

  const { from, to, secsPerBlock } = await findStartBlock(days);
  console.log(`Scanning Initialize events, last ${days} days: blocks ${from}..${to} (~${secsPerBlock.toFixed(2)} s/block)`);
  const logs = await scanLogs(from, to);

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
