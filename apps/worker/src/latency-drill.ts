/**
 * Latency drill series on Base Sepolia (testnet, no real money). Runs the full Reactive loop N times and
 * prints a stats table for docs/SUBMISSION_REACTIVE.md:
 *
 *   each round:  healthy check (restore if needed)
 *                → DRILL reportMarket (synthetic −bps)          Base Sepolia  (origin)
 *                → DepegSentinelRSC.react                       Reactive Lasna
 *                → triggerCircuitBreaker callback               Base Sepolia  (destination)
 *                → real-price HEARTBEAT report + owner clear    (back to grade A/B before the next round)
 *
 *   cd apps/worker && npx tsx --env-file-if-exists=../../.env src/latency-drill.ts --symbol AAPLc --bps 350 --rounds 5 --gap 60
 *
 * Two latency figures per round, both honest about their resolution:
 *   - chain:  Base Sepolia block timestamps, origin block → callback block (1 s resolution, plus block count)
 *   - wall:   our own stopwatch, origin receipt seen → breaker seen on-chain (polled every 1 s, so ±1 s)
 * The Lasna hop is reported by block number only: two chains' clocks are not comparable to the second.
 *
 * Always a DRILL: every synthetic report is logged as kind "DRILL". Rounds are appended to
 * .data/drills.jsonl (same format as `npm run drill`, plus wallSec and series) and the table is written to
 * .data/latency-stats.md.
 */
import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createPublicClient, http, parseAbi } from 'viem';
import { baseSepolia } from 'viem/chains';
import { BASE_SEPOLIA_ID, REACTIVE_LASNA_ID, dataDir, readBoard, txUrl } from '@stockguard/core';
import { loadConfig } from './config.js';
import { createMirror } from './onchain.js';
import { createReactiveReader } from './reactive.js';

const GUARD_ABI = parseAbi(['function isHealthy(address asset) view returns (bool)']);

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const short = (h: string) => `${h.slice(0, 10)}…${h.slice(-4)}`;

function median(xs: number[]) {
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/** Retries once on a send error (the live worker shares the reporter key, so a nonce race is possible). */
async function retryOnce<T>(label: string, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    console.warn(`  ! ${label} failed once (${err instanceof Error ? err.message.split('\n')[0] : err}); retrying in 5 s`);
    await sleep(5_000);
    return fn();
  }
}

type Round = {
  at: string;
  kind: 'DRILL';
  series: string;
  symbol: string;
  bps: number;
  origin: string;
  reactive: string | null;
  callback: string;
  lasnaBlock: number | null;
  originToBreakerSec: number;
  originToBreakerBlocks: number;
  wallSec: number;
};

async function main() {
  const symbol = (arg('symbol') ?? 'AAPLc').toUpperCase();
  const bps = Number(arg('bps') ?? '350');
  const rounds = Number(arg('rounds') ?? '5');
  const gapSec = Number(arg('gap') ?? '60');
  if (!Number.isInteger(bps) || bps < 200 || bps > 5000) throw new Error('--bps must be an integer between 200 and 5000');
  if (!Number.isInteger(rounds) || rounds < 1 || rounds > 20) throw new Error('--rounds must be 1–20');
  if (!Number.isFinite(gapSec) || gapSec < 30) throw new Error('--gap must be at least 30 seconds');

  const cfg = loadConfig();
  const mirror = createMirror(cfg.onchain);
  if (!mirror || !cfg.onchain.registry) throw new Error('Set STOCKGUARD_REGISTRY_ADDRESS and REPORTER_PRIVATE_KEY in .env first.');
  if (!cfg.onchain.rsc) throw new Error('Set STOCKGUARD_RSC_ADDRESS in .env (the sentinel on Lasna) first.');
  const registry = cfg.onchain.registry;
  const reactive = createReactiveReader({
    lasnaRpcUrl: cfg.onchain.lasnaRpcUrl,
    baseSepoliaRpcUrl: cfg.onchain.rpcUrl,
    rsc: cfg.onchain.rsc,
    registry,
  });
  const pub = createPublicClient({ chain: baseSepolia, transport: http(cfg.onchain.rpcUrl) });

  const series = new Date().toISOString();
  console.log(`LATENCY DRILL SERIES on Base Sepolia testnet — ${symbol}, −${bps} bps, ${rounds} rounds, ${gapSec} s apart\n`);

  const done: Round[] = [];
  for (let i = 1; i <= rounds; i++) {
    // Pre-flight every round: a loop in debt fails silently.
    const acct = await reactive.accounting();
    if (acct.sentinel && Number(acct.sentinel.debt) > 0) throw new Error(`Sentinel is in debt (${acct.sentinel.debt} lREACT). Stop and run \`npm run onchain:status\`.`);
    if (acct.registry && Number(acct.registry.debt) > 0) throw new Error(`Registry is in callback debt (${acct.registry.debt} ETH). Stop and run \`npm run onchain:status\`.`);

    const board = await readBoard();
    const row = board?.rows.find((r) => r.symbol.toUpperCase() === symbol);
    if (!row || row.navUsd === null || row.dexUsd === null) throw new Error(`${symbol}: needs a NAV and a DEX price on the board`);
    const asset = row.address as `0x${string}`;
    const healthy = () => pub.readContract({ address: registry, abi: GUARD_ABI, functionName: 'isHealthy', args: [asset] });

    console.log(`── round ${i}/${rounds}`);
    if (!(await healthy())) {
      console.log('  not healthy → real-price report + clear first');
      await retryOnce('restore report', () => mirror.report(row, 'HEARTBEAT', undefined, 'restore before latency drill'));
      await retryOnce('clear', () => mirror.clearBreaker(row));
      if (!(await healthy())) throw new Error(`${symbol} is still not healthy (real gap may be ≥ 200 bps right now). Try another --symbol.`);
    }

    const synthetic = Number((row.navUsd * (1 - bps / 10_000)).toFixed(8));
    const rep = await retryOnce('DRILL report', () => mirror.report(row, 'DRILL', synthetic, `latency series -${bps}bps #${i}`));
    const seenOrigin = Date.now();
    console.log(`  1) origin       ${txUrl(BASE_SEPOLIA_ID, rep.txHash)}`);
    if (!rep.alertEmitted) throw new Error('DepegAlertEmitted did not fire; use a larger --bps');

    // Our stopwatch: poll the breaker flag every second.
    const reactionP = reactive.findReaction(rep.txHash);
    let seenBreaker: number | null = null;
    const deadline = Date.now() + 300_000;
    while (Date.now() < deadline) {
      const st = (await mirror.breakerStates([asset])).get(asset.toLowerCase());
      if (st?.active) {
        seenBreaker = Date.now();
        break;
      }
      await sleep(1_000);
    }
    if (seenBreaker === null) throw new Error('No breaker within 5 min — stop and run `npm run onchain:status`');
    const callback = await mirror.waitForBreaker(row, rep.blockNumber, 30_000);
    if (!callback) throw new Error('Breaker is on but the CircuitBreakerTriggered log was not found');
    const reaction = await reactionP;

    const tOrigin = await reactive.blockTime('base', rep.blockNumber);
    const tCallback = await reactive.blockTime('base', callback.blockNumber);
    const r: Round = {
      at: new Date().toISOString(),
      kind: 'DRILL',
      series,
      symbol: row.symbol,
      bps,
      origin: rep.txHash,
      reactive: reaction?.txHash ?? null,
      callback: callback.txHash,
      lasnaBlock: reaction ? Number(reaction.blockNumber) : null,
      originToBreakerSec: tCallback - tOrigin,
      originToBreakerBlocks: Number(callback.blockNumber - rep.blockNumber),
      wallSec: Math.round((seenBreaker - seenOrigin) / 100) / 10,
    };
    if (reaction) console.log(`  2) reactive     ${txUrl(REACTIVE_LASNA_ID, reaction.txHash)}  (Lasna block ${reaction.blockNumber})`);
    console.log(`  3) destination  ${txUrl(BASE_SEPOLIA_ID, callback.txHash)}`);
    console.log(`  chain ${r.originToBreakerSec} s / ${r.originToBreakerBlocks} blocks · wall ${r.wallSec} s`);

    await mkdir(dataDir(), { recursive: true });
    await appendFile(path.join(dataDir(), 'drills.jsonl'), `${JSON.stringify(r)}\n`);
    done.push(r);

    // Back to a real price before the next round (clear alone would leave the grade at C).
    const back = await retryOnce('restore report', () => mirror.report(row, 'HEARTBEAT', undefined, 'restore after latency drill'));
    const cleared = await retryOnce('clear', () => mirror.clearBreaker(row));
    console.log(`  restored ${txUrl(BASE_SEPOLIA_ID, back.txHash)}${cleared ? ` · cleared ${txUrl(BASE_SEPOLIA_ID, cleared)}` : ''}`);

    if (i < rounds) {
      console.log(`  waiting ${gapSec} s…\n`);
      await sleep(gapSec * 1_000);
    }
  }

  // Include earlier single drills from drills.jsonl so the table covers every recorded drill.
  let earlier: Array<Partial<Round>> = [];
  try {
    earlier = (await readFile(path.join(dataDir(), 'drills.jsonl'), 'utf8'))
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l) as Partial<Round>)
      .filter((l) => l.series !== series && typeof l.originToBreakerSec === 'number');
  } catch {
    /* none */
  }

  const chain = done.map((r) => r.originToBreakerSec);
  const blocks = done.map((r) => r.originToBreakerBlocks);
  const wall = done.map((r) => r.wallSec);
  const allChain = [...earlier.map((r) => r.originToBreakerSec as number), ...chain];

  const lines = [
    `### Measured loop latency (DRILL series, ${series.slice(0, 10)}, Base Sepolia ⇄ Reactive Lasna)`,
    '',
    `${symbol}, synthetic −${bps} bps, ${done.length} rounds ${gapSec} s apart. Every round: origin report → Lasna react → breaker callback, then a real-price report and clear.`,
    '',
    '| # | Origin (Base Sepolia) | React (Lasna) | Breaker callback (Base Sepolia) | Chain time | Blocks | Wall clock |',
    '|---|---|---|---|---|---|---|',
    ...done.map(
      (r, k) =>
        `| ${k + 1} | [${short(r.origin)}](${txUrl(BASE_SEPOLIA_ID, r.origin)}) | ${r.reactive ? `[${short(r.reactive)}](${txUrl(REACTIVE_LASNA_ID, r.reactive)})` : '—'} | [${short(r.callback)}](${txUrl(BASE_SEPOLIA_ID, r.callback)}) | ${r.originToBreakerSec} s | ${r.originToBreakerBlocks} | ${r.wallSec} s |`,
    ),
    '',
    `| | Median | Min | Max |`,
    `|---|---|---|---|`,
    `| Chain time (block timestamps, 1 s resolution) | ${median(chain)} s | ${Math.min(...chain)} s | ${Math.max(...chain)} s |`,
    `| Blocks, origin → callback | ${median(blocks)} | ${Math.min(...blocks)} | ${Math.max(...blocks)} |`,
    `| Wall clock (our stopwatch, ±1 s polling) | ${median(wall)} s | ${Math.min(...wall)} s | ${Math.max(...wall)} s |`,
    '',
    earlier.length
      ? `All ${allChain.length} recorded drills (including ${earlier.length} earlier single drills): median ${median(allChain)} s, max ${Math.max(...allChain)} s chain time.`
      : '',
    'The Lasna hop is shown by transaction only: the two chains’ clocks are not comparable to the second. All rounds are labelled DRILL on-chain and in the app.',
  ];
  const md = lines.filter((l, k) => l !== '' || lines[k - 1] !== '').join('\n') + '\n';
  await writeFile(path.join(dataDir(), 'latency-stats.md'), md);
  console.log(`\n${md}\nSaved to .data/latency-stats.md and .data/drills.jsonl`);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
