/**
 * One-time on-chain setup after deploying the contracts (see docs/DEPLOY.md).
 *   npm run onchain:setup
 * - makes the REPORTER_PRIVATE_KEY address a reporter (needs the owner key; on testnet they are the same)
 * - points the registry at our Reactive sentinel (STOCKGUARD_RSC_ADDRESS)
 * - prints everything you need to paste into the submission
 */
import { isAddress } from 'viem';
import { BASE_SEPOLIA_ID, EXPLORER, REACTIVE_CALLBACK_PROXY } from '@stockguard/core';
import { loadConfig } from './config.js';
import { createMirror } from './onchain.js';

async function main() {
  const cfg = loadConfig();
  const mirror = createMirror(cfg.onchain);
  if (!mirror) {
    console.error('Set STOCKGUARD_REGISTRY_ADDRESS and REPORTER_PRIVATE_KEY in .env first (see docs/DEPLOY.md).');
    process.exit(1);
  }
  const rsc = process.env.STOCKGUARD_RSC_ADDRESS?.trim();
  if (rsc && !isAddress(rsc)) throw new Error('STOCKGUARD_RSC_ADDRESS is not a valid address');

  let s = await mirror.status();
  console.log(`registry        ${EXPLORER[BASE_SEPOLIA_ID]}/address/${mirror.registry}`);
  console.log(`callback proxy  ${REACTIVE_CALLBACK_PROXY[BASE_SEPOLIA_ID]} (must equal the registry constructor argument)`);
  console.log(`key address     ${mirror.account}  (${s.balanceEth} ETH)`);
  console.log(`owner           ${s.owner}${s.isOwner ? '  ← this key' : ''}`);

  if (!s.isReporter) {
    if (!s.isOwner) throw new Error('This key is neither reporter nor owner. Ask the owner to call setReporter().');
    console.log(`setReporter     ${await mirror.setReporter(mirror.account)}`);
  }
  if (rsc && s.reactiveSender.toLowerCase() !== rsc.toLowerCase()) {
    if (!s.isOwner) throw new Error('Only the owner can set the reactive sender.');
    console.log(`setReactiveSender ${await mirror.setReactiveSender(rsc as `0x${string}`)}`);
  }
  s = await mirror.status();
  console.log(`reporter        ${s.isReporter}`);
  console.log(`reactiveSender  ${s.reactiveSender}${rsc ? '' : '   (set STOCKGUARD_RSC_ADDRESS after deploying the sentinel)'}`);
  console.log('\nDone. Start the worker with `npm run worker`, then run a drill: `npm run drill -- --symbol AAPLc --bps 350`.');
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
