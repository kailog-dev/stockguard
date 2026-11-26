import dns from 'node:dns';
import net from 'node:net';

// Network defaults for every worker entry point (all of them import this file first).
// The server has no working IPv6 route, and Node's "happy eyeballs" gives each address only 250 ms
// before moving on. From Tokyo, Telegram's IPv4 handshake can take longer than that, so the attempt
// was abandoned, the IPv6 fallback failed, and fetch() reported ETIMEDOUT. Prefer IPv4 and connect
// to one address at a time with the normal OS timeout.
dns.setDefaultResultOrder('ipv4first');
net.setDefaultAutoSelectFamily(false);

/** Worker configuration from environment variables (.env at the repo root). */
import { isAddress } from 'viem';

function num(name: string, fallback: number, min = 0): number {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < min) throw new Error(`${name} must be a number >= ${min} (got "${raw}")`);
  return n;
}

function list(name: string): string[] {
  return (process.env[name] ?? '')
    .split(',')
    .map((s) => s.trim().toUpperCase())
    .filter(Boolean);
}

export interface WorkerConfig {
  pollIntervalSec: number;
  alert: { triggerBps: number; clearBps: number; confirmPolls: number; rearmMs: number };
  minAlertLiquidityUsd: number;
  telegram: { token: string; chatId: string } | null;
  publicAppUrl: string | null;
  onchain: {
    rpcUrl: string;
    lasnaRpcUrl: string;
    rsc: `0x${string}` | null;
    registry: `0x${string}` | null;
    privateKey: `0x${string}` | null;
    heartbeatSymbols: string[];
    heartbeatHours: number;
    autoClearBreaker: boolean;
  };
}

export function loadConfig(): WorkerConfig {
  const triggerBps = num('ALERT_TRIGGER_BPS', 200, 1);
  const clearBps = num('ALERT_CLEAR_BPS', 100, 0);
  if (clearBps >= triggerBps) throw new Error('ALERT_CLEAR_BPS must be lower than ALERT_TRIGGER_BPS');

  const token = process.env.TELEGRAM_BOT_TOKEN?.trim();
  const chatId = process.env.TELEGRAM_CHAT_ID?.trim();

  const registry = process.env.STOCKGUARD_REGISTRY_ADDRESS?.trim();
  if (registry && !isAddress(registry)) throw new Error('STOCKGUARD_REGISTRY_ADDRESS is not a valid address');

  const rsc = process.env.STOCKGUARD_RSC_ADDRESS?.trim();
  if (rsc && !isAddress(rsc)) throw new Error('STOCKGUARD_RSC_ADDRESS is not a valid address');

  const pk = process.env.REPORTER_PRIVATE_KEY?.trim();
  if (pk && !/^0x[0-9a-fA-F]{64}$/.test(pk)) throw new Error('REPORTER_PRIVATE_KEY must be 0x + 64 hex characters');

  return {
    pollIntervalSec: num('POLL_INTERVAL_SEC', 60, 15),
    alert: { triggerBps, clearBps, confirmPolls: num('ALERT_CONFIRM_POLLS', 2, 1), rearmMs: num('ALERT_REARM_MIN', 60, 0) * 60_000 },
    minAlertLiquidityUsd: num('ALERT_MIN_LIQUIDITY_USD', 10_000, 0),
    telegram: token && chatId ? { token, chatId } : null,
    publicAppUrl: process.env.PUBLIC_APP_URL?.trim() || null,
    onchain: {
      rpcUrl: process.env.BASE_SEPOLIA_RPC_URL?.trim() || 'https://sepolia.base.org',
      lasnaRpcUrl: process.env.LASNA_RPC_URL?.trim() || 'https://lasna-rpc.rnk.dev/',
      rsc: rsc ? (rsc as `0x${string}`) : null,
      registry: registry ? (registry as `0x${string}`) : null,
      privateKey: pk ? (pk as `0x${string}`) : null,
      heartbeatSymbols: list('ONCHAIN_HEARTBEAT_SYMBOLS'),
      heartbeatHours: num('ONCHAIN_HEARTBEAT_HOURS', 6, 1),
      autoClearBreaker: process.env.AUTO_CLEAR_BREAKER === 'true',
    },
  };
}
