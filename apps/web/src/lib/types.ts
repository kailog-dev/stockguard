/** Mirrors packages/core/src/board.ts and store.ts (kept separate so the browser bundle never pulls node:fs). */
export type RiskGrade = 'A' | 'B' | 'C' | 'CRITICAL';
export type RowStatus = 'OK' | 'NO_NAV' | 'NO_DEX_QUOTE';

export interface BoardRow {
  symbol: string;
  name: string;
  address: `0x${string}`;
  multiplier: number | null;
  totalSupply: number | null;
  navUsd: number | null;
  navUpdatedAt: string | null;
  dexUsd: number | null;
  liquidityUsd: number | null;
  volume24hUsd: number | null;
  dexId: string | null;
  pairUrl: string | null;
  status: RowStatus;
  depegBps: number | null;
  premiumBps: number | null;
  grade: RiskGrade | null;
  flags: string[];
  recommendedAction: string | null;
  alertable: boolean;
  notAlertableReasons: string[];
  /** Base Sepolia circuit-breaker state (null/absent when the asset is not registered on-chain). */
  onchain?: { breakerActive: boolean; lastDepegBps: number; triggeredAt: number } | null;
}

export interface Board {
  generatedAt: number;
  ageSec: number;
  stale: boolean;
  marketClosed: boolean;
  sources: {
    registry: { source: string; fetchedAt: number | null; error?: string };
    dex: { source: string; errors: string[] };
  };
  summary: { total: number; quoted: number; alertable: number; worst: { symbol: string; premiumBps: number } | null };
  rows: BoardRow[];
  disclaimer: string;
}

export interface HistoryPoint {
  t: number;
  nav: number | null;
  dex: number | null;
  premiumBps: number | null;
}

export interface OnchainEvent {
  at: number;
  kind: 'REGISTER' | 'REPORT' | 'HEARTBEAT' | 'DRILL' | 'BREAKER_TRIPPED' | 'BREAKER_CLEARED';
  symbol: string;
  asset: string;
  chainId: number;
  txHash: string;
  depegBps?: number;
  note?: string;
}

export interface AssetDetail {
  row: BoardRow;
  generatedAt: number;
  history: HistoryPoint[];
  onchain: OnchainEvent[];
}

export interface OnchainInfo {
  chainId: number;
  registry: string | null;
  sentinel: string | null;
  callbackProxy: string;
  events: OnchainEvent[];
}

export interface ScanResult {
  address: string;
  verdict: 'OFFICIAL' | 'NOT_OFFICIAL';
  symbol?: string;
  name?: string;
  message?: string;
  result?: { depegBps: number; grade: RiskGrade; flags: string[] };
  error?: string;
}
