/**
 * On-chain mirror on Base Sepolia: the worker reports confirmed depegs to StockGuardRegistry.reportMarket(),
 * which emits DepegAlertEmitted. DepegSentinelRSC on Reactive Lasna picks that up and calls
 * triggerCircuitBreaker() back on Base Sepolia through the Reactive callback proxy.
 *
 * Keeper transactions deliberately carry NO Base Builder Code: they are our own transactions and must not
 * be counted as user traction. Builder Codes are only attached to user-signed attestations in the web app.
 */
import {
  createPublicClient,
  createWalletClient,
  decodeEventLog,
  formatEther,
  http,
  zeroAddress,
  type Hash,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { baseSepolia } from 'viem/chains';
import {
  appendOnchainEvent,
  BASE_SEPOLIA_ID,
  STOCKGUARD_REGISTRY_ABI,
  toE8,
  txUrl,
  type BoardRow,
  type OnchainEvent,
} from '@stockguard/core';
import type { WorkerConfig } from './config.js';

export type Mirror = ReturnType<typeof createMirror>;

export function createMirror(cfg: WorkerConfig['onchain']) {
  if (!cfg.registry || !cfg.privateKey) return null;
  const registry = cfg.registry;
  const account = privateKeyToAccount(cfg.privateKey);
  const pub = createPublicClient({ chain: baseSepolia, transport: http(cfg.rpcUrl) });
  const wallet = createWalletClient({ chain: baseSepolia, transport: http(cfg.rpcUrl), account });

  async function send(fn: 'registerAsset' | 'reportMarket' | 'clearCircuitBreaker' | 'setReporter' | 'setReactiveSender', args: readonly unknown[]) {
    const hash = await wallet.writeContract({
      address: registry,
      abi: STOCKGUARD_REGISTRY_ABI,
      functionName: fn,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      args: args as any,
    });
    const receipt = await pub.waitForTransactionReceipt({ hash, timeout: 120_000 });
    if (receipt.status !== 'success') throw new Error(`${fn} reverted: ${txUrl(BASE_SEPOLIA_ID, hash)}`);
    return receipt;
  }

  async function log(e: Omit<OnchainEvent, 'at' | 'chainId'>) {
    await appendOnchainEvent({ ...e, at: Date.now(), chainId: BASE_SEPOLIA_ID });
    console.log(`[onchain] ${e.kind} ${e.symbol} ${txUrl(BASE_SEPOLIA_ID, e.txHash)}`);
  }

  async function getAsset(asset: `0x${string}`) {
    return pub.readContract({ address: registry, abi: STOCKGUARD_REGISTRY_ABI, functionName: 'getAsset', args: [asset] });
  }

  return {
    account: account.address,
    registry,

    async status() {
      const [owner, isReporter, reactiveSender, balance] = await Promise.all([
        pub.readContract({ address: registry, abi: STOCKGUARD_REGISTRY_ABI, functionName: 'owner' }),
        pub.readContract({ address: registry, abi: STOCKGUARD_REGISTRY_ABI, functionName: 'isReporter', args: [account.address] }),
        pub.readContract({ address: registry, abi: STOCKGUARD_REGISTRY_ABI, functionName: 'reactiveSender' }),
        pub.getBalance({ address: account.address }),
      ]);
      return {
        owner,
        isOwner: owner.toLowerCase() === account.address.toLowerCase(),
        isReporter,
        reactiveSender,
        balanceEth: formatEther(balance),
      };
    },

    getAsset,

    async setReporter(addr: `0x${string}`) {
      const r = await send('setReporter', [addr, true]);
      return r.transactionHash;
    },

    async setReactiveSender(addr: `0x${string}`) {
      const r = await send('setReactiveSender', [addr]);
      return r.transactionHash;
    },

    /** Registers the asset on first use (owner key required). Sepolia has no tokenized-stock feeds, so navFeed = 0. */
    async ensureRegistered(row: BoardRow) {
      const a = await getAsset(row.address);
      if (a.registered) return;
      const r = await send('registerAsset', [row.address, row.symbol, true, zeroAddress]);
      await log({ kind: 'REGISTER', symbol: row.symbol, asset: row.address, txHash: r.transactionHash });
    },

    /**
     * reportMarket(asset, navE8, dexE8). Returns the tx hash and whether DepegAlertEmitted fired
     * (which is what the Reactive sentinel listens to).
     */
    async report(row: BoardRow, kind: 'REPORT' | 'HEARTBEAT' | 'DRILL', dexOverrideUsd?: number, note?: string) {
      if (row.navUsd === null) throw new Error(`${row.symbol}: no NAV to report`);
      const dex = dexOverrideUsd ?? row.dexUsd;
      if (dex === null || dex === undefined) throw new Error(`${row.symbol}: no DEX price to report`);
      await this.ensureRegistered(row);
      const r = await send('reportMarket', [row.address, toE8(row.navUsd, 'nav'), toE8(dex, 'dex')]);
      let depegBps: number | undefined;
      let alertEmitted = false;
      for (const l of r.logs) {
        if (l.address.toLowerCase() !== registry.toLowerCase()) continue;
        try {
          const ev = decodeEventLog({ abi: STOCKGUARD_REGISTRY_ABI, data: l.data, topics: l.topics });
          if (ev.eventName === 'MarketReported') depegBps = Number(ev.args.depegBps);
          if (ev.eventName === 'DepegAlertEmitted') alertEmitted = true;
        } catch {
          /* not ours */
        }
      }
      await log({ kind, symbol: row.symbol, asset: row.address, txHash: r.transactionHash, depegBps, note });
      return { txHash: r.transactionHash as Hash, blockNumber: r.blockNumber, alertEmitted, depegBps };
    },

    /** Waits for the Reactive callback to trip the breaker; returns the callback tx or null on timeout. */
    async waitForBreaker(row: BoardRow, fromBlock: bigint, timeoutMs = 300_000): Promise<{ txHash: Hash; blockNumber: bigint } | null> {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        const logs = await pub.getContractEvents({
          address: registry,
          abi: STOCKGUARD_REGISTRY_ABI,
          eventName: 'CircuitBreakerTriggered',
          args: { asset: row.address },
          fromBlock,
        });
        const hit = logs[logs.length - 1];
        if (hit?.transactionHash && hit.blockNumber !== null) {
          await log({ kind: 'BREAKER_TRIPPED', symbol: row.symbol, asset: row.address, txHash: hit.transactionHash, depegBps: Number(hit.args.depegBps ?? 0) });
          return { txHash: hit.transactionHash, blockNumber: hit.blockNumber };
        }
        await new Promise((res) => setTimeout(res, 3_000));
      }
      return null;
    },

    /** Current on-chain breaker state for registered assets (one read per asset, run in parallel). */
    async breakerStates(assets: `0x${string}`[]) {
      const out = new Map<string, { registered: boolean; active: boolean; lastDepegBps: number; triggeredAt: number }>();
      await Promise.all(
        assets.map(async (a) => {
          try {
            const s = await getAsset(a);
            out.set(a.toLowerCase(), {
              registered: s.registered,
              active: s.circuitBreakerActive,
              lastDepegBps: Number(s.lastDepegBps),
              triggeredAt: Number(s.breakerTriggeredAt),
            });
          } catch {
            /* RPC hiccup: leave the asset out this round */
          }
        }),
      );
      return out;
    },

    async clearBreaker(row: BoardRow) {
      const a = await getAsset(row.address);
      if (!a.circuitBreakerActive) return null;
      const r = await send('clearCircuitBreaker', [row.address]);
      await log({ kind: 'BREAKER_CLEARED', symbol: row.symbol, asset: row.address, txHash: r.transactionHash });
      return r.transactionHash;
    },
  };
}
