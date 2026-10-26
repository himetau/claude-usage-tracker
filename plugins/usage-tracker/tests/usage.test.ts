import { expect, test } from 'claude-code/testing'

const OPTIONS = { server_url: 'https://usage.test/', access_token: 'tok-me', display_name: 'me' }
const RESET5 = '2026-10-26T20:00:00.000Z'
const RESET7 = '2026-10-31T00:00:00.000Z'

test('turns and limit moves reach the server; the report splits the window', { options: OPTIONS }, async ($, on) => {
  // Nothing sits beneath the plugin: these hooks stand for the engine and
  // a usage server holding one other person's rows.
  const store = new Map<string, unknown>()
  const posted: { auth: string; body: unknown }[] = []
  let now = Date.parse('2026-10-26T16:00:00.000Z')
  let limits = [
    { kind: 'five_hour', percentUsed: 10, resetsAt: RESET5 },
    { kind: 'seven_day', percentUsed: 30, resetsAt: RESET7 },
  ]
  const other = {
    received_at: '2026-10-26T15:30:00Z',
    client: 'abcd1234',
    data: { v: 1, kind: 'turn', ts: '2026-10-26T15:30:00Z', name: 'partner', model: 'claude-sonnet-5-5', input: 1000, output: 2000, cache_read: 0, cache_write: 0, limits: [] },
  }

  on('store.get', (_, e) => ({ value: store.get(e.key) }))
  on('store.set', (_, e) => (store.set(e.key, e.value), { value: undefined }))
  on('clock.now', () => ({ value: now }))
  on('clock.every', () => ({ value: undefined }))
  on('ui.status', () => ({ value: undefined }))
  on('session.id', () => ({ value: 'sess-1' }))
  on('session.usage', () => ({ value: { startedAt: now, context: { window: 200000 }, rateLimits: limits } }))
  on('command.register', () => ({ value: { command: 'usage-report' } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('session.measure', (_, e) => ({ changed: e.changed }))
  on('turn.complete', (_, e) => ({ text: e.answer }))
  on('http.fetch', (_, e) => {
    if (e.init?.method === 'POST') {
      posted.push({ auth: e.init.headers?.Authorization ?? '', body: JSON.parse(e.init.body ?? '{}') })
      return { value: { status: 204, ok: true, headers: {}, text: '' } }
    }
    const mine = posted.map(p => ({ received_at: '', client: 'ba34b3fe', data: p.body }))
    const text = [other, ...mine].map(r => JSON.stringify(r)).join('\n')
    return { value: { status: 200, ok: true, headers: {}, text } }
  })

  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })

  now += 60_000
  limits = [{ ...limits[0]!, percentUsed: 14 }, limits[1]!]
  await $.turn.complete({
    answer: 'hi', durationMs: 1000, isAborted: false, turnId: 't1', reason: 'completed',
    usage: { model: 'claude-opus-5-5', input_tokens: 500, output_tokens: 1500, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
  } as never)
  await $.session.measure({ context: { window: 200000 }, rateLimits: limits, changed: ['rateLimits'] } as never)

  const { text } = await $.command.run({ command: 'usage-report', args: '' })

  expect(posted.length).toBe(2)
  expect(posted[0]!.auth).toBe('Bearer tok-me')
  expect((posted[0]!.body as { kind: string; input: number }).kind).toBe('turn')
  expect(text).toContain('5-hour window: account at 14%')
  expect(text).toContain('you (me)')
  expect(text).toContain('partner')
  expect(store.get('queue')).toEqual([])
  console.log(text)
})

test('an unreachable server keeps samples queued', { options: OPTIONS }, async ($, on) => {
  const store = new Map<string, unknown>()
  on('store.get', (_, e) => ({ value: store.get(e.key) }))
  on('store.set', (_, e) => (store.set(e.key, e.value), { value: undefined }))
  on('clock.now', () => ({ value: 0 }))
  on('session.id', () => ({ value: 's' }))
  on('session.usage', () => ({ value: { startedAt: 0, context: { window: 1 }, rateLimits: [] } }))
  on('turn.complete', (_, e) => ({ text: e.answer }))
  on('http.fetch', () => ({ value: { status: 503, ok: false, headers: {}, text: '' } }))

  await $.turn.complete({
    answer: '', durationMs: 1, isAborted: false, turnId: 't', reason: 'completed',
    usage: { model: 'claude-haiku-5-5', input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
  } as never)
  const { text } = await $.command.run({ command: 'usage-report', args: '' })
  expect(text).toContain('HTTP 503')
  expect((store.get('queue') as unknown[]).length).toBe(1)
})

test('solo stretches calibrate the rate and leave untracked use visible', { options: OPTIONS }, async ($, on) => {
  const lim = (pct: number) => [{ kind: 'five_hour', pct, resetsAt: RESET5 }]
  const row = (client: string, at: string, data: object) =>
    JSON.stringify({ received_at: at, client, data: { v: 1, ts: at, ...data } })
  const rows = [
    row('ba34b3fe', '2026-10-26T16:00:00Z', { kind: 'limits', limits: lim(10) }),
    row('ba34b3fe', '2026-10-26T16:10:00Z', { kind: 'turn', model: 'claude-opus-5-5', input: 500, output: 1500, limits: lim(14) }),
    row('abcd1234', '2026-10-26T16:20:00Z', { kind: 'turn', name: 'partner', model: 'claude-sonnet-5-5', input: 1000, output: 2000, limits: [] }),
    row('ba34b3fe', '2026-10-26T16:30:00Z', { kind: 'limits', limits: lim(20) }),
    row('ba34b3fe', '2026-10-26T17:00:00Z', { kind: 'limits', limits: lim(30) }),
  ].join('\n')
  on('store.get', () => ({ value: undefined }))
  on('clock.now', () => ({ value: Date.parse('2026-10-26T17:00:00Z') }))
  on('http.fetch', () => ({ value: { status: 200, ok: true, headers: {}, text: rows } }))

  const { text } = await $.command.run({ command: 'usage-report', args: '' })
  console.log(text)
  expect(text).toContain('account at 30%')
  expect(text).toContain('calibrated from solo periods')
  expect(text).toMatch(/untracked \(chat, other\)\s+~ 20\.0%/)
})
