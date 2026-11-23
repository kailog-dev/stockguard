/**
 * Real 1-tap attestation: StockGuardRegistry.publishAttestation(...) with the ERC-8021 Base Builder Code
 * appended as calldata suffix (the contract ignores trailing bytes; Base indexes the suffix for attribution).
 *
 * Returns { simulated: true } when the registry address or wallet is missing, so the UI can never show a
 * random string as if it were a transaction hash (v1 did exactly that).
 */
import { createPublicClient, createWalletClient, custom, http, isAddress, keccak256, stringToHex, type Hex } from 'viem';
import type { BoardRow } from './types';
import { base, baseSepolia } from 'viem/chains';
import { Attribution } from 'ox/erc8021';

export const REGISTRY_ABI = [
  {
    type: 'function',
    name: 'publishAttestation',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'asset', type: 'address' },
      { name: 'navPriceE8', type: 'uint256' },
      { name: 'dexPriceE8', type: 'uint256' },
      { name: 'reportHash', type: 'bytes32' },
    ],
    outputs: [{ name: 'attestationId', type: 'uint256' }],
  },
] as const;

const chain = import.meta.env.VITE_STOCKGUARD_CHAIN === 'base' ? base : baseSepolia;
const registry = import.meta.env.VITE_STOCKGUARD_REGISTRY_ADDRESS;
const builderCode = import.meta.env.VITE_BASE_BUILDER_CODE;

export const attestConfig = {
  chainName: chain.name,
  chainId: chain.id,
  registry: registry && isAddress(registry) ? (registry as `0x${string}`) : null,
  builderCode: builderCode && /^bc_[A-Za-z0-9_-]+$/.test(builderCode) ? builderCode : null,
  explorer: chain.blockExplorers?.default.url ?? '',
};

export type AttestOutcome =
  | { simulated: true; reason: string }
  | { simulated: false; txHash: Hex; explorerUrl: string };

export async function publishAttestation(args: {
  asset: `0x${string}`;
  navPriceE8: bigint;
  dexPriceE8: bigint;
  reportHash: Hex;
}): Promise<AttestOutcome> {
  if (!attestConfig.registry) return { simulated: true, reason: 'VITE_STOCKGUARD_REGISTRY_ADDRESS not set' };
  if (!window.ethereum) return { simulated: true, reason: 'No browser wallet found' };

  const wallet = createWalletClient({ chain, transport: custom(window.ethereum) });
  const [account] = await wallet.requestAddresses();
  if (!account) return { simulated: true, reason: 'Wallet not connected' };

  const current = await wallet.getChainId();
  if (current !== chain.id) await wallet.switchChain({ id: chain.id });

  const dataSuffix = attestConfig.builderCode
    ? Attribution.toDataSuffix({ codes: [attestConfig.builderCode] })
    : undefined;

  const txHash = await wallet.writeContract({
    account,
    address: attestConfig.registry,
    abi: REGISTRY_ABI,
    functionName: 'publishAttestation',
    args: [args.asset, args.navPriceE8, args.dexPriceE8, args.reportHash],
    dataSuffix,
  });

  // wait so the UI only reports success for a mined, non-reverted transaction
  const pub = createPublicClient({ chain, transport: http() });
  const receipt = await pub.waitForTransactionReceipt({ hash: txHash });
  if (receipt.status !== 'success') throw new Error('Attestation transaction reverted');

  return { simulated: false, txHash, explorerUrl: `${attestConfig.explorer}/tx/${txHash}` };
}

/** Deterministic hash of what the user saw (symbol, prices, deviation, board time). */
export function rowReportHash(row: BoardRow, generatedAt: number): Hex {
  return keccak256(stringToHex(JSON.stringify([row.symbol, row.address, row.navUsd, row.dexUsd, row.premiumBps, generatedAt])));
}

export function toE8(usd: number): bigint {
  return BigInt(Math.round(usd * 1e8));
}
