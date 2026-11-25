import { useCallback, useEffect, useMemo, useState } from 'react';
import { apiUrl, fetchAgentInfo, fetchAsset, fetchBoard, fetchOnchain, scanAddress } from './lib/api';
import { attestConfig, publishAttestation, rowReportHash, toE8 } from './lib/attest';
import type { AssetDetail, Board, BoardRow, OnchainEvent, OnchainInfo, ScanResult } from './lib/types';

const TELEGRAM_URL = import.meta.env.VITE_TELEGRAM_URL;
const X_URL = import.meta.env.VITE_X_URL;
const GITHUB_URL = 'https://github.com/kailog-dev/stockguard';
const DEMO_URL = 'https://youtu.be/do4QAVhfTRM';
const REFRESH_MS = 30_000;
const FAKE_ADDRESS = '0x000000000000000000000000000000000000dEaD';

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
const agoShort = (t: number) => {
  const s = Math.max(0, Math.round((Date.now() - t) / 1000));
  return s < 60 ? `${s}s` : s < 3600 ? `${Math.round(s / 60)}m` : s < 172_800 ? `${Math.floor(s / 3600)}h` : `${Math.floor(s / 86_400)}d`;
};
const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;
const sepoliaTx = (h: string) => `https://sepolia.basescan.org/tx/${h}`;
const sepoliaAddr = (a: string) => `https://sepolia.basescan.org/address/${a}`;
const lasnaAddr = (a: string) => `https://lasna.reactscan.net/address/${a}`;
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

function BrandMark() {
  return (
    <svg viewBox="0 0 40 40" className="h-9 w-9 shrink-0" aria-hidden="true">
      <rect x="0.5" y="0.5" width="39" height="39" rx="9" fill="#10141B" stroke="#262C36" />
      <g transform="translate(4 4) scale(0.2667)">
        <path d="M60 14 L94 26 V54 C94 77 79 93 60 102 C41 93 26 77 26 54 V26 Z" fill="none" stroke="#F5C451" strokeWidth={7} strokeLinejoin="round" />
        <path d="M14 60 H40 L47 47 L55 73 L64 40 L71 60 H106" fill="none" stroke="#F5C451" strokeWidth={7} strokeLinecap="round" strokeLinejoin="round" />
        <circle cx="64" cy="30" r="5.5" fill="#F04438" />
      </g>
    </svg>
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

const EVENT_PILL: Record<OnchainEvent['kind'], [string, string, string]> = {
  BREAKER_TRIPPED: ['BREAKER TRIPPED', 'bg-down/15 text-down', 'Circuit breaker tripped on Base Sepolia by the Reactive sentinel'],
  BREAKER_CLEARED: ['CLEARED', 'bg-up/15 text-up', 'Gap back under 1% — breaker cleared'],
  DRILL: ['DRILL', 'bg-warn/15 text-warn', 'Fire drill with a synthetic price (testnet)'],
  REPORT: ['REPORT', 'bg-panel2 text-muted', 'Confirmed market report written to the registry'],
  REGISTER: ['REGISTERED', 'bg-panel2 text-muted', 'Asset registered in the registry'],
  HEARTBEAT: ['HEARTBEAT', 'bg-panel2 text-muted', 'Periodic market report'],
};

function EventKind({ e }: { e: OnchainEvent }) {
  const [label, cls, title] = EVENT_PILL[e.kind];
  return (
    <span title={title} className={`inline-block shrink-0 rounded px-1.5 py-0.5 text-[10px] font-semibold tracking-wide ${cls}`}>
      {label}
    </span>
  );
}

function EventItem({ e, withSymbol }: { e: OnchainEvent; withSymbol?: boolean }) {
  return (
    <li className="flex items-center justify-between gap-2 py-1">
      <span className="flex min-w-0 items-center gap-2">
        {withSymbol && <span className="font-semibold">{e.symbol}</span>}
        <EventKind e={e} />
        {typeof e.depegBps === 'number' && e.kind !== 'BREAKER_CLEARED' && <span className="tnum text-xs text-muted">{(e.depegBps / 100).toFixed(2)}%</span>}
      </span>
      <a className="shrink-0 whitespace-nowrap text-accent underline tnum" href={sepoliaTx(e.txHash)} target="_blank" rel="noreferrer">
        {short(e.txHash)} · {agoShort(e.at)}
      </a>
    </li>
  );
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
            <ul className="mt-2 text-sm">
              {detail.onchain.map((e) => (
                <EventItem key={e.txHash} e={e} />
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
function Checker({ samples, onOpen }: { samples: { label: string; address: string }[]; onOpen: (symbol: string) => void }) {
  const [addr, setAddr] = useState('');
  const [res, setRes] = useState<ScanResult | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  async function go(target = addr) {
    setBusy(true);
    setErr(null);
    setRes(null);
    try {
      setRes(await scanAddress(target.trim()));
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
        <button disabled={busy || !/^0x[0-9a-fA-F]{40}$/.test(addr.trim())} onClick={() => go()} className="btn-3d rounded-lg bg-accent px-4 py-2 text-sm font-semibold text-onfill disabled:opacity-40">
          {busy ? 'Checking…' : 'Check'}
        </button>
      </div>
      {samples.length > 0 && (
        <div className="mt-2 flex flex-wrap items-center gap-2 text-xs">
          <span className="text-muted">Try:</span>
          {samples.map((s) => (
            <button
              key={s.address}
              disabled={busy}
              onClick={() => {
                setAddr(s.address);
                go(s.address);
              }}
              className="rounded-full border border-line bg-panel2 px-2.5 py-1 hover:border-accent disabled:opacity-40"
            >
              {s.label}
            </button>
          ))}
        </div>
      )}
      {err && <p className="mt-3 text-sm text-down">{err}</p>}
      {res && (
        <div className={`mt-3 rounded-lg p-3 text-sm ${res.verdict === 'OFFICIAL' ? 'bg-up/10' : 'bg-down/10'}`}>
          {res.verdict === 'OFFICIAL' ? (
            <>
              <b className="text-up">Official:</b> {res.symbol} — {res.name}
              {res.result && <> · {pct(res.result.depegBps)} from NAV · grade {res.result.grade}</>}
              {res.symbol && (
                <button onClick={() => onOpen(res.symbol as string)} className="ml-2 font-semibold text-accent underline">
                  Open chart →
                </button>
              )}
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
  const [quotedOnly, setQuotedOnly] = useState(true);
  const [copied, setCopied] = useState(false);

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
      (r) =>
        (!q || r.symbol.toLowerCase().includes(q) || r.name.toLowerCase().includes(q)) &&
        (!quotedOnly || r.dexUsd !== null) &&
        (!onlyFlagged || Math.abs(r.premiumBps ?? 0) >= 50),
    );
  }, [board, query, onlyFlagged, quotedOnly]);

  const breakerEvents = (onchain?.events ?? [])
    .filter((e) => e.kind === 'BREAKER_TRIPPED' || e.kind === 'BREAKER_CLEARED' || e.kind === 'DRILL' || e.kind === 'REPORT')
    .slice(0, 8);
  const worst = board?.summary.worst;

  const samples = useMemo(() => {
    const pick = ['MSTRc', 'NVDAc']
      .map((s) => board?.rows.find((r) => r.symbol === s))
      .filter((r): r is BoardRow => Boolean(r))
      .map((r) => ({ label: r.symbol, address: r.address as string }));
    return [...pick, { label: 'Fake 0x…dEaD', address: FAKE_ADDRESS }];
  }, [board]);

  const curlText = `curl -i ${apiUrl('/api/agent/risk?symbol=AAPLc')}
# → 402 Payment Required with x402 payment requirements;
#   pay with any x402 client (e.g. @x402/fetch) and retry.`;
  async function copyCurl() {
    try {
      await navigator.clipboard.writeText(curlText.split('\n')[0]);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard blocked: the text is still selectable */
    }
  }

  return (
    <div className="mx-auto max-w-6xl px-4 pb-16">
      <header className="flex flex-wrap items-center justify-between gap-3 py-6">
        <div className="flex items-center gap-3">
          <BrandMark />
          <div>
            <div className="flex items-center gap-2">
              <span className="text-xl font-bold leading-tight">StockGuard</span>
              <span className="rounded-md border border-line bg-panel2 px-1.5 py-0.5 text-[11px] font-medium text-muted">Base</span>
            </div>
            <div className="text-sm text-muted">Is your tokenized stock trading at its real price?</div>
          </div>
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
                  <input type="checkbox" checked={quotedOnly} onChange={(e) => setQuotedOnly(e.target.checked)} /> with a DEX pool
                </label>
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
                    <th className="w-6 px-2 py-2" aria-hidden="true" />
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
                      <td className="px-2 py-2 text-right text-muted" title="24h chart and on-chain status">›</td>
                    </tr>
                  ))}
                  {rows.length === 0 && (
                    <tr>
                      <td colSpan={8} className="px-4 py-8 text-center text-muted">
                        {board.summary.total === 0 ? (
                          `Official list unavailable: ${board.sources.registry.error ?? 'no data'}`
                        ) : onlyFlagged && !query.trim() ? (
                          <>
                            All {board.summary.quoted} quoted pools are currently within ±0.5% of NAV (normal market).
                            <button onClick={() => setOnlyFlagged(false)} className="ml-2 font-semibold text-accent underline">
                              Show all {board.summary.quoted} quoted pools
                            </button>
                          </>
                        ) : quotedOnly ? (
                          <>
                            No token with a DEX pool matches.
                            <button onClick={() => setQuotedOnly(false)} className="ml-2 font-semibold text-accent underline">
                              Search all {board.summary.total} tokens
                            </button>
                          </>
                        ) : (
                          'No matches.'
                        )}
                      </td>
                    </tr>
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
        <Checker samples={samples} onOpen={(s) => select(s)} />

        <section className="rounded-xl border border-line bg-panel p-5">
          <h2 className="text-lg font-semibold">Circuit breaker (Reactive Network)</h2>
          <p className="mt-1 text-sm text-muted">
            A confirmed depeg is reported to our registry on Base Sepolia. A Reactive contract on Lasna sees the event and calls the
            breaker back on Base — no keeper bot in the loop.
          </p>
          {onchain?.registry ? (
            <>
              <ul className="mt-3 text-sm">
                {breakerEvents.length === 0 && <li className="text-muted">No reports yet.</li>}
                {breakerEvents.map((e) => (
                  <EventItem key={e.txHash} e={e} withSymbol />
                ))}
              </ul>
              <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1 border-t border-line pt-3 text-xs">
                <a className="text-accent underline" href={sepoliaAddr(onchain.registry)} target="_blank" rel="noreferrer">Registry · Base Sepolia</a>
                {onchain.sentinel && (
                  <a className="text-accent underline" href={lasnaAddr(onchain.sentinel)} target="_blank" rel="noreferrer">Sentinel · Reactive Lasna</a>
                )}
                <span className="text-muted">source-verified on Sourcify</span>
              </div>
            </>
          ) : (
            <p className="mt-3 text-sm text-muted">On-chain mirror not configured on this server.</p>
          )}
        </section>

        <section className="rounded-xl border border-line bg-panel p-5 md:col-span-2">
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="text-lg font-semibold">For agents: pay-per-check API (x402)</h2>
            {agent?.payment ? (
              <span className="rounded-full bg-up/15 px-2 py-0.5 text-xs font-semibold text-up">live · {agent.payment.price} · {agent.payment.network}</span>
            ) : (
              <span className="rounded-full bg-panel2 px-2 py-0.5 text-xs text-muted">{agent ? agent.status : '…'}</span>
            )}
          </div>
          <p className="mt-1 text-sm text-muted">
            Trading agents can call one endpoint before acting on a tokenized stock and pay per request in USDC — no API key, no account.
          </p>
          <div className="relative mt-3">
            <pre className="overflow-x-auto rounded-lg bg-panel2 p-3 pr-20 text-xs">{curlText}</pre>
            <button onClick={copyCurl} className="btn-3d absolute right-2 top-2 rounded-md border border-line bg-panel px-2 py-1 text-xs">
              {copied ? 'Copied' : 'Copy'}
            </button>
          </div>
        </section>
      </div>

      <footer className="mt-10 space-y-2 text-xs text-muted">
        <p>{board?.disclaimer ?? 'Market-integrity data only. Not trading or investment advice. Coinbase tokenized stocks are not offered to US persons.'}</p>
        <p>StockGuard does not trade, route orders or hold funds. Open source (MIT).</p>
        <nav className="flex flex-wrap gap-x-4 gap-y-1">
          <a className="underline" href={GITHUB_URL} target="_blank" rel="noreferrer">GitHub</a>
          <a className="underline" href={DEMO_URL} target="_blank" rel="noreferrer">Demo video</a>
          {X_URL && <a className="underline" href={X_URL} target="_blank" rel="noreferrer">Build log on X</a>}
          {TELEGRAM_URL && <a className="underline" href={TELEGRAM_URL} target="_blank" rel="noreferrer">Telegram alerts</a>}
          {onchain?.registry && <a className="underline" href={sepoliaAddr(onchain.registry)} target="_blank" rel="noreferrer">Base Sepolia registry</a>}
          {onchain?.sentinel && <a className="underline" href={lasnaAddr(onchain.sentinel)} target="_blank" rel="noreferrer">Reactive Lasna sentinel</a>}
        </nav>
      </footer>

      {open && board && board.rows.some((r) => r.symbol === open) && <AssetPanel symbol={open} board={board} onClose={() => select(null)} />}
    </div>
  );
}
