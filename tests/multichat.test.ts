import { expect, mock, test } from 'claude-code/testing'

import { commandsOf, heavyKind } from '../hooks/guard'

const NOW = 1_790_000_000_000
const MIN = 60_000
const DAY = 24 * 60 * MIN

const BAND = {
  plugin: 'multichat',
  component: 'AbovePrompt',
  viewport: { columns: 120, rows: 30 },
  props: { hasSurvey: false, isWorking: false, maxRows: 10, bodyColumns: 120 },
} as const

const PANE = {
  plugin: 'multichat',
  component: 'Pane',
  requestId: 'multichat',
  viewport: { columns: 100, rows: 30 },
  props: { title: 'multichat', isFocused: true, bodyColumns: 60, placement: 'inline', scroll: { offset: 0, bodyRows: 20 }, view: {} },
} as const

// another open chat in the same checkout: edited src/app.ts 4 minutes ago and runs a build
const other = (extra: object = {}) => ({
  id: 'other',
  label: 'Add rate limiting',
  root: 'C:/work',
  at: NOW - 20_000,
  busy: true,
  heavy: 'npm run build',
  files: { 'C:/work/src/app.ts': NOW - 4 * MIN },
  ...extra,
})

function boot(on: any, store: Map<string, unknown>, answer = 'Cancel') {
  const clock = mock.clock(on, { now: NOW })
  const asked: string[] = []
  on('store.get', (_: unknown, e: any) => ({ value: store.get(e.key) }))
  on('store.set', (_: unknown, e: any) => (store.set(e.key, e.value), { value: undefined }))
  on('store.delete', (_: unknown, e: any) => (store.delete(e.key), { value: undefined }))
  on('store.keys', () => ({ value: [...store.keys()] }))
  on('settings.read', () => ({ value: { language: 'english' } }))
  on('session.id', () => ({ value: 'me' }))
  on('session.root', () => ({ value: 'C:\\work' }))
  on('command.register', () => ({ value: undefined }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('session.start', () => ({ cwd: 'C:\work' }))
  on('ui.render', () => ({ type: 'Text', props: {}, children: ['engine'] }))
  on('session.usage', () => ({
    value: {
      startedAt: NOW - 30 * MIN,
      context: { tokens: 62_000, window: 200_000, percent: 31 },
      // 4 of 7 days gone and 70% used: 123% by reset, out about a day early
      rateLimits: [
        { kind: 'seven_day', percentUsed: 70, resetsAt: new Date(NOW + 3 * DAY).toISOString() },
        { kind: 'five_hour', percentUsed: 12, resetsAt: new Date(NOW + 4 * 60 * MIN).toISOString() },
      ],
    },
  }))
  on('tool.call', { tool: 'AskUserQuestion' }, (_: unknown, e: any) => {
    const q = e.questions[0]
    asked.push(q.question)
    return { result: { questions: e.questions, answers: { [q.question]: answer } } }
  })
  on('tool.call', () => ({ result: 'ok' }))
  return { clock, asked }
}

const start = ($: any) => $.session.start({ surface: 'desktop', isInteractive: true, cwd: 'C:\\work' })

test('the band: where the week lands, the chats, and a file two chats touch', async ($, on) => {
  const store = new Map<string, unknown>([['chat:other', other()]])
  boot(on, store, 'Edit anyway')
  await start($)
  await $.tool.call({ tool: 'Edit', file_path: 'C:\\work\\src\\app.ts', old_string: 'a', new_string: 'b' } as never)
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...BAND, surface })
    expect(await ui.find({ type: 'Text', text: /Week 70% → 123% by reset \(runs out 1 d before reset\)/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /5h 12%/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /Context 31%/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /2 chats/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /app\.ts also changed in "Add rate limiting"/ })).toBeDefined()
    expect(Boolean(await ui.find({ key: 'multichat-open' }))).toBe(surface === 'desktop')
    await ui.unmount()
  }
})

test('an edit to a file another chat just changed asks first, and Cancel stops it', async ($, on) => {
  const store = new Map<string, unknown>([['chat:other', other()]])
  const { asked } = boot(on, store, 'Cancel')
  await start($)
  const r: any = await $.tool.call({ tool: 'Edit', file_path: 'C:/work/src/app.ts', old_string: 'a', new_string: 'b' } as never)
  expect(asked[0]).toBe('"Add rate limiting" changed app.ts 4 min ago. Edit it here too?')
  expect(String(r.text ?? r.deny)).toContain('The user stopped this edit')
  // a file no other chat touched goes straight through and joins this chat's ledger
  const ok: any = await $.tool.call({ tool: 'Write', file_path: 'C:/work/src/other.ts', content: 'x' } as never)
  expect(ok.result).toBe('ok')
  expect(Object.keys((store.get('chat:me') as any).files)).toEqual(['C:/work/src/other.ts'])
})

test('a closed chat does not count', async ($, on) => {
  const store = new Map<string, unknown>([['chat:other', other({ at: NOW - 10 * MIN })]])
  const { asked } = boot(on, store)
  await start($)
  const r: any = await $.tool.call({ tool: 'Edit', file_path: 'C:/work/src/app.ts', old_string: 'a', new_string: 'b' } as never)
  expect(asked.length).toBe(0)
  expect(r.result).toBe('ok')
})

test('heavy work waits while two other chats build, and goes through after 3 holds', async ($, on) => {
  const store = new Map<string, unknown>([
    ['chat:other', other()],
    ['chat:third', other({ id: 'third', label: 'Fix tests', heavy: 'npm test' })],
  ])
  boot(on, store)
  await start($)
  for (let i = 0; i < 3; i++) {
    const held: any = await $.tool.call({ tool: 'Bash', command: 'npm install' } as never)
    expect(String(held.text ?? held.deny)).toContain('Held back: 2 other chats')
  }
  const ran: any = await $.tool.call({ tool: 'Bash', command: 'npm install' } as never)
  expect(ran.result).toBe('ok')
  // light commands never wait
  const light: any = await $.tool.call({ tool: 'Bash', command: 'git status' } as never)
  expect(light.result).toBe('ok')
})

test('commands that throw work away are refused, in bash and PowerShell', async ($, on) => {
  boot(on, new Map())
  await start($)
  for (const [tool, command] of [
    ['Bash', 'rm -rf build'],
    ['Bash', 'sudo -u root "rm" -r -f /tmp/x'],
    ['Bash', 'git -C app push --force origin main'],
    ['Bash', 'git reset --hard HEAD~1'],
    ['Bash', 'git clean -fd'],
    ['PowerShell', 'Remove-Item dist -Recurse -Force'],
  ]) {
    const r: any = await $.tool.call({ tool, command } as never)
    expect(String(r.text ?? r.deny)).toContain('multichat refused this')
  }
  const ok: any = await $.tool.call({ tool: 'Bash', command: 'rm build/old.log' } as never)
  expect(ok.result).toBe('ok')
})

test('a key read back from a tool reaches Claude as a placeholder', async ($, on) => {
  const store = new Map<string, unknown>()
  on('tool.call', { tool: 'Read' }, () => ({ result: 'API_KEY=' + 'sk_' + 'live_' + 'a8Fq2LmZ0pX7rT4wB9kY3nV6' }))
  boot(on, store)
  await start($)
  const r: any = await $.tool.call({ tool: 'Read', file_path: 'C:/work/.env' } as never)
  expect(String(r.result)).toMatch(/API_KEY=\[REDACTED-SECRET-[0-9a-f]{8}\]/)
})

test('the pane lists usage, chats and what was refused', async ($, on) => {
  const store = new Map<string, unknown>([['chat:other', other()]])
  boot(on, store)
  await start($)
  await $.tool.call({ tool: 'Bash', command: 'git push -f' } as never)
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    expect(await ui.find({ type: 'Text', text: /Week .* 70% → 123% by reset/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /Add rate limiting · npm run build · 1 files changed/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /a force push overwrites the remote/ })).toBeDefined()
    await ui.unmount()
  }
})

test('heavy work is told from light work by its words', () => {
  const kind = (c: string) => commandsOf(c, 'bash').map(heavyKind).find(Boolean) ?? null
  expect(kind('npm install')).toBe('npm install')
  expect(kind('cd app && pnpm run build:prod')).toBe('pnpm run build')
  expect(kind('yarn')).toBe('yarn install')
  expect(kind('npx tsc --noEmit')).toBe('tsc')
  expect(kind('tsc -p .')).toBe('tsc')
  expect(kind('cargo test')).toBe('cargo test')
  expect(kind('npm run dev')).toBe(null)
  expect(kind('git status')).toBe(null)
})
