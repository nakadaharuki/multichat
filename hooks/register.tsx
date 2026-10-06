// tandem: run several Claude Code chats side by side without them getting in each other's way.
//
// Parallel chats share four things, and this mod looks after each, with nothing to switch:
// - the plan's usage limits: the band says where the week and the 5 hours will land at this pace
// - the files: before an edit, it asks when another open chat changed the same file in the last 30 minutes
// - the PC: a heavy command (install, build, test) waits while two other chats already run one
// - the repository: commands that throw away work (rm -rf, force push, reset --hard, clean -f) are refused,
//   and keys, emails and IPs in what Claude reads are swapped for placeholders (./redact.ts)
//
// The chats meet in $.store, which every session of this plugin on this PC shares: each chat writes
// only its own key (chat:<session id>) with a heartbeat, its label, the files it changed and the heavy
// command it runs. No network, no files, no programs.

import type { EngineInterface, Register, ToolCallResult } from 'claude-code'

type Next = (e: never) => Promise<ToolCallResult<string>>
import { cleanForce, commandsOf, forcePush, heavyKind, resetHard, rmRecursiveForce } from './guard'
import type { Shell } from './guard'
import { hiddenCount, makeConfig, restore, scrubPii, scrubSecrets, walk } from './redact'

// Ray Amjad's secret-redactor (MIT, ./redact.ts) with its defaults: secrets, emails and public IPs
// become [REDACTED-…] placeholders in what Claude reads, and go back to the real value in tool inputs
const cfg = makeConfig({})
const scrub = (text: string) => scrubPii(scrubSecrets(text, cfg), cfg)

const MIN = 60_000
const HOUR = 60 * MIN
const PANE = 'tandem'
const LIVE_MS = 2 * MIN // a chat whose heartbeat is older than this is closed
const BEAT_MS = 30_000
const RECENT_MS = 30 * MIN // another chat's edit this recent counts
const HEAVY_AT_ONCE = 2 // heavy commands that may run at once across chats
const HOLDS = 3 // after this many holds in 10 minutes a command goes through anyway
const WINDOWS: Record<string, number> = { seven_day: 7 * 24 * HOUR, five_hour: 5 * HOUR }

// ---- words ----

const MESSAGES = {
  en: {
    cmd: 'Open the tandem pane: usage, the chats running side by side, and what was held or refused',
    week: 'Week',
    fiveHour: '5h',
    context: 'Context',
    atReset: '→ {pct}% by reset',
    over: 'runs out {when} before reset',
    chats: '{n} chats',
    heavy: '{n} building',
    clash: '{file} also changed in "{other}"',
    details: 'Details',
    noUsage: 'Usage shows after the first reply',
    askEdit: '"{other}" changed {file} {ago} ago. Edit it here too?',
    edit: 'Edit anyway',
    cancel: 'Cancel',
    cancelled: 'The user stopped this edit: another open chat ("{other}") changed {file} {ago} ago. Tell the user, and ask before touching the file again.',
    held: 'Held back: {n} other chats are already running heavy work ({kinds}) on this PC. Run this command again in 1 to 2 minutes, or do lighter work first.',
    refused: 'tandem refused this: {what}. If it is really needed, ask the user to run it themselves.',
    what: { 'rm-rf': 'rm -rf deletes a whole tree', 'force-push': 'a force push overwrites the remote', 'reset-hard': 'reset --hard throws away uncommitted work (other chats\' too)', 'clean-force': 'clean -f deletes untracked files (other chats\' too)' },
    ago: (m: number) => (m < 1 ? 'under a minute' : m < 60 ? `${m} min` : `${Math.floor(m / 60)} h`),
    left: (ms: number) => (ms >= 24 * HOUR ? `${Math.round(ms / (24 * HOUR))} d` : ms >= HOUR ? `${Math.round(ms / HOUR)} h` : `${Math.max(1, Math.round(ms / MIN))} min`),
    paneUsage: 'Usage',
    paneChats: 'Chats on this PC',
    paneLog: 'Held and refused in this chat',
    resets: 'resets in {left}',
    thisChat: 'this chat',
    idle: 'idle',
    working: 'working',
    files: '{n} files changed',
    none: 'Nothing yet',
    untitled: 'new chat',
    hid: 'hid {n} secret value(s) from Claude',
    hidPrompt: 'hid {n} secret value(s) from the prompt',
  },
  ja: {
    cmd: 'tandem の欄を開く: 使用量・並行して動くチャット・止めたこと',
    week: '週',
    fiveHour: '5時間',
    context: '文脈',
    atReset: '→ リセット時 {pct}%',
    over: 'リセットの {when} 前に尽きる',
    chats: '並行 {n}',
    heavy: '重い処理 {n}',
    clash: '{file} を「{other}」も変更',
    details: '詳しく',
    noUsage: '使用量は最初の返事の後に出ます',
    askEdit: '「{other}」が {ago}前に {file} を変更しました。ここでも編集しますか？',
    edit: '編集する',
    cancel: 'やめる',
    cancelled: '利用者がこの編集を止めました。開いている別のチャット（「{other}」）が {ago}前に {file} を変更しています。利用者に伝え、このファイルに触る前に確かめてください。',
    held: '待ってもらいました: この PC で別のチャット {n} 本が重い処理（{kinds}）を走らせています。1〜2 分後にこのコマンドをもう一度走らせるか、先に軽い作業をしてください。',
    refused: 'tandem が止めました: {what}。どうしても要るなら、利用者に自分で走らせてもらってください。',
    what: { 'rm-rf': 'rm -rf は木ごと消す', 'force-push': '強制 push は遠くの履歴を上書きする', 'reset-hard': 'reset --hard は書きかけ（別のチャットの分も）を捨てる', 'clean-force': 'clean -f は追跡していないファイル（別のチャットの分も）を消す' },
    ago: (m: number) => (m < 1 ? '1分以内' : m < 60 ? `${m}分` : `${Math.floor(m / 60)}時間`),
    left: (ms: number) => (ms >= 24 * HOUR ? `${Math.round(ms / (24 * HOUR))}日` : ms >= HOUR ? `${Math.round(ms / HOUR)}時間` : `${Math.max(1, Math.round(ms / MIN))}分`),
    paneUsage: '使用量',
    paneChats: 'この PC のチャット',
    paneLog: 'この会話で止めたこと',
    resets: 'リセットまで {left}',
    thisChat: 'この会話',
    idle: '待機',
    working: '作業中',
    files: '変更 {n} 件',
    none: 'まだありません',
    untitled: '新しいチャット',
    hid: '秘密の値を {n} 個伏せました',
    hidPrompt: 'プロンプトの秘密の値を {n} 個伏せました',
  },
}
type Lang = keyof typeof MESSAGES
type Words = (typeof MESSAGES)['en']
let lang: Lang = 'en'
const w = (): Words => MESSAGES[lang] as Words
const t = (key: keyof Words, params: Record<string, string | number> = {}) =>
  String(w()[key]).replace(/\{(\w+)\}/g, (_, k) => String(params[k] ?? ''))
// Claude Code's language setting: "japanese", "日本語", "ja-JP" → ja; anything else → en
const pickLang = (setting: unknown): Lang => (typeof setting === 'string' && /^(ja\b|ja[-_]|japanese|日本)/i.test(setting.trim()) ? 'ja' : 'en')

// ---- the shared ledger ----

type Chat = { id: string; label: string; root: string; at: number; busy: boolean; heavy: string | null; files: Record<string, number> }
type Limit = { kind: string; pct: number; resetsAt: number | null; proj: number | null; runsOutIn: number | null }
type LogLine = { at: number; text: string }

const me: Chat = { id: '', label: '', root: '', at: 0, busy: false, heavy: null, files: {} }
let others: Chat[] = []
let limits: Limit[] = []
let context: number | null = null
let log: LogLine[] = []
let lastNow = 0 // the clock at the last tick: drawing reads it (a render hook does not wait on the clock)
const holds: number[] = []
const allowed = new Map<string, number>() // file → the other chat's edit time already said yes to

const norm = (p: string) => p.replace(/\\/g, '/').replace(/^([a-z]):/, (_, d) => `${d.toUpperCase()}:`)
const base = (p: string) => p.split('/').filter(Boolean).pop() ?? p
const short = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s)
const labelOf = (c: Chat) => c.label || base(c.root) || t('untitled')

async function save($: EngineInterface, now: number) {
  lastNow = Math.max(lastNow, now)
  me.at = now
  for (const [f, at] of Object.entries(me.files)) if (now - at > RECENT_MS) delete me.files[f]
  if (me.id) await $.store.set(`chat:${me.id}`, me)
}

async function readOthers($: EngineInterface, now: number) {
  lastNow = now
  const list: Chat[] = []
  for (const key of await $.store.keys()) {
    if (!key.startsWith('chat:') || key === `chat:${me.id}`) continue
    const c = (await $.store.get(key)) as Chat | undefined
    if (!c || typeof c.at !== 'number') continue
    // a chat closed for a day is cleared, so the store does not grow
    if (now - c.at > 24 * HOUR) await $.store.delete(key)
    else if (now - c.at <= LIVE_MS) list.push(c)
  }
  others = list
}

// Where the window lands at this pace: used so far over the time gone, across the whole window
function project(kind: string, pct: number, resetsAt: number | null, now: number): Limit {
  const span = WINDOWS[kind]
  if (!span || resetsAt === null) return { kind, pct, resetsAt, proj: null, runsOutIn: null }
  const gone = span - (resetsAt - now)
  // too early in the window to say anything (the first 5% of it)
  if (gone < span * 0.05 || pct <= 0) return { kind, pct, resetsAt, proj: null, runsOutIn: null }
  const rate = pct / gone
  const proj = Math.round(pct + rate * (resetsAt - now))
  const runsOutIn = proj > 100 ? (100 - pct) / rate : null // from now until the window is used up
  return { kind, pct, resetsAt, proj, runsOutIn }
}

async function measure($: EngineInterface, now: number) {
  try {
    const u = await $.session.usage()
    context = typeof u.context?.percent === 'number' ? Math.round(u.context.percent) : null
    limits = u.rateLimits
      .filter(r => r.kind in WINDOWS)
      .map(r => project(r.kind, r.percentUsed, r.resetsAt ? Date.parse(r.resetsAt) : null, now))
  } catch {
    // no usage where nothing measures it (claude -p)
  }
}

async function tick($: EngineInterface) {
  const now = await $.clock.now()
  await measure($, now)
  await save($, now)
  await readOthers($, now)
  $.ui.invalidate('ui.render')
}

const note = async ($: EngineInterface, text: string) => {
  log = [...log, { at: await $.clock.now(), text }].slice(-30)
  $.ui.invalidate('ui.render')
}

// ---- guards ----

const REFUSE: [keyof Words['what'], (words: string[]) => boolean][] = [
  ['rm-rf', rmRecursiveForce],
  ['force-push', forcePush],
  ['reset-hard', resetHard],
  ['clean-force', cleanForce],
]

async function shell($: EngineInterface, e: { command?: string }, next: Next, kind: Shell) {
  const commands = commandsOf(String(e.command ?? ''), kind)
  const hit = REFUSE.find(([, test]) => commands.some(test))
  if (hit) {
    const what = w().what[hit[0]]
    await note($, what)
    return { deny: t('refused', { what }) }
  }
  const heavy = commands.map(heavyKind).find(Boolean) ?? null
  if (!heavy) return next(e as never)
  const now = await $.clock.now()
  await readOthers($, now)
  const busy = others.filter(c => c.heavy)
  while (holds.length && now - (holds[0] ?? now) > 10 * MIN) holds.shift()
  if (busy.length >= HEAVY_AT_ONCE && holds.length < HOLDS) {
    holds.push(now)
    const kinds = busy.map(c => c.heavy).join(', ')
    await note($, `${heavy} — ${t('heavy', { n: busy.length })}`)
    return { deny: t('held', { n: busy.length, kinds }) }
  }
  me.heavy = heavy
  await save($, now)
  try {
    return await next(e as never)
  } finally {
    me.heavy = null
    await save($, await $.clock.now())
  }
}

async function edit($: EngineInterface, file: string, e: unknown, next: Next) {
  const path = norm(file)
  const now = await $.clock.now()
  await readOthers($, now)
  const clash = others
    .map(c => ({ c, at: c.files?.[path] }))
    .filter((x): x is { c: Chat; at: number } => typeof x.at === 'number' && now - x.at <= RECENT_MS)
    .sort((a, b) => b.at - a.at)[0]
  if (clash && allowed.get(path) !== clash.at) {
    const params = { other: short(labelOf(clash.c), 40), file: base(path), ago: w().ago(Math.floor((now - clash.at) / MIN)) }
    let answer = ''
    try {
      answer = await $.ui.ask(t('askEdit', params), { header: 'tandem', options: [t('edit'), t('cancel')] })
    } catch {
      // nobody to ask, or the dialog was closed: do not edit
    }
    if (answer !== t('edit')) {
      await note($, `${base(path)} — ${t('cancel')}`)
      return { deny: t('cancelled', params) }
    }
    allowed.set(path, clash.at)
  }
  const r = await next(e as never)
  if (r.deny === undefined && !r.isError) {
    me.files[path] = await $.clock.now()
    await save($, me.files[path])
  }
  return r
}

// ---- drawing ----

function usageParts(): { text: string; color?: string }[] {
  const parts: { text: string; color?: string }[] = []
  for (const kind of ['seven_day', 'five_hour']) {
    const l = limits.find(x => x.kind === kind)
    if (!l) continue
    const name = kind === 'seven_day' ? t('week') : t('fiveHour')
    let text = `${name} ${Math.round(l.pct)}%`
    let color: string | undefined
    if (l.proj !== null && kind === 'seven_day') text += ` ${t('atReset', { pct: l.proj })}`
    if (l.runsOutIn !== null && l.resetsAt !== null) {
      text += ` (${t('over', { when: w().left(Math.max(0, l.resetsAt - lastNow - l.runsOutIn)) })})`
      color = 'red'
    } else if ((l.proj ?? l.pct) >= 85) color = 'yellow'
    parts.push({ text, color })
  }
  if (context !== null) parts.push({ text: `${t('context')} ${context}%`, color: context >= 80 ? 'yellow' : undefined })
  return parts
}

function clashLine(): string | null {
  const now = lastNow
  for (const [f, at] of Object.entries(me.files)) {
    if (now - at > RECENT_MS) continue
    const other = others.find(c => typeof c.files?.[f] === 'number' && now - c.files[f] <= RECENT_MS)
    if (other) return t('clash', { file: base(f), other: short(labelOf(other), 24) })
  }
  return null
}

export const register: Register = on => {

  on('session.start', async ($, e, next) => {
    const started = await next(e)
    lang = pickLang(((await $.settings.read().catch(() => ({}))) as { language?: unknown })?.language)
    me.id = await $.session.id()
    me.root = norm(await $.session.root())
    const mine = (await $.store.get(`chat:${me.id}`)) as Chat | undefined
    if (mine) Object.assign(me, { label: mine.label, files: mine.files ?? {} })
    $.clock.every(BEAT_MS, () => void tick($))
    await tick($)
    try {
      await $.command.register({ name: 'tandem', description: t('cmd'), immediate: true })
    } catch {
      // already registered by the load before a hot reload
    }
    return started
  })

  // the chat's label in the other chats: its first prompt, cut short
  // (a pasted key never reaches the model as itself, nor the label)
  on('prompt.submit', async ($, e, next) => {
    const before = hiddenCount()
    const text = scrub(e.text)
    if (hiddenCount() > before) $.ui.toast(t('hidPrompt', { n: hiddenCount() - before }))
    if (!me.label) me.label = short(text.replace(/\s+/g, ' ').trim(), 48)
    me.busy = true
    await save($, await $.clock.now())
    return next({ ...e, text })
  })

  // what a tool reads back: where a secret usually arrives (a cat of .env, a Read of a config)
  on('tool.call', async ($, e, next) => {
    const r = await next(walk({ ...e }, restore) as typeof e)
    if (r.deny !== undefined) return r
    const before = hiddenCount()
    const result = walk(r.result, scrub)
    const text = r.text === undefined ? undefined : scrub(r.text)
    if (hiddenCount() === before) return r
    $.ui.notice(e.tool_use_id, t('hid', { n: hiddenCount() - before }))
    if (r.isError) return { isError: true as const, result, text, context: r.context }
    return { result, context: r.context }
  })

  // the blocks on the first message (CLAUDE.md and friends): secrets only, the user's own email stays
  on('prompt.context', async ($, e, next) => {
    const r = await next(e)
    return { blocks: r.blocks.map(b => ({ ...b, text: scrubSecrets(b.text, cfg) })) }
  })

  on('turn.complete', async ($, e, next) => {
    if (e.agentId === undefined) {
      me.busy = false
      await tick($)
    }
    return next(e)
  })

  on('session.measure', async ($, e, next) => {
    await measure($, await $.clock.now())
    $.ui.invalidate('ui.render')
    return next(e)
  })

  on('tool.call', { tool: 'Bash' }, ($, e, next) => shell($, e, next as never, 'bash'))
  on('tool.call', { tool: 'PowerShell' }, ($, e, next) => shell($, e, next as never, 'powershell'))
  on('tool.call', { tool: 'Edit' }, ($, e, next) => edit($, e.file_path, e, next as never))
  on('tool.call', { tool: 'Write' }, ($, e, next) => edit($, e.file_path, e, next as never))
  on('tool.call', { tool: 'NotebookEdit' }, ($, e, next) => edit($, e.notebook_path, e, next as never))

  on('command.run', { command: 'tandem' }, async $ => {
    await $.ui.open({ id: PANE, title: 'tandem' })
    return { text: '' }
  })

  // the band: one line, everything that matters across the chats
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey) return next(e)
    const { Box, Text, Button } = $.ui.resolve(e)
    const parts = usageParts()
    const live = others.length + 1
    const heavy = others.filter(c => c.heavy).length + (me.heavy ? 1 : 0)
    if (live > 1) parts.push({ text: t('chats', { n: live }) })
    if (heavy > 0) parts.push({ text: t('heavy', { n: heavy }), color: heavy >= HEAVY_AT_ONCE ? 'yellow' : undefined })
    const clash = clashLine()
    if (clash) parts.push({ text: clash, color: 'yellow' })
    if (!parts.length) return next(e)
    const line = parts.map((p, i) => (
      <Text color={p.color} dimColor={!p.color}>
        {i ? ' · ' : ''}
        {p.text}
      </Text>
    ))
    // the desktop app has room for the button that opens the pane; the terminal has /tandem
    if (e.surface === 'desktop') {
      return (
        <Box flexDirection="row" alignItems="center">
          <Box flexGrow={1} flexDirection="row" flexWrap="wrap">
            {line}
          </Box>
          <Button key="tandem-open" label={t('details')} onPress={() => void $.ui.open({ id: PANE, title: 'tandem' })} />
        </Box>
      )
    }
    return <Box flexDirection="row" flexWrap="wrap">{line}</Box>
  })

  // the pane: the same three things in full
  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text } = $.ui.resolve(e)
    const now = lastNow
    const bar = (pct: number) => {
      const n = Math.max(0, Math.min(20, Math.round(pct / 5)))
      return '█'.repeat(n) + '░'.repeat(20 - n)
    }
    const chats = [me, ...others]
    const gap = e.surface === 'desktop' ? 1 : 0
    return (
      <Box flexDirection="column" gap={gap}>
        <Box flexDirection="column">
          <Text bold>{t('paneUsage')}</Text>
          {limits.length === 0 && context === null && <Text dimColor>{t('noUsage')}</Text>}
          {limits.map(l => (
            <Text color={l.runsOutIn !== null ? 'red' : undefined}>
              {(l.kind === 'seven_day' ? t('week') : t('fiveHour')).padEnd(5)} {bar(l.pct)} {Math.round(l.pct)}%
              {l.proj !== null ? ` ${t('atReset', { pct: l.proj })}` : ''}
              {l.resetsAt !== null ? `  ${t('resets', { left: w().left(l.resetsAt - now) })}` : ''}
            </Text>
          ))}
          {context !== null && (
            <Text>
              {t('context').padEnd(5)} {bar(context)} {context}%
            </Text>
          )}
        </Box>
        <Box flexDirection="column">
          <Text bold>{t('paneChats')}</Text>
          {chats.map(c => (
            <Text dimColor={!c.busy && !c.heavy}>
              {c === me ? `${t('thisChat')} · ` : ''}
              {short(labelOf(c), 48)} · {c.heavy ?? (c.busy ? t('working') : t('idle'))} · {t('files', { n: Object.keys(c.files ?? {}).length })}
            </Text>
          ))}
        </Box>
        <Box flexDirection="column">
          <Text bold>{t('paneLog')}</Text>
          {log.length === 0 && <Text dimColor>{t('none')}</Text>}
          {log
            .slice(-8)
            .reverse()
            .map(l => (
              <Text dimColor>
                {w().ago(Math.floor((now - l.at) / MIN))} · {l.text}
              </Text>
            ))}
        </Box>
      </Box>
    )
  })
}
