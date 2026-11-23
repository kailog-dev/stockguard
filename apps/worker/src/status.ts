/**
 * Health check for the on-chain loop. Run it daily until the deadline:
 *   npm run onchain:status
 * A reactive contract in debt stops receiving events and a callback contract in debt stops receiving callbacks,
 * without any error. This prints balances, debt and reserves on both chains and exits 1 if anything is wrong.
 */
import { BASE_SEPOLIA_ID, EXPLORER, REACTIVE_CALLBACK_PROXY, REACTIVE_LASNA_ID } from '@stockguard/core';
import { loadConfig } from './config.js';
import { createReactiveReader } from './reactive.js';

const MIN_SENTINEL_LREACT = 0.5;
const MIN_REGISTRY_ETH = 0.002;

async function main() {
  const cfg = loadConfig();
  if (!cfg.onchain.registry && !cfg.onchain.rsc) {
    console.error('Set STOCKGUARD_REGISTRY_ADDRESS and STOCKGUARD_RSC_ADDRESS in .env first.');
    process.exit(1);
  }
  const r = createReactiveReader({
    lasnaRpcUrl: cfg.onchain.lasnaRpcUrl,
    baseSepoliaRpcUrl: cfg.onchain.rpcUrl,
    rsc: cfg.onchain.rsc,
    registry: cfg.onchain.registry,
  });
  const a = await r.accounting();
  const problems: string[] = [];

  if (a.sentinel) {
    console.log(`Sentinel (Lasna)  ${EXPLORER[REACTIVE_LASNA_ID]}/address/${a.sentinel.address}`);
    console.log(`  balance ${a.sentinel.balance} lREACT · debt ${a.sentinel.debt} · reserves ${a.sentinel.reserves} · callback gas ${a.sentinel.callbackGasLimit}`);
    if (Number(a.sentinel.debt) > 0) problems.push('Sentinel is in debt → it receives NO events. Send lREACT to it, then call coverDebt().');
    if (Number(a.sentinel.balance) < MIN_SENTINEL_LREACT) problems.push(`Sentinel balance under ${MIN_SENTINEL_LREACT} lREACT → top up (each reaction costs roughly 0.03 lREACT).`);
  }
  if (a.registry) {
    console.log(`Registry (Base Sepolia)  ${EXPLORER[BASE_SEPOLIA_ID]}/address/${a.registry.address}`);
    console.log(`  balance ${a.registry.balance} ETH · callback debt ${a.registry.debt} · proxy reserves ${a.registry.reserves}`);
    if (Number(a.registry.debt) > 0) problems.push(`Registry is in callback debt → NO callbacks. Fix: cast send ${REACTIVE_CALLBACK_PROXY[BASE_SEPOLIA_ID]} "depositTo(address)" ${a.registry.address} --value 0.01ether …`);
    if (Number(a.registry.balance) + Number(a.registry.reserves) < MIN_REGISTRY_ETH) problems.push(`Registry has under ${MIN_REGISTRY_ETH} ETH (balance + reserves) for callback fees → deposit more.`);
  }

  if (problems.length) {
    console.log('\nPROBLEMS');
    for (const p of problems) console.log(`  ✗ ${p}`);
    process.exit(1);
  }
  console.log('\n✓ Loop is funded and not in debt.');
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
