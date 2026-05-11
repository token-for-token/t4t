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

export interface LayoutOpts {
  title: string
  refreshSeconds: number
  body: string
  active: 'jobs' | 'status' | 'models'
}

export function layout(opts: LayoutOpts): string {
  const tab = (id: LayoutOpts['active'], href: string, label: string) =>
    `<a href="${href}" class="${opts.active === id ? 'active' : ''}">${label}</a>`
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
    .kv{display:grid;grid-template-columns:max-content 1fr;gap:6px 16px;font-size:13px}
    .kv dt{color:#666}
    .kv dd{margin:0;font-family:ui-monospace,SFMono-Regular,Menlo,monospace}
    .ok{color:#262}
    .warn{color:#a60}
    .err{color:#a22}
    .muted{color:#888}
    .grid2{display:grid;grid-template-columns:repeat(2,1fr);gap:16px}
    @media(max-width:800px){.grid2{grid-template-columns:1fr}}
  </style>
</head>
<body>
  <header>
    <h1>${escape(opts.title)}</h1>
    <nav>
      ${tab('jobs', '/admin', 'Jobs')}
      ${tab('status', '/admin/status', 'Status')}
      ${opts.active === 'models' ? tab('models', '/admin/models', 'Models') : ''}
    </nav>
  </header>
  <main hx-target="this" hx-swap="innerHTML">
    ${opts.body}
  </main>
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

export function formatXBZZ(weiStr: string | bigint | null | undefined): string {
  if (weiStr === null || weiStr === undefined) return '—'
  const wei = typeof weiStr === 'bigint' ? weiStr : BigInt(weiStr)
  const whole = wei / 10n ** 18n
  const frac = wei % 10n ** 18n
  if (frac === 0n) return `${whole}`
  const fracStr = (frac + 10n ** 18n).toString().slice(1).replace(/0+$/, '')
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
