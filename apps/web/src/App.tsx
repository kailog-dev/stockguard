import { useCallback, useEffect, useMemo, useState } from 'react';
import { apiUrl, fetchAgentInfo, fetchAsset, fetchBoard, fetchOnchain, scanAddress } from './lib/api';
import { attestConfig, publishAttestation, rowReportHash, toE8 } from './lib/attest';
import type { AssetDetail, Board, BoardRow, OnchainEvent, OnchainInfo, ScanResult } from './lib/types';

const TELEGRAM_URL = import.meta.env.VITE_TELEGRAM_URL;
const X_URL = import.meta.env.VITE_X_URL;
const REFRESH_MS = 30_000;

// ------------------------------------------------------------------ formatting
const usd = (n: number | null) =>
  n === null ? '—' : `$${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: n < 1 ? 6 : 2 })}`;
const compact = (n: number | null) =>
  n === null ? '—' : n >= 1e6 ? `$${(n / 1e6).toFixed(2)}M` : n >= 1e3 ? `$${(n / 1e3).toFixed(1)}k` : `$${n.toFixed(0)}`;
const pct = (bps: number | null) =>
  bps === null ? '—' : `${bps > 0 ? '+' : bps < 0 ? '−' : ''}${(Math.abs(bps) / 100).toFixed(2)}%`;
const ago = (t: number) => {
  const s = Math.max(0, Math.round((Date.now() - t) / 1000));
  return s < 60 ? `${s}s ago` : s < 3600 ? `${Math.round(s / 60)}m ago` : `${Math.round(s / 3600)}h ago`;
};
const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;
const sepoliaTx = (h: string) => `https://sepolia.basescan.org/tx/${h}`;
const baseAddr = (a: string) => `https://basescan.org/address/${a}`;

function premiumClass(bps: number | null) {
  if (bps === null) return 'text-muted';
  const a = Math.abs(bps);
  if (a >= 200) return 'text-down font-semibold';
  if (a >= 50) return 'text-warn';
  return 'text-up';
}

const FLAG_TEXT: Record<string, string> = {
  US_AFTER_HOURS_OR_WEEKEND: 'US market closed — the NAV is frozen while the DEX keeps trading, so gaps are more likely.',
  THIN_DEX_LIQUIDITY_UNDER_50K: 'Pool under $50k — a single trade can move the price.',
  DEX_LIQUIDITY_UNKNOWN: 'Pool liquidity unknown — no alerts until it is.',
  NAV_STALE_OVER_26H: 'NAV older than 26 hours — treat the comparison with care.',
  NAV_BASIS_UNVERIFIED: 'Token multiplier ≠ 1 (e.g. after a split or dividend) — NAV and DEX may use different units, so we do not alert.',
  ISSUER_FEATURES_PAUSED: 'The issuer has paused some token features.',
  MINOR_DEPEG_OVER_0_5PCT: 'DEX price is 0.5–2% away from NAV.',
  ELEVATED_DEPEG_OVER_2PCT: 'DEX price is 2–5% away from NAV.',
  SEVERE_DEPEG_OVER_5PCT: 'DEX price is more than 5% away from NAV.',
  NOT_IN_OFFICIAL_REGISTRY: 'Not in the official Coinbase list.',
};

// ------------------------------------------------------------------ small components
function Card({ label, value, sub, tone }: { label: string; value: string; sub?: string; tone?: string }) {
  return (
    <div className="rounded-xl border border-line bg-panel p-4">
      <div className="text-xs uppercase tracking-wide text-muted">{label}</div>
      <div className={`mt-1 text-2xl font-semibold tnum ${tone ?? ''}`}>{value}</div>
      {sub && <div className="mt-1 text-xs text-muted">{sub}</div>}
    </div>
  );
}

function GradeBadge({ g }: { g: BoardRow['grade'] }) {
  if (!g) return <span className="text-muted">—</span>;
  const cls = g === 'A' ? 'bg-up/15 text-up' : g === 'B' ? 'bg-warn/15 text-warn' : 'bg-down/15 text-down';
  return <span className={`rounded px-2 py-0.5 text-xs font-semibold ${cls}`}>{g === 'CRITICAL' ? 'CRIT' : g}</span>;
}

function BreakerBadge({ row }: { row: BoardRow }) {
  if (!row.onchain) return null;
  return row.onchain.breakerActive ? (
    <span title="StockGuardRegistry.isHealthy() = false on Base Sepolia (tripped by the Reactive sentinel)" className="ml-2 rounded bg-down/15 px-1.5 py-0.5 text-[10px] font-semibold text-down">
      BREAKER ON
    </span>
  ) : (
    <span title="Registered in StockGuardRegistry on Base Sepolia; isHealthy() = true" className="ml-2 rounded bg-up/10 px-1.5 py-0.5 text-[10px] font-semibold text-up">
      on-chain ✓
    </span>
  );
}

function Sparkline({ points }: { points: { t: number; premiumBps: number | null }[] }) {
  const data = points.filter((p): p is { t: number; premiumBps: number } => p.premiumBps !== null);
  if (data.length < 2) return <div className="text-sm text-muted">Not enough history yet — it fills in as the worker runs.</div>;
  const W = 560, H = 120, P = 6;
  const t0 = data[0].t, t1 = data[data.length - 1].t;
  const max = Math.max(250, ...data.map((d) => Math.abs(d.premiumBps)));
  const x = (t: number) => P + ((t - t0) / Math.max(1, t1 - t0)) * (W - 2 * P);
  const y = (b: number) => H / 2 - (b / max) * (H / 2 - P);
  const path = data.map((d, i) => `${i ? 'L' : 'M'}${x(d.t).toFixed(1)},${y(d.premiumBps).toFixed(1)}`).join(' ');
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="w-full" role="img" aria-label="Premium or discount versus NAV over the last 24 hours">
      <line x1={P} x2={W - P} y1={H / 2} y2={H / 2} className="stroke-line" strokeDasharray="3 3" />
      {[200, -200].map((b) => (
        <line key={b} x1={P} x2={W - P} y1={y(b)} y2={y(b)} className="stroke-down/40" strokeDasharray="2 4" />
      ))}
      <path d={path} fill="none" className="stroke-accent" strokeWidth={2} />
      <text x={W - P} y={y(200) - 3} textAnchor="end" className="fill-muted text-[10px]">+2% alert line</text>
      <text x={W - P} y={y(-200) + 11} textAnchor="end" className="fill-muted text-[10px]">−2% alert line</text>
    </svg>
  );
}

function EventKind({ e }: { e: OnchainEvent }) {
  const label: Record<OnchainEvent['kind'], string> = {
    REGISTER: 'registered',
    REPORT: 'market report',
    HEARTBEAT: 'heartbeat',
    DRILL: 'DRILL (synthetic)',
    BREAKER_TRIPPED: 'breaker tripped by Reactive',
    BREAKER_CLEARED: 'breaker cleared',
  };
  const tone = e.kind === 'BREAKER_TRIPPED' ? 'text-down' : e.kind === 'DRILL' ? 'text-warn' : 'text-muted';
  return <span className={tone}>{label[e.kind]}</span>;
}

// ------------------------------------------------------------------ asset drawer
function AssetPanel({ symbol, board, onClose }: { symbol: string; board: Board; onClose: () => void }) {
  const [detail, setDetail] = useState<AssetDetail | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [attest, setAttest] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let live = true;
    setDetail(null);
    fetchAsset(symbol).then((d) => live && setDetail(d)).catch((e: Error) => live && setErr(e.message));
    return () => {
      live = false;
    };
  }, [symbol, board.generatedAt]);

  const row = detail?.row ?? board.rows.find((r) => r.symbol === symbol);
  if (!row) return null;

  async function onAttest() {
    if (!row || row.navUsd === null || row.dexUsd === null) return;
    setBusy(true);
    setAttest(null);
    try {
      const out = await publishAttestation({
        asset: row.address,
        navPriceE8: toE8(row.navUsd),
        dexPriceE8: toE8(row.dexUsd),
        reportHash: rowReportHash(row, board.generatedAt),
      });
      setAttest(out.simulated ? `Not sent: ${out.reason}` : `Recorded on ${attestConfig.chainName}: ${out.explorerUrl}`);
    } catch (e) {
      setAttest(e instanceof Error ? e.message : 'Transaction failed');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="fixed inset-0 z-20 flex justify-end bg-black/50" onClick={onClose}>
      <aside className="h-full w-full max-w-xl overflow-y-auto border-l border-line bg-panel p-6" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-start justify-between gap-4">
          <div>
            <div className="text-2xl font-semibold">{row.symbol}</div>
            <div className="text-sm text-muted">{row.name}</div>
          </div>
          <button className="btn-3d rounded-lg border border-line px-3 py-1 text-sm" onClick={onClose}>Close</button>
        </div>

        <div className="mt-5 grid grid-cols-3 gap-3">
          <Card label="NAV" value={usd(row.navUsd)} sub={row.navUpdatedAt ? `updated ${ago(Date.parse(row.navUpdatedAt))}` : undefined} />
          <Card label="DEX" value={usd(row.dexUsd)} sub={row.dexId ?? undefined} />
          <Card label="vs NAV" value={pct(row.premiumBps)} tone={premiumClass(row.premiumBps)} />
        </div>

        <h3 className="mt-6 text-sm font-semibold text-muted">Last 24 hours</h3>
        <div className="mt-2 rounded-xl border border-line bg-panel2 p-3">
          {detail ? <Sparkline points={detail.history} /> : <div className="text-sm text-muted">{err ?? 'Loading…'}</div>}
        </div>

        <h3 className="mt-6 text-sm font-semibold text-muted">What to watch</h3>
        <ul className="mt-2 space-y-2 text-sm">
          {row.flags.length === 0 && <li className="text-up">No risk flags.</li>}
          {row.flags.map((f) => (
            <li key={f} className="rounded-lg bg-panel2 px-3 py-2">{FLAG_TEXT[f] ?? f}</li>
          ))}
          {!row.alertable && row.notAlertableReasons.length > 0 && (
            <li className="text-xs text-muted">No public alerts for this token right now: {row.notAlertableReasons.join('; ')}.</li>
          )}
        </ul>

        <h3 className="mt-6 text-sm font-semibold text-muted">Details</h3>
        <dl className="mt-2 grid grid-cols-2 gap-y-1 text-sm">
          <dt className="text-muted">Contract</dt>
          <dd><a className="text-accent underline" href={baseAddr(row.address)} target="_blank" rel="noreferrer">{short(row.address)}</a></dd>
          <dt className="text-muted">Pool liquidity</dt><dd className="tnum">{compact(row.liquidityUsd)}</dd>
          <dt className="text-muted">24h DEX volume</dt><dd className="tnum">{compact(row.volume24hUsd)}</dd>
          <dt className="text-muted">Multiplier</dt><dd className="tnum">{row.multiplier ?? '—'}</dd>
          <dt className="text-muted">On-chain breaker</dt>
          <dd>{row.onchain ? (row.onchain.breakerActive ? <span className="text-down">tripped{row.onchain.triggeredAt ? ` ${ago(row.onchain.triggeredAt * 1000)}` : ''}</span> : <span className="text-up">healthy</span>) : <span className="text-muted">not registered</span>}</dd>
          {row.pairUrl && (<><dt className="text-muted">Pool</dt><dd><a className="text-accent underline" href={row.pairUrl} target="_blank" rel="noreferrer">DexScreener</a></dd></>)}
        </dl>

        {detail && detail.onchain.length > 0 && (
          <>
            <h3 className="mt-6 text-sm font-semibold text-muted">On-chain (Base Sepolia)</h3>
            <ul className="mt-2 space-y-1 text-sm">
              {detail.onchain.map((e) => (
                <li key={e.txHash} className="flex justify-between gap-2">
                  <EventKind e={e} />
                  <a className="text-accent underline tnum" href={sepoliaTx(e.txHash)} target="_blank" rel="noreferrer">{short(e.txHash)} · {ago(e.at)}</a>
                </li>
              ))}
            </ul>
          </>
        )}

        <div className="mt-6 rounded-xl border border-line p-4">
          <div className="text-sm font-semibold">Record this check on-chain</div>
          <p className="mt-1 text-xs text-muted">
            Signs a StockGuardRegistry.publishAttestation() on {attestConfig.chainName} with your wallet. Record-only: it cannot change
            the official status or trip the breaker.
          </p>
          <button
            disabled={busy || row.navUsd === null || row.dexUsd === null}
            className="btn-3d mt-3 rounded-lg bg-accent px-4 py-2 text-sm font-semibold text-onfill disabled:opacity-40"
            onClick={onAttest}
          >
            {busy ? 'Waiting for wallet…' : 'Sign attestation'}
          </button>
          {attest && <p className="mt-2 break-all text-xs">{attest}</p>}
        </div>
      </aside>
    </div>
  );
}

// ------------------------------------------------------------------ token checker
function Checker() {
  const [addr, setAddr] = useState('');
  const [res, setRes] = useState<ScanResult | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  async function go() {
    setBusy(true);
    setErr(null);
    setRes(null);
    try {
      setRes(await scanAddress(addr.trim()));
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Check failed');
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="rounded-xl border border-line bg-panel p-5">
      <h2 className="text-lg font-semibold">Is this token the real one?</h2>
      <p className="mt-1 text-sm text-muted">Paste a Base token address. We check it against the official Coinbase tokenized-stock list.</p>
      <div className="mt-3 flex gap-2">
        <input
          value={addr}
          onChange={(e) => setAddr(e.target.value)}
          placeholder="0x…"
          className="min-w-0 flex-1 rounded-lg border border-line bg-panel2 px-3 py-2 font-num text-sm outline-none focus:border-accent"
        />
        <button disabled={busy || !/^0x[0-9a-fA-F]{40}$/.test(addr.trim())} onClick={go} className="btn-3d rounded-lg bg-accent px-4 py-2 text-sm font-semibold text-onfill disabled:opacity-40">
          {busy ? 'Checking…' : 'Check'}
        </button>
      </div>
      {err && <p className="mt-3 text-sm text-down">{err}</p>}
      {res && (
        <div className={`mt-3 rounded-lg p-3 text-sm ${res.verdict === 'OFFICIAL' ? 'bg-up/10' : 'bg-down/10'}`}>
          {res.verdict === 'OFFICIAL' ? (
            <>
              <b className="text-up">Official:</b> {res.symbol} — {res.name}
              {res.result && <> · {pct(res.result.depegBps)} from NAV · grade {res.result.grade}</>}
            </>
          ) : (
            <><b className="text-down">Not official.</b> {res.message}</>
          )}
        </div>
      )}
    </section>
  );
}

// ------------------------------------------------------------------ main
export default function App() {
  const [board, setBoard] = useState<Board | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [onchain, setOnchain] = useState<OnchainInfo | null>(null);
  const [agent, setAgent] = useState<{ status: string; payment: { network: string; price: string } | null } | null>(null);
  const [open, setOpen] = useState<string | null>(() => decodeURIComponent(window.location.hash.slice(1)) || null);
  const [query, setQuery] = useState('');
  const [onlyFlagged, setOnlyFlagged] = useState(false);

  const load = useCallback(async () => {
    try {
      setBoard(await fetchBoard());
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'API unreachable');
    }
    fetchOnchain().then(setOnchain).catch(() => undefined);
  }, []);

  useEffect(() => {
    load();
    fetchAgentInfo().then(setAgent).catch(() => undefined);
    const t = setInterval(load, REFRESH_MS);
    return () => clearInterval(t);
  }, [load]);

  useEffect(() => {
    const onHash = () => setOpen(decodeURIComponent(window.location.hash.slice(1)) || null);
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);

  const select = (s: string | null) => {
    window.location.hash = s ? encodeURIComponent(s) : '';
    setOpen(s);
  };

  const rows = useMemo(() => {
    const q = query.trim().toLowerCase();
    return (board?.rows ?? []).filter(
      (r) => (!q || r.symbol.toLowerCase().includes(q) || r.name.toLowerCase().includes(q)) && (!onlyFlagged || Math.abs(r.premiumBps ?? 0) >= 50),
    );
  }, [board, query, onlyFlagged]);

  const breakerEvents = (onchain?.events ?? []).filter((e) => e.kind === 'BREAKER_TRIPPED' || e.kind === 'DRILL' || e.kind === 'REPORT').slice(0, 8);
  const worst = board?.summary.worst;

  return (
    <div className="mx-auto max-w-6xl px-4 pb-16">
      <header className="flex flex-wrap items-center justify-between gap-3 py-6">
        <div>
          <div className="text-xl font-bold">StockGuard</div>
          <div className="text-sm text-muted">Is your tokenized stock trading at its real price?</div>
        </div>
        <div className="flex items-center gap-3 text-sm">
          {board && (
            <span className="flex items-center gap-2 rounded-full border border-line px-3 py-1">
              <span className={`hb-dot inline-block h-2 w-2 rounded-full ${board.stale ? 'bg-warn' : 'bg-up'}`} />
              {board.stale ? 'data delayed' : 'live'} · {ago(board.generatedAt)}
            </span>
          )}
          {board && <span className="rounded-full border border-line px-3 py-1">US market {board.marketClosed ? 'closed' : 'open'}</span>}
          {TELEGRAM_URL && <a href={TELEGRAM_URL} target="_blank" rel="noreferrer" className="btn-3d rounded-full bg-accent px-3 py-1 font-semibold text-onfill">Get alerts</a>}
        </div>
      </header>

      {error && (
        <div className="mb-4 rounded-xl border border-warn/40 bg-warn/10 p-4 text-sm">
          {error}
          <div className="mt-1 text-xs text-muted">Running locally? Start everything with <code>npm run dev</code>.</div>
        </div>
      )}

      {board && (
        <>
          <section className="grid grid-cols-2 gap-3 md:grid-cols-4">
            <Card label="Tokenized stocks" value={String(board.summary.total)} sub="official Coinbase list on Base" />
            <Card label="With a DEX price" value={String(board.summary.quoted)} sub="deepest Base pool" />
            <Card label="Widest gap" value={worst ? pct(worst.premiumBps) : '—'} sub={worst?.symbol} tone={premiumClass(worst?.premiumBps ?? null)} />
            <Card label="Alert threshold" value="±2.00%" sub="confirmed on 2 checks" />
          </section>

          <section className="mt-6 rounded-xl border border-line bg-panel">
            <div className="flex flex-wrap items-center justify-between gap-3 border-b border-line p-4">
              <h2 className="text-lg font-semibold">NAV vs DEX — live board</h2>
              <div className="flex items-center gap-3 text-sm">
                <label className="flex items-center gap-1 text-muted">
                  <input type="checkbox" checked={onlyFlagged} onChange={(e) => setOnlyFlagged(e.target.checked)} /> gaps ≥ 0.5%
                </label>
                <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search" className="w-36 rounded-lg border border-line bg-panel2 px-3 py-1 outline-none focus:border-accent" />
              </div>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="text-left text-xs uppercase text-muted">
                  <tr>
                    <th className="px-4 py-2">Stock</th>
                    <th className="px-4 py-2 text-right">NAV</th>
                    <th className="px-4 py-2 text-right">DEX</th>
                    <th className="px-4 py-2 text-right">vs NAV</th>
                    <th className="px-4 py-2 text-right">Liquidity</th>
                    <th className="px-4 py-2">Grade</th>
                    <th className="px-4 py-2">Notes</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r) => (
                    <tr key={r.address} className="cursor-pointer border-t border-line hover:bg-panel2" onClick={() => select(r.symbol)}>
                      <td className="px-4 py-2"><div className="font-semibold">{r.symbol}<BreakerBadge row={r} /></div><div className="text-xs text-muted">{r.name}</div></td>
                      <td className="px-4 py-2 text-right tnum">{usd(r.navUsd)}</td>
                      <td className="px-4 py-2 text-right tnum">{usd(r.dexUsd)}</td>
                      <td className={`px-4 py-2 text-right tnum ${premiumClass(r.premiumBps)}`}>{pct(r.premiumBps)}</td>
                      <td className="px-4 py-2 text-right tnum">{compact(r.liquidityUsd)}</td>
                      <td className="px-4 py-2"><GradeBadge g={r.grade} /></td>
                      <td className="px-4 py-2 text-xs text-muted">
                        {r.status === 'NO_DEX_QUOTE' ? 'no Base pool' : r.status === 'NO_NAV' ? 'no NAV' : r.flags.includes('THIN_DEX_LIQUIDITY_UNDER_50K') ? 'thin pool' : r.flags.includes('NAV_BASIS_UNVERIFIED') ? 'multiplier ≠ 1' : ''}
                      </td>
                    </tr>
                  ))}
                  {rows.length === 0 && (
                    <tr><td colSpan={7} className="px-4 py-8 text-center text-muted">{board.summary.total === 0 ? `Official list unavailable: ${board.sources.registry.error ?? 'no data'}` : 'No matches.'}</td></tr>
                  )}
                </tbody>
              </table>
            </div>
            <div className="border-t border-line px-4 py-2 text-xs text-muted">
              NAV: Coinbase Tokenized Stocks API (Chainlink-based reference, frozen outside US market hours). DEX: DexScreener, deepest Base pool. {board.sources.dex.errors.length > 0 && `DEX source errors: ${board.sources.dex.errors.length}.`}
            </div>
          </section>
        </>
      )}

      <div className="mt-6 grid gap-6 md:grid-cols-2">
        <Checker />

        <section className="rounded-xl border border-line bg-panel p-5">
          <h2 className="text-lg font-semibold">Circuit breaker (Reactive Network)</h2>
          <p className="mt-1 text-sm text-muted">
            A confirmed depeg is reported to our registry on Base Sepolia. A Reactive contract on Lasna sees the event and calls the
            breaker back on Base — no keeper bot in the loop.
          </p>
          {onchain?.registry ? (
            <ul className="mt-3 space-y-1 text-sm">
              {breakerEvents.length === 0 && <li className="text-muted">No reports yet.</li>}
              {breakerEvents.map((e) => (
                <li key={e.txHash} className="flex justify-between gap-2">
                  <span>{e.symbol} · <EventKind e={e} /></span>
                  <a className="text-accent underline tnum" href={sepoliaTx(e.txHash)} target="_blank" rel="noreferrer">{short(e.txHash)} · {ago(e.at)}</a>
                </li>
              ))}
            </ul>
          ) : (
            <p className="mt-3 text-sm text-muted">On-chain mirror not configured on this server.</p>
          )}
        </section>

        <section className="rounded-xl border border-line bg-panel p-5 md:col-span-2">
          <h2 className="text-lg font-semibold">For agents: pay-per-check API (x402)</h2>
          <p className="mt-1 text-sm text-muted">
            Trading agents can call one endpoint before acting on a tokenized stock and pay per request in USDC — no API key, no account.
            Status: {agent ? (agent.payment ? `live · ${agent.payment.price} on ${agent.payment.network}` : agent.status) : '…'}
          </p>
          <pre className="mt-3 overflow-x-auto rounded-lg bg-panel2 p-3 text-xs">{`curl -i ${apiUrl('/api/agent/risk?symbol=AAPLc')}
# → 402 Payment Required with x402 payment requirements;
#   pay with any x402 client (e.g. @x402/fetch) and retry.`}</pre>
        </section>
      </div>

      <footer className="mt-10 space-y-2 text-xs text-muted">
        <p>{board?.disclaimer ?? 'Market-integrity data only. Not trading or investment advice. Coinbase tokenized stocks are not offered to US persons.'}</p>
        <p>
          StockGuard does not trade, route orders or hold funds. Open source.
          {X_URL && <> · <a className="underline" href={X_URL} target="_blank" rel="noreferrer">Build log on X</a></>}
        </p>
      </footer>

      {open && board && board.rows.some((r) => r.symbol === open) && <AssetPanel symbol={open} board={board} onClose={() => select(null)} />}
    </div>
  );
}
