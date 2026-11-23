/**
 * Fire drill on Base Sepolia (testnet, no real money): reports a synthetic DEX price N bps away from the
 * real NAV and follows the full Reactive loop, printing all three transactions and the measured latency:
 *   1) origin       reportMarket → DepegAlertEmitted            (Base Sepolia)
 *   2) reactive     DepegSentinelRSC.react → SentinelFired      (Reactive Lasna)
 *   3) destination  triggerCircuitBreaker                        (Base Sepolia)
 *
 *   npm run drill -- --symbol AAPLc --bps 350
 *   npm run drill -- --symbol AAPLc --bps 350 --clear     (clears the breaker afterwards; owner key)
 *
 * Latency is origin → breaker, both on Base Sepolia, from block timestamps (1-second resolution), so it is a
 * block-level figure, not a stopwatch. The Lasna reaction is reported by block number only: two chains' clocks
 * are not comparable to the second (a first drill showed Lasna "1 s before" the origin). Drills are recorded as kind "DRILL" in .data/onchain.json and
 * shown as drills in the web app. Never present a drill as a real market event.
 */
import { appendFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { BASE_SEPOLIA_ID, REACTIVE_LASNA_ID, dataDir, readBoard, txUrl } from '@stockguard/core';
import { loadConfig } from './config.js';
import { createMirror } from './onchain.js';
import { createReactiveReader } from './reactive.js';

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main() {
  const symbol = (arg('symbol') ?? '').toUpperCase();
  const bps = Number(arg('bps') ?? '350');
  if (!symbol) throw new Error('Usage: npm run drill -- --symbol AAPLc --bps 350');
  if (!Number.isInteger(bps) || bps < 1 || bps > 5000) throw new Error('--bps must be an integer between 1 and 5000');

  const cfg = loadConfig();
  const mirror = createMirror(cfg.onchain);
  if (!mirror) throw new Error('Set STOCKGUARD_REGISTRY_ADDRESS and REPORTER_PRIVATE_KEY in .env first.');
  if (!cfg.onchain.rsc) throw new Error('Set STOCKGUARD_RSC_ADDRESS in .env (the sentinel on Lasna) first.');
  const reactive = createReactiveReader({
    lasnaRpcUrl: cfg.onchain.lasnaRpcUrl,
    baseSepoliaRpcUrl: cfg.onchain.rpcUrl,
    rsc: cfg.onchain.rsc,
    registry: cfg.onchain.registry,
  });

  // Pre-flight: a loop in debt fails silently, so refuse to run one.
  const acct = await reactive.accounting();
  if (acct.sentinel && Number(acct.sentinel.debt) > 0) throw new Error(`Sentinel is in debt (${acct.sentinel.debt} lREACT). Run \`npm run onchain:status\`.`);
  if (acct.registry && Number(acct.registry.debt) > 0) throw new Error(`Registry is in callback debt (${acct.registry.debt} ETH). Run \`npm run onchain:status\`.`);
  if (acct.sentinel && Number(acct.sentinel.balance) < 0.1) console.warn(`! Sentinel balance is low: ${acct.sentinel.balance} lREACT`);

  const board = await readBoard();
  const row = board?.rows.find((r) => r.symbol.toUpperCase() === symbol);
  if (!row) throw new Error(`${symbol} is not on the board. Run \`npm run worker:once\` first.`);
  if (row.navUsd === null) throw new Error(`${symbol} has no NAV right now.`);

  const synthetic = Number((row.navUsd * (1 - bps / 10_000)).toFixed(8));
  console.log(`DRILL on Base Sepolia testnet — ${row.symbol}: real NAV $${row.navUsd}, synthetic DEX $${synthetic} (−${bps} bps)\n`);

  const rep = await mirror.report(row, 'DRILL', synthetic, `synthetic -${bps}bps`);
  const tOrigin = await reactive.blockTime('base', rep.blockNumber);
  console.log(`1) origin       reportMarket            ${txUrl(BASE_SEPOLIA_ID, rep.txHash)}`);
  if (!rep.alertEmitted) {
    console.log('   DepegAlertEmitted did not fire (bps below the registry alert threshold, 200 by default). Use a larger --bps.');
    return;
  }

  console.log('   waiting for the sentinel on Lasna…');
  const [reaction, callback] = await Promise.all([reactive.findReaction(rep.txHash), mirror.waitForBreaker(row, rep.blockNumber)]);

  if (reaction) console.log(`2) reactive     react → SentinelFired   ${txUrl(REACTIVE_LASNA_ID, reaction.txHash)}`);
  else console.log('2) reactive     not found within 5 min — check the sentinel balance/debt (`npm run onchain:status`)');

  if (!callback) {
    console.log('3) destination  no callback within 5 min. Check: registry callback debt/reserves, reactiveSender, sentinel gas limit.');
    process.exit(2);
  }
  const tCallback = await reactive.blockTime('base', callback.blockNumber);
  console.log(`3) destination  triggerCircuitBreaker   ${txUrl(BASE_SEPOLIA_ID, callback.txHash)}`);

  const total = tCallback - tOrigin;
  const blocks = callback.blockNumber - rep.blockNumber;
  console.log(`\nLatency (Base Sepolia block timestamps): origin → breaker ${total} s, ${blocks} block(s) later`);
  if (reaction) console.log(`Lasna reaction in block ${reaction.blockNumber} (cross-chain clocks differ, so no seconds are claimed for this hop)`);

  // Keep a record for the submission (docs/SUBMISSION_REACTIVE.md)
  const line = {
    at: new Date().toISOString(),
    kind: 'DRILL',
    symbol: row.symbol,
    bps,
    origin: rep.txHash,
    reactive: reaction?.txHash ?? null,
    callback: callback.txHash,
    lasnaBlock: reaction ? Number(reaction.blockNumber) : null,
    originToBreakerSec: total,
    originToBreakerBlocks: Number(blocks),
  };
  await mkdir(dataDir(), { recursive: true });
  await appendFile(path.join(dataDir(), 'drills.jsonl'), `${JSON.stringify(line)}\n`);
  console.log(`Saved to .data/drills.jsonl`);

  if (process.argv.includes('--clear')) {
    const h = await mirror.clearBreaker(row);
    if (h) console.log(`Breaker cleared ${txUrl(BASE_SEPOLIA_ID, h)}`);
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
