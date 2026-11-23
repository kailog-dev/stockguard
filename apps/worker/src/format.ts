/** Human-readable alert text (Telegram HTML). Pure functions so they can be tested. */
import type { AlertEvent, BoardRow } from '@stockguard/core';

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

export function usd(n: number | null): string {
  if (n === null) return 'n/a';
  return `$${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: n < 1 ? 6 : 2 })}`;
}

export function compactUsd(n: number | null): string {
  if (n === null) return 'unknown';
  if (n >= 1e6) return `$${(n / 1e6).toFixed(2)}M`;
  if (n >= 1e3) return `$${(n / 1e3).toFixed(1)}k`;
  return `$${n.toFixed(0)}`;
}

export function pct(bps: number | null): string {
  if (bps === null) return 'n/a';
  const sign = bps > 0 ? '+' : bps < 0 ? '−' : '';
  return `${sign}${(Math.abs(bps) / 100).toFixed(2)}%`;
}

function minutes(ms: number): string {
  const m = Math.round(ms / 60_000);
  return m < 60 ? `${m} min` : `${Math.floor(m / 60)} h ${m % 60} min`;
}

const FOOTER = 'Market data only — not trading or investment advice. Coinbase tokenized stocks are not offered to US persons.';

export function formatAlert(e: AlertEvent, opts: { marketClosed: boolean; appUrl: string | null }): string {
  const r: BoardRow = e.row;
  const link = opts.appUrl ? `\n${esc(opts.appUrl)}/#${encodeURIComponent(r.symbol)}` : '';
  if (e.kind === 'DEPEG') {
    const dir = (r.premiumBps ?? 0) < 0 ? 'discount' : 'premium';
    return [
      `🚨 <b>StockGuard depeg alert — ${esc(r.symbol)}</b> (${esc(r.name)})`,
      `DEX ${usd(r.dexUsd)} vs NAV ${usd(r.navUsd)} → <b>${pct(r.premiumBps)}</b> ${dir}`,
      `Pool liquidity ${compactUsd(r.liquidityUsd)} on ${esc(r.dexId ?? 'unknown DEX')} · ${opts.marketClosed ? 'US market closed' : 'US market open'}`,
      `Grade ${r.grade ?? 'n/a'} · confirmed on consecutive checks`,
      `<i>${FOOTER}</i>${link}`,
    ].join('\n');
  }
  return [
    `✅ <b>${esc(r.symbol)} back near NAV</b>`,
    `Now ${pct(r.premiumBps)} after ${minutes(e.durationMs)} (peak deviation ${(e.peakBps / 100).toFixed(2)}%)`,
    `<i>${FOOTER}</i>${link}`,
  ].join('\n');
}
