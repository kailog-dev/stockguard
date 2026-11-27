/**
 * GuardedVault drill on Base Sepolia (testnet, no real money). Shows the circuit breaker stopping money
 * at a consumer contract, in four recorded transactions:
 *
 *   A) tryDepositCollateral while healthy            → CollateralAccepted
 *   B) DRILL: synthetic depeg → Reactive trips the breaker (same path as `npm run drill`)
 *   C) tryDepositCollateral while the breaker is on  → CollateralRefused
 *   D) real-price report + owner clear, then deposit → CollateralAccepted
 *
 *   cd apps/worker && npx tsx --env-file-if-exists=../../.env src/vault-drill.ts --vault 0x… --symbol AAPLc --bps 350
 *
 * Always a DRILL: the depeg in step B is synthetic and is logged as kind "DRILL". GuardedVault is
 * bookkeeping only (no tokens move). Results are appended to .data/vault-drills.jsonl.
 */
import { appendFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { createPublicClient, createWalletClient, decodeEventLog, http, parseAbi, type Hash } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { baseSepolia } from 'viem/chains';
import { BASE_SEPOLIA_ID, dataDir, readBoard, txUrl } from '@stockguard/core';
import { loadConfig } from './config.js';
import { createMirror } from './onchain.js';

const VAULT_ABI = parseAbi([
  'function tryDepositCollateral(address asset, uint256 amount) returns (bool accepted)',
  'function guard() view returns (address)',
  'event CollateralAccepted(address indexed user, address indexed asset, uint256 amount)',
  'event CollateralRefused(address indexed user, address indexed asset, uint256 amount)',
]);
const GUARD_ABI = parseAbi(['function isHealthy(address asset) view returns (bool)']);

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main() {
  const vault = (arg('vault') ?? process.env.GUARDED_VAULT_ADDRESS ?? '') as `0x${string}`;
  const symbol = (arg('symbol') ?? 'AAPLc').toUpperCase();
  const bps = Number(arg('bps') ?? '350');
  if (!/^0x[0-9a-fA-F]{40}$/.test(vault)) throw new Error('Usage: … src/vault-drill.ts --vault 0x<GuardedVault> [--symbol AAPLc] [--bps 350]');
  if (!Number.isInteger(bps) || bps < 200 || bps > 5000) throw new Error('--bps must be an integer between 200 and 5000');

  const cfg = loadConfig();
  const mirror = createMirror(cfg.onchain);
  if (!mirror || !cfg.onchain.privateKey || !cfg.onchain.registry) throw new Error('Set STOCKGUARD_REGISTRY_ADDRESS and REPORTER_PRIVATE_KEY in .env first.');
  const registry = cfg.onchain.registry;
  const account = privateKeyToAccount(cfg.onchain.privateKey);
  const pub = createPublicClient({ chain: baseSepolia, transport: http(cfg.onchain.rpcUrl) });
  const wallet = createWalletClient({ chain: baseSepolia, transport: http(cfg.onchain.rpcUrl), account });

  const guard = await pub.readContract({ address: vault, abi: VAULT_ABI, functionName: 'guard' });
  if (guard.toLowerCase() !== registry.toLowerCase()) throw new Error(`Vault guard ${guard} is not the registry ${registry}`);

  const board = await readBoard();
  const row = board?.rows.find((r) => r.symbol.toUpperCase() === symbol);
  if (!row || row.navUsd === null || row.dexUsd === null) throw new Error(`${symbol}: needs a NAV and a DEX price on the board`);
  const asset = row.address as `0x${string}`;

  const healthy = () => pub.readContract({ address: registry, abi: GUARD_ABI, functionName: 'isHealthy', args: [asset] });

  async function deposit(label: string) {
    const hash = await wallet.writeContract({ address: vault, abi: VAULT_ABI, functionName: 'tryDepositCollateral', args: [asset, 1n] });
    const r = await pub.waitForTransactionReceipt({ hash, timeout: 120_000 });
    if (r.status !== 'success') throw new Error(`deposit reverted: ${txUrl(BASE_SEPOLIA_ID, hash)}`);
    let outcome = 'unknown';
    for (const l of r.logs) {
      if (l.address.toLowerCase() !== vault.toLowerCase()) continue;
      try {
        const ev = decodeEventLog({ abi: VAULT_ABI, data: l.data, topics: l.topics });
        outcome = ev.eventName === 'CollateralAccepted' ? 'ACCEPTED' : 'REFUSED';
      } catch {
        /* not ours */
      }
    }
    console.log(`${label.padEnd(34)} ${outcome.padEnd(9)} ${txUrl(BASE_SEPOLIA_ID, hash)}`);
    return { hash: hash as Hash, outcome };
  }

  async function restore() {
    // a real-price report sets the last depeg back to the live value; then the owner clears the breaker
    const rep = await mirror!.report(row!, 'HEARTBEAT', undefined, 'restore after vault drill');
    const cleared = await mirror!.clearBreaker(row!);
    return { report: rep.txHash, cleared };
  }

  console.log(`GuardedVault DRILL on Base Sepolia testnet — ${row.symbol} (${asset})\nvault ${vault}\n`);

  let pre: Awaited<ReturnType<typeof restore>> | null = null;
  if (!(await healthy())) {
    console.log('asset is not healthy yet → real-price report + clear first');
    pre = await restore();
  }
  if (!(await healthy())) throw new Error(`${symbol} is still not healthy on the registry; check \`npm run onchain:status\``);

  const a = await deposit('A) deposit while healthy');

  const synthetic = Number((row.navUsd * (1 - bps / 10_000)).toFixed(8));
  const rep = await mirror.report(row, 'DRILL', synthetic, `vault drill -${bps}bps`);
  console.log(`B) DRILL report −${bps} bps                ${txUrl(BASE_SEPOLIA_ID, rep.txHash)}`);
  if (!rep.alertEmitted) throw new Error('DepegAlertEmitted did not fire; use a larger --bps');
  console.log('   waiting for the Reactive callback…');
  const trip = await mirror.waitForBreaker(row, rep.blockNumber);
  if (!trip) throw new Error('No breaker callback within 5 min — run `npm run onchain:status`');
  console.log(`   breaker tripped by Reactive           ${txUrl(BASE_SEPOLIA_ID, trip.txHash)}`);

  const c = await deposit('C) deposit while breaker is on');

  const res = await restore();
  console.log(`D) real-price report                    ${txUrl(BASE_SEPOLIA_ID, res.report)}`);
  if (res.cleared) console.log(`   breaker cleared (owner)               ${txUrl(BASE_SEPOLIA_ID, res.cleared)}`);
  const d = await deposit('   deposit after clear');

  const ok = a.outcome === 'ACCEPTED' && c.outcome === 'REFUSED' && d.outcome === 'ACCEPTED';
  console.log(`\n${ok ? '✓ accepted → refused → accepted' : '✗ unexpected sequence — check the transactions above'}`);

  const line = {
    at: new Date().toISOString(),
    kind: 'VAULT_DRILL',
    symbol: row.symbol,
    vault,
    bps,
    pre,
    depositHealthy: a,
    drillReport: rep.txHash,
    breakerTripped: trip.txHash,
    depositTripped: c,
    restoreReport: res.report,
    breakerCleared: res.cleared,
    depositAfterClear: d,
    ok,
  };
  await mkdir(dataDir(), { recursive: true });
  await appendFile(path.join(dataDir(), 'vault-drills.jsonl'), `${JSON.stringify(line)}\n`);
  console.log('Saved to .data/vault-drills.jsonl');
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
