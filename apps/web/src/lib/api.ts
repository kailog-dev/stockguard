import type { AssetDetail, Board, OnchainInfo, ScanResult } from './types';

const API_BASE = (import.meta.env.VITE_API_BASE ?? '').replace(/\/$/, '');

async function get<T>(path: string): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, { headers: { Accept: 'application/json' } });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((body as { error?: string }).error ?? `HTTP ${res.status}`);
  return body as T;
}

export const fetchBoard = () => get<Board>('/api/board');
export const fetchAsset = (symbol: string) => get<AssetDetail>(`/api/assets/${encodeURIComponent(symbol)}`);
export const fetchOnchain = () => get<OnchainInfo>('/api/onchain');
export const fetchAgentInfo = () => get<{ status: string; payment: { network: string; price: string } | null }>('/api/agent');

export async function scanAddress(address: string): Promise<ScanResult> {
  const res = await fetch(`${API_BASE}/api/scan`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ address }),
  });
  const body = (await res.json().catch(() => ({}))) as ScanResult;
  if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`);
  return body;
}

export function apiUrl(path: string): string {
  return `${API_BASE || window.location.origin}${path}`;
}
