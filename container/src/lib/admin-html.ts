/**
 * Tiny, dependency-free HTML helpers for the admin UI. HTMX is included via
 * unpkg in the layout — no SPA build step, no client framework.
 */

export function escape(s: unknown): string {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

export type TabId = 'jobs' | 'status' | 'models' | 'providers' | 'wallet'
export interface NavTab {
  id: TabId
  href: string
  label: string
}

/** Default tab set for the provider admin (no "Providers" — provider doesn't
 *  serve a market-listing page). */
export const PROVIDER_TABS: NavTab[] = [
  {id: 'jobs', href: '/', label: 'Jobs'},
  {id: 'models', href: '/models', label: 'Models'},
  {id: 'wallet', href: '/wallet', label: 'Wallet'},
  {id: 'status', href: '/status', label: 'Status'},
]

/** Default tab set for the client admin (includes "Providers" market view). */
export const CLIENT_TABS: NavTab[] = [
  {id: 'jobs', href: '/', label: 'Jobs'},
  {id: 'models', href: '/models', label: 'Models'},
  {id: 'providers', href: '/providers', label: 'Providers'},
  {id: 'wallet', href: '/wallet', label: 'Wallet'},
  {id: 'status', href: '/status', label: 'Status'},
]

export interface LayoutOpts {
  title: string
  refreshSeconds: number
  body: string
  active: TabId
  /** Tabs to render in the nav. Falls back to CLIENT_TABS for backwards
   *  compatibility with callers that haven't been updated yet. */
  tabs?: NavTab[]
}

export function layout(opts: LayoutOpts): string {
  const tabs = opts.tabs ?? CLIENT_TABS
  const tab = (t: NavTab) =>
    `<a href="${t.href}" class="${opts.active === t.id ? 'active' : ''}">${escape(t.label)}</a>`
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>${escape(opts.title)}</title>
  <script src="https://unpkg.com/htmx.org@1.9.12" integrity="sha384-ujb1lZYygJmzgSwoxRggbCHcjc0rB2XoQrxeTUQyRjrOnlCoYta87iKBWq3EsdM2" crossorigin="anonymous"></script>
  <style>
    body{font:14px/1.4 system-ui,sans-serif;margin:0;background:#fafafa;color:#222}
    header{background:#111;color:#eee;padding:12px 24px;display:flex;gap:24px;align-items:center}
    header h1{margin:0;font-size:16px;font-weight:600}
    header nav a{color:#bbb;text-decoration:none;margin-right:16px}
    header nav a.active{color:#fff;border-bottom:2px solid #fff}
    main{padding:24px;max-width:1200px;margin:0 auto}
    section{background:#fff;padding:16px;border-radius:6px;margin-bottom:16px;box-shadow:0 1px 2px rgba(0,0,0,.05)}
    h2{margin:0 0 12px;font-size:15px}
    table{width:100%;border-collapse:collapse;font-size:13px}
    th,td{text-align:left;padding:6px 8px;border-bottom:1px solid #eee;vertical-align:top}
    th{background:#f5f5f5;font-weight:600;font-size:12px;text-transform:uppercase;letter-spacing:.5px;color:#555}
    .mono{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12px}
    .pill{display:inline-block;padding:2px 8px;border-radius:10px;font-size:11px;font-weight:600;text-transform:uppercase}
    .pill-queued{background:#eef;color:#447}
    .pill-running{background:#fef6e0;color:#7a5}
    .pill-delivered{background:#e6f4ff;color:#157}
    .pill-claimed{background:#e8f7ec;color:#262}
    .pill-failed{background:#fde8e8;color:#a22}
    .pill-posted{background:#eef;color:#447}
    .pill-acked{background:#fef6e0;color:#7a5}
    .pill-cancelled{background:#fde8e8;color:#a22}
    .pill-timed_out{background:#fde8e8;color:#a22}
    .kv{display:grid;grid-template-columns:max-content 1fr;gap:6px 16px;font-size:13px}
    .kv dt{color:#666}
    .kv dd{margin:0;font-family:ui-monospace,SFMono-Regular,Menlo,monospace}
    .ok{color:#262}
    .warn{color:#a60}
    .err{color:#a22}
    .muted{color:#888}
    .grid2{display:grid;grid-template-columns:repeat(2,1fr);gap:16px}
    @media(max-width:800px){.grid2{grid-template-columns:1fr}}
    textarea,input[type=text]{width:100%;font:13px ui-monospace,SFMono-Regular,Menlo,monospace;padding:8px;border:1px solid #ccc;border-radius:4px;box-sizing:border-box}
    button{font:inherit;padding:6px 14px;border:1px solid #444;background:#222;color:#fff;border-radius:4px;cursor:pointer;margin-top:8px}
    button:hover{background:#000}
    .mnemonic{padding:14px;background:#fafaf0;border:1px solid #d9c27e;border-radius:4px;font-size:14px;line-height:1.8;margin:8px 0 12px;word-spacing:8px}
    label.inline{display:flex;align-items:center;gap:8px;margin:8px 0;font-size:13px;color:#555}
    .toast-stack{position:fixed;top:16px;right:16px;display:flex;flex-direction:column;gap:8px;z-index:1000;pointer-events:none}
    .toast{background:#222;color:#fff;padding:10px 14px;border-radius:6px;box-shadow:0 4px 12px rgba(0,0,0,.25);min-width:280px;font-size:13px;pointer-events:auto;animation:toastIn .2s ease-out}
    .toast a{color:#9ec6ff;text-decoration:underline}
    .toast .kind{font-weight:600;display:block;margin-bottom:2px}
    .toast .hash,.toast .note{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12px;color:#bbb}
    @keyframes toastIn{from{transform:translateX(24px);opacity:0}to{transform:translateX(0);opacity:1}}
  </style>
</head>
<body>
  <header>
    <h1>${escape(opts.title)}</h1>
    <nav>
      ${tabs.map(tab).join('\n      ')}
    </nav>
  </header>
  <main hx-target="this" hx-swap="innerHTML">
    ${opts.body}
  </main>
  <div class="toast-stack" id="toast-stack"></div>
  <script>
  (() => {
    if (window.__t4tToastInit) return; window.__t4tToastInit = true;
    const stack = document.getElementById('toast-stack');
    // Start "now" so we don't replay the entire on-chain history on page load.
    let since = Math.floor(Date.now() / 1000);
    function shorthex(h){ return h && h.length > 12 ? h.slice(0,8) + '…' + h.slice(-4) : (h||''); }
    function show(t){
      const div = document.createElement('div');
      div.className = 'toast';
      div.innerHTML =
        '<span class="kind">⛓ ' + t.kind + '</span>' +
        '<a class="hash" href="https://gnosisscan.io/tx/' + t.hash + '" target="_blank" rel="noopener">' + shorthex(t.hash) + '</a>' +
        (t.note ? '<div class="note">' + t.note.replace(/[<>&]/g, '') + '</div>' : '');
      stack.appendChild(div);
      setTimeout(() => { div.style.transition='opacity .3s'; div.style.opacity='0'; }, 5500);
      setTimeout(() => div.remove(), 6000);
    }
    async function poll(){
      try {
        const r = await fetch('/events/tx?since=' + since, {cache:'no-store'});
        if (r.ok) {
          const d = await r.json();
          // listTransactions returns DESC; render oldest first so toasts stack chronologically.
          for (const t of (d.txs || []).slice().reverse()) show(t);
          since = d.now || since;
        }
      } catch {}
      setTimeout(poll, 3000);
    }
    poll();
  })();
  </script>
</body>
</html>`
}

export function statusPill(status: string): string {
  return `<span class="pill pill-${escape(status)}">${escape(status)}</span>`
}

export function shortHex(h: string, len = 10): string {
  if (!h) return ''
  return h.length <= len + 2 ? h : `${h.slice(0, 6)}…${h.slice(-4)}`
}

// xBZZ has 16 decimals on Gnosis (NOT 18). Also used for xDAI/wei display below
// even though xDAI is 18 — this is a quick approximation acceptable for the
// admin UI's "rough balance" view, not for financial calculations.
const XBZZ_DECIMALS = 16n
export function formatXBZZ(weiStr: string | bigint | null | undefined): string {
  if (weiStr === null || weiStr === undefined) return '—'
  const wei = typeof weiStr === 'bigint' ? weiStr : BigInt(weiStr)
  const scale = 10n ** XBZZ_DECIMALS
  const whole = wei / scale
  const frac = wei % scale
  if (frac === 0n) return `${whole}`
  const fracStr = (frac + scale).toString().slice(1).replace(/0+$/, '')
  return `${whole}.${fracStr.slice(0, 6)}`
}

export function formatTs(ts: number | null | undefined): string {
  if (!ts) return '—'
  return new Date(ts * 1000).toISOString().replace('T', ' ').slice(0, 19)
}

export function formatDuration(start: number | null, end: number | null): string {
  if (!start || !end) return '—'
  const s = end - start
  if (s < 60) return `${s}s`
  if (s < 3600) return `${Math.floor(s / 60)}m${s % 60}s`
  return `${Math.floor(s / 3600)}h${Math.floor((s % 3600) / 60)}m`
}
