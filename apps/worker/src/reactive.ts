/**
 * Read-only access to the Reactive side (Lasna) and to the callback-proxy accounting on Base Sepolia.
 *
 * Why this exists: a reactive contract in debt "silently receives nothing", and a callback contract in debt
 * gets no callbacks. Nothing errors — the loop just stops. So we check balances and debt explicitly.
 *   - Lasna:        system contract 0x8888…8888  debt(address) / reserves(address)   (dev.reactive.network/debugging)
 *   - Base Sepolia: callback proxy               debt(address) / reserves(address)
 */
import { createPublicClient, defineChain, formatEther, http, parseAbi, parseAbiItem, type Hash } from 'viem';
import { baseSepolia } from 'viem/chains';
import { REACTIVE_CALLBACK_PROXY, REACTIVE_LASNA_ID, BASE_SEPOLIA_ID } from '@stockguard/core';

export const REACTIVE_SYSTEM = '0x8888888888888888888888888888888888888888' as const;

const ACCOUNTING_ABI = parseAbi([
  'function debt(address) view returns (uint256)',
  'function reserves(address) view returns (uint256)',
]);
const RSC_ABI = parseAbi(['function callbackGasLimit() view returns (uint64)', 'function owner() view returns (address)']);
export const SENTINEL_FIRED = parseAbiItem(
  'event SentinelFired(address indexed asset, uint256 depegBps, uint256 originTxHash, uint256 originLogIndex)',
);

export const lasna = defineChain({
  id: REACTIVE_LASNA_ID,
  name: 'Reactive Lasna',
  nativeCurrency: { name: 'lREACT', symbol: 'lREACT', decimals: 18 },
  rpcUrls: { default: { http: ['https://lasna-rpc.rnk.dev/'] } },
});

export function createReactiveReader(opts: { lasnaRpcUrl: string; baseSepoliaRpcUrl: string; rsc: `0x${string}` | null; registry: `0x${string}` | null }) {
  const lasnaPub = createPublicClient({ chain: lasna, transport: http(opts.lasnaRpcUrl) });
  const basePub = createPublicClient({ chain: baseSepolia, transport: http(opts.baseSepoliaRpcUrl) });
  const proxy = REACTIVE_CALLBACK_PROXY[BASE_SEPOLIA_ID];

  return {
    lasnaPub,
    basePub,

    /** Balance, debt and reserves on both sides. Throws only on RPC failure. */
    async accounting() {
      const out: {
        sentinel: null | { address: string; balance: string; debt: string; reserves: string; callbackGasLimit: string };
        registry: null | { address: string; balance: string; debt: string; reserves: string };
      } = { sentinel: null, registry: null };
      if (opts.rsc) {
        const [bal, debt, reserves, gas] = await Promise.all([
          lasnaPub.getBalance({ address: opts.rsc }),
          lasnaPub.readContract({ address: REACTIVE_SYSTEM, abi: ACCOUNTING_ABI, functionName: 'debt', args: [opts.rsc] }),
          lasnaPub.readContract({ address: REACTIVE_SYSTEM, abi: ACCOUNTING_ABI, functionName: 'reserves', args: [opts.rsc] }).catch(() => 0n),
          lasnaPub.readContract({ address: opts.rsc, abi: RSC_ABI, functionName: 'callbackGasLimit' }).catch(() => null),
        ]);
        out.sentinel = {
          address: opts.rsc,
          balance: formatEther(bal),
          debt: formatEther(debt),
          reserves: formatEther(reserves),
          callbackGasLimit: gas === null ? 'unknown (older sentinel build?)' : gas.toString(),
        };
      }
      if (opts.registry) {
        const [bal, debt, reserves] = await Promise.all([
          basePub.getBalance({ address: opts.registry }),
          basePub.readContract({ address: proxy, abi: ACCOUNTING_ABI, functionName: 'debt', args: [opts.registry] }),
          basePub.readContract({ address: proxy, abi: ACCOUNTING_ABI, functionName: 'reserves', args: [opts.registry] }).catch(() => 0n),
        ]);
        out.registry = { address: opts.registry, balance: formatEther(bal), debt: formatEther(debt), reserves: formatEther(reserves) };
      }
      return out;
    },

    /**
     * Finds the Lasna transaction in which our sentinel reacted to a given origin tx (SentinelFired carries the
     * origin tx hash). Scans recent Lasna blocks in small windows; returns null if not found before the deadline.
     */
    async findReaction(originTx: Hash, timeoutMs = 300_000): Promise<{ txHash: Hash; blockNumber: bigint; timestamp: number } | null> {
      if (!opts.rsc) return null;
      const want = BigInt(originTx);
      const deadline = Date.now() + timeoutMs;
      let from = (await lasnaPub.getBlockNumber()) - 300n;
      while (Date.now() < deadline) {
        const head = await lasnaPub.getBlockNumber();
        for (let start = from; start <= head; start += 500n) {
          const end = start + 499n > head ? head : start + 499n;
          const logs = await lasnaPub.getLogs({ address: opts.rsc, event: SENTINEL_FIRED, fromBlock: start, toBlock: end });
          const hit = logs.find((l) => l.args.originTxHash === want);
          if (hit?.transactionHash) {
            const block = await lasnaPub.getBlock({ blockNumber: hit.blockNumber });
            return { txHash: hit.transactionHash, blockNumber: hit.blockNumber, timestamp: Number(block.timestamp) };
          }
        }
        from = head - 50n; // overlap a little in case of reorgs / late indexing
        await new Promise((r) => setTimeout(r, 5_000));
      }
      return null;
    },

    async blockTime(chain: 'base' | 'lasna', blockNumber: bigint): Promise<number> {
      const c = chain === 'base' ? basePub : lasnaPub;
      return Number((await c.getBlock({ blockNumber })).timestamp);
    },
  };
}
