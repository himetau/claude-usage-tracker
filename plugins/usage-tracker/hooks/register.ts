import type { EngineInterface, Register, SessionRateLimit } from 'claude-code'

// What one POST /v1/usage body holds. `turn` rows carry this machine's token
// counts; both kinds carry the account-wide limit readings seen at that time.
type Limit = { kind: string; pct: number; resetsAt?: string }
type Sample = {
  v: 1
  kind: 'turn' | 'limits'
  ts: string
  name?: string
  session?: string
  agent?: boolean
  model?: string
  input?: number
  output?: number
  cache_read?: number
  cache_write?: number
  limits: Limit[]
}
type Row = { received_at: string; client: string; data: Sample }

const QUEUE_KEY = 'queue'
const QUEUE_MAX = 2000
const FLUSH_MS = 15_000
const WINDOWS: Record<string, number> = { five_hour: 5 * 3600e3, seven_day: 7 * 86400e3 }

type Server = { url: string; token: string }

let flushing = false
let lastError: string | undefined

function toLimits(rl: SessionRateLimit[]): Limit[] {
  return rl.map(r => ({ kind: r.kind, pct: r.percentUsed, resetsAt: r.resetsAt }))
}

async function readQueue($: EngineInterface): Promise<Sample[]> {
  return ((await $.store.get(QUEUE_KEY)) as Sample[] | undefined) ?? []
}

async function enqueue($: EngineInterface, sample: Sample) {
  const queue = await readQueue($)
  queue.push(sample)
  await $.store.set(QUEUE_KEY, queue.slice(-QUEUE_MAX))
}

// Sends queued samples oldest first; stops at the first failure and keeps
// the rest for the next tick, so an offline server loses nothing.
async function flush($: EngineInterface, server: Server) {
  if (flushing) return
  flushing = true
  try {
    for (let queue = await readQueue($); queue.length > 0; queue = await readQueue($)) {
      const res = await $.http.fetch(`${server.url}/v1/usage`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${server.token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(queue[0]),
      })
      // A 400 is a sample the server will never take: drop it, don't retry forever.
      if (!res.ok && res.status !== 400) {
        lastError = `server answered ${res.status}`
        break
      }
      lastError = undefined
      await $.store.set(QUEUE_KEY, (await readQueue($)).slice(1))
    }
  } catch (err) {
    lastError = err instanceof Error ? err.message : String(err)
  } finally {
    flushing = false
  }
}

function showStatus($: EngineInterface, limits: Limit[]) {
  const parts = [
    ['five_hour', '5h'],
    ['seven_day', '7d'],
  ].flatMap(([kind, label]) => {
    const l = limits.find(x => x.kind === kind)
    return l ? [`${label} ${l.pct}%`] : []
  })
  if (parts.length === 0) return
  $.ui.status(parts.join(' · ') + (lastError ? ' · sync ⚠' : ''))
}

export const register: Register = (on, options) => {
  const serverUrl = String(options.server_url ?? '').replace(/\/+$/, '')
  const token = String(options.access_token ?? '')
  const name = String(options.display_name ?? '').trim() || undefined
  const isConfigured = serverUrl !== '' && token !== ''
  const server: Server = { url: serverUrl, token }

  on('session.start', async ($, e, next) => {
    const started = await next(e)
    await $.command.register({
      name: 'usage-report',
      description: 'Show your share of the account 5h and weekly limits vs the other people on it.',
    })
    if (!isConfigured) {
      $.ui.toast('usage-tracker: set server URL and access token in /config to start reporting.')
      return started
    }
    $.clock.every(FLUSH_MS, () => void flush($, server))
    void flush($, server)
    return started
  })

  on('turn.complete', async ($, e, next) => {
    const done = await next(e)
    if (!isConfigured || !e.usage) return done
    const u = e.usage
    const { rateLimits } = await $.session.usage()
    await enqueue($, {
      v: 1,
      kind: 'turn',
      ts: new Date(await $.clock.now()).toISOString(),
      name,
      session: await $.session.id(),
      agent: e.agentId !== undefined,
      model: u.model,
      input: u.input_tokens,
      output: u.output_tokens,
      cache_read: u.cache_read_input_tokens,
      cache_write: u.cache_creation_input_tokens,
      limits: toLimits(rateLimits),
    })
    return done
  })

  // Limit readings also move while you are idle and someone else is working:
  // record each whole-point move so the report can see the other usage.
  on('session.measure', async ($, e, next) => {
    const done = await next(e)
    const limits = toLimits(e.rateLimits)
    showStatus($, limits)
    if (isConfigured && e.changed.includes('rateLimits') && limits.length > 0) {
      await enqueue($, {
        v: 1,
        kind: 'limits',
        ts: new Date(await $.clock.now()).toISOString(),
        name,
        session: await $.session.id(),
        limits,
      })
    }
    return done
  })

  on('command.run', { command: 'usage-report' }, async $ => {
    if (!isConfigured) return { text: 'usage-tracker is not configured: set its server URL and access token in /config.' }
    await flush($, server)
    const res = await $.http.fetch(`${serverUrl}/v1/usage`, {
      headers: { Authorization: `Bearer ${token}` },
    })
    if (!res.ok) return { text: `Could not read usage from the server (HTTP ${res.status}).` }
    const rows = res.text
      .split('\n')
      .filter(l => l.trim() !== '')
      .flatMap(l => {
        try {
          const r = JSON.parse(l) as Row
          return r.data?.v === 1 ? [r] : []
        } catch {
          return []
        }
      })
    const me = await clientId(token)
    const pending = (await readQueue($)).length
    return { text: report(rows, me, await $.clock.now(), pending) }
  })
}

// The server labels each row with the first 8 hex chars of sha256(token).
async function clientId(token: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token))
  return [...new Uint8Array(digest).slice(0, 4)].map(b => b.toString(16).padStart(2, '0')).join('')
}

// Limits are spent roughly in proportion to cost, so tokens are weighted by
// approximate relative price (model tier, output vs input, cache reads cheap).
function weight(s: Sample): number {
  const m = (s.model ?? '').toLowerCase()
  const tier = m.includes('opus') ? 5 : m.includes('haiku') ? 1 : 3
  return tier * ((s.input ?? 0) + 1.25 * (s.cache_write ?? 0) + 0.1 * (s.cache_read ?? 0) + 5 * (s.output ?? 0))
}

const ts = (r: Row) => Date.parse(r.data.ts || r.received_at)

function report(rows: Row[], me: string, now: number, pending: number): string {
  rows.sort((a, b) => ts(a) - ts(b))
  const names = new Map<string, string>()
  for (const r of rows) if (r.data.name) names.set(r.client, r.data.name)
  const label = (c: string) => (c === me ? `you${names.get(c) ? ` (${names.get(c)})` : ''}` : names.get(c) ?? `client ${c}`)

  const out: string[] = []
  for (const [kind, span] of Object.entries(WINDOWS)) {
    const latest = [...rows].reverse().map(r => r.data.limits.find(l => l.kind === kind)).find(Boolean)
    const title = kind === 'five_hour' ? '5-hour window' : 'Weekly window'
    if (!latest) {
      out.push(`${title}: no limit readings yet.`)
      continue
    }
    const resetsAt = latest.resetsAt ? Date.parse(latest.resetsAt) : now
    const start = resetsAt - span
    const inWindow = rows.filter(r => r.data.kind === 'turn' && ts(r) >= start)

    const used = new Map<string, number>()
    for (const r of inWindow) used.set(r.client, (used.get(r.client) ?? 0) + weight(r.data))
    const total = [...used.values()].reduce((a, b) => a + b, 0)

    // Calibrate %-per-weighted-token from stretches where only one client
    // reported tokens between two readings of the same window.
    const rate = calibrate(rows, kind)
    const share = new Map<string, number>()
    let method: string
    if (rate !== undefined) {
      for (const [c, w] of used) share.set(c, w * rate)
      const sum = [...share.values()].reduce((a, b) => a + b, 0)
      if (sum > latest.pct && sum > 0) for (const [c, v] of share) share.set(c, (v * latest.pct) / sum)
      method = 'calibrated from solo periods'
    } else {
      for (const [c, w] of used) share.set(c, total > 0 ? (w / total) * latest.pct : 0)
      method = 'no solo periods yet: split by token share, assumes no untracked use'
    }
    const attributed = [...share.values()].reduce((a, b) => a + b, 0)

    const reset = latest.resetsAt ? `, resets ${new Date(resetsAt).toISOString().replace('T', ' ').slice(0, 16)} UTC` : ''
    out.push(`${title}: account at ${latest.pct}%${reset}`)
    const clients = [...new Set([me, ...used.keys()])]
    for (const c of clients) {
      const tokens = inWindow.filter(r => r.client === c).reduce((a, r) => a + (r.data.input ?? 0) + (r.data.output ?? 0) + (r.data.cache_read ?? 0) + (r.data.cache_write ?? 0), 0)
      out.push(`  ${label(c).padEnd(24)} ~${(share.get(c) ?? 0).toFixed(1).padStart(5)}%   ${fmt(tokens)} tokens`)
    }
    out.push(`  ${'untracked (chat, other)'.padEnd(24)} ~${Math.max(0, latest.pct - attributed).toFixed(1).padStart(5)}%`)
    out.push(`  (${method})`)
    out.push('')
  }
  if (pending > 0) out.push(`${pending} sample(s) from this machine not yet delivered to the server.`)
  return out.join('\n').trimEnd()
}

function calibrate(rows: Row[], kind: string): number | undefined {
  let sumPct = 0
  let sumW = 0
  let prev: Limit | undefined
  let tokens = new Map<string, number>()
  for (const r of rows) {
    if (r.data.kind === 'turn') tokens.set(r.client, (tokens.get(r.client) ?? 0) + weight(r.data))
    const l = r.data.limits.find(x => x.kind === kind)
    if (!l) continue
    if (prev && prev.resetsAt === l.resetsAt) {
      const delta = l.pct - prev.pct
      const active = [...tokens.entries()].filter(([, w]) => w > 0)
      if (delta >= 0 && active.length === 1) {
        sumPct += delta
        sumW += active[0]![1]
      }
    }
    prev = l
    tokens = new Map()
  }
  // Need a few whole points of movement before the rate means anything.
  return sumPct >= 3 && sumW > 0 ? sumPct / sumW : undefined
}

function fmt(n: number): string {
  return n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(0)}k` : String(n)
}
