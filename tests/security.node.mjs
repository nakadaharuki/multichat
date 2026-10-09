// Offline regression tests: dummy values, mocked tools, no shell execution.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { makeConfig, protectToolCall, protectToolResult, safeToolInput, scrubPii, scrubSecrets } from '../hooks/redact.ts'
import { commandsOf, cleanForce, forcePush, heavyKind, resetHard, rmRecursiveForce } from '../hooks/guard.ts'

const fake = 'sk-' + 'LocalFixtureOnly000000000000'
const cfg = makeConfig({})
const scrub = (text, parentKey) => scrubPii(scrubSecrets(text, cfg, parentKey), cfg)

test('no tool can turn a placeholder into a secret or persist the placeholder', async () => {
  const tag = scrub(fake)
  assert.match(tag, /^\[REDACTED-SECRET-[0-9a-f]+\]$/)
  for (const tool of ['Bash', 'PowerShell', 'Write', 'Edit', 'NotebookEdit', 'mcp__send', 'WebFetch']) {
    let calls = 0
    const r = await protectToolCall({ tool, data: { body: tag } }, async () => { calls++; return { result: 'sent' } }, scrub)
    assert.equal(calls, 0, tool)
    assert.equal(typeof r.deny, 'string')
    assert.equal(JSON.stringify(r).includes(fake), false)
  }
  // Legacy tags, foreign-session tags and placeholders used as JSON keys also fail closed.
  assert.equal(safeToolInput({ content: '[REDACTED-SECRET-deadbeef]' }), false)
  assert.equal(safeToolInput({ '[REDACTED-EMAIL-00000001]': 'value' }), false)
})

test('normal tool inputs reach the mocked tool as an inspected copy', async () => {
  const e = { tool: 'Write', file_path: 'notes.txt', content: 'ordinary text' }
  let received
  const r = await protectToolCall(e, async input => { received = input; return { result: 'ok', text: 'ok', context: { count: 1 } } }, scrub)
  assert.notEqual(received, e)
  assert.deepEqual(received, e)
  assert.deepEqual(r, { result: 'ok', text: 'ok', context: { count: 1 } })
})

test('structured JSON retains the named-secret context used by textual JSON', () => {
  // A dummy hex string that is hidden beside a credential name, not as a bare checksum.
  const hex = '1a2b3c4d5e6f7890a1b2c3d4e5f60789'
  assert.equal(scrub(hex), hex)
  assert.equal(scrub('token=' + hex).includes(hex), false)
  for (const key of ['token', 'API_TOKEN', 'password', 'secret', 'auth']) {
    const data = { data: { [key]: hex } }
    const textual = protectToolResult({ result: JSON.stringify(data) }, scrub)
    const structured = protectToolResult({ result: data }, scrub)
    assert.equal(JSON.stringify(textual).includes(hex), false, key + ': textual')
    assert.equal(JSON.stringify(structured).includes(hex), false, key + ': structured')
    assert.match(structured.result.data[key], /REDACTED-SECRET/)
  }
  assert.equal(protectToolResult({ result: { data: { checksum: hex } } }, scrub).result.data.checksum, hex)
  const array = protectToolResult({ result: { data: { token: [hex] } } }, scrub)
  assert.equal(JSON.stringify(array).includes(hex), false)
})

test('non-JSON properties never reach a tool, including hidden placeholders', async () => {
  const tag = '[REDACTED-SECRET-deadbeef]'
  const hidden = { tool: 'Write' }
  Object.defineProperty(hidden, 'content', { value: tag })
  const nested = { tool: 'Write', args: {} }
  Object.defineProperty(nested.args, 'content', { value: tag })
  const symbolic = { tool: 'Write', [Symbol('content')]: tag }
  let getterRan = false
  const accessor = { tool: 'Write' }
  Object.defineProperty(accessor, 'content', { get() { getterRan = true; return tag } })
  const array = ['safe']; Object.defineProperty(array, 'content', { value: tag })
  for (const e of [hidden, nested, symbolic, accessor, { tool: 'Write', args: array }]) {
    let calls = 0
    const r = await protectToolCall(e, async input => { calls++; return { result: input.content } }, scrub)
    assert.equal(calls, 0)
    assert.equal(typeof r.deny, 'string')
    assert.equal(safeToolInput(e), false)
  }
  assert.equal(getterRan, false)
})

test('mutating an original event cannot change the inspected event passed to the tool', async () => {
  const e = { tool: 'Write', args: { content: 'ordinary' } }
  const r = await protectToolCall(e, async inspected => {
    e.args.content = '[REDACTED-SECRET-deadbeef]'
    assert.notEqual(inspected.args, e.args)
    assert.equal(inspected.args.content, 'ordinary')
    return { result: 'ok' }
  }, scrub)
  assert.deepEqual(r, { result: 'ok' })
})

test('the whole result envelope is scrubbed, including data and context', async () => {
  for (const key of ['data', 'base64', 'b64_json', 'imageData', 'thumbnail', 'ordinary']) {
    const r = await protectToolCall({ tool: 'Read' }, async () => ({
      result: { [key]: [{ token: fake }] }, text: fake, context: { value: fake }, isError: true,
    }), scrub)
    assert.equal(JSON.stringify(r).includes(fake), false, key)
    assert.equal(r.isError, true)
    assert.match(r.result[key][0].token, /REDACTED-SECRET/)
    assert.match(r.text, /REDACTED-SECRET/)
    assert.match(r.context.value, /REDACTED-SECRET/)
  }
  const denied = protectToolResult({ deny: fake }, scrub)
  assert.equal(denied.deny.includes(fake), false)
})

test('JSON keys are inspected without prototype pollution', () => {
  const data = JSON.parse('{"__proto__":{"data":"ordinary"}}')
  data[fake] = fake
  const clean = protectToolResult({ result: data }, scrub)
  assert.equal(JSON.stringify(clean).includes(fake), false)
  assert.equal(Object.getPrototypeOf(clean.result), Object.prototype)
  assert.equal(Object.hasOwn(clean.result, '__proto__'), true)
})

test('depth, size, node and unsupported-object limits withhold the complete result', () => {
  let deep = fake
  for (let i = 0; i < 14; i++) deep = { data: deep }
  const cycle = { token: fake }; cycle.loop = cycle
  for (const value of [deep, 'x'.repeat(8_000_001) + fake, new Array(100_001), cycle, new Date()]) {
    const r = protectToolResult({ result: value }, scrub)
    assert.equal(r.isError, true)
    assert.equal(typeof r.result, 'string')
    assert.equal(JSON.stringify(r).includes(fake), false)
    assert.equal(safeToolInput(value), false)
  }
})

test('getters and failed scanners never reveal the original result', () => {
  let getterRan = false
  const result = { get data() { getterRan = true; return fake } }
  assert.equal(protectToolResult({ result }, scrub).isError, true)
  assert.equal(getterRan, false)
  const r = protectToolResult({ result: fake }, () => { throw new Error(fake) })
  assert.equal(r.isError, true)
  assert.equal(JSON.stringify(r).includes(fake), false)
})

test('tool exceptions are replaced with a static failure', async () => {
  const r = await protectToolCall({ tool: 'Read' }, async () => { throw new Error(fake) }, scrub)
  assert.equal(r.isError, true)
  assert.equal(JSON.stringify(r).includes(fake), false)
})

const refused = (command, shell = 'bash') => {
  try { return commandsOf(command, shell).some(words => [rmRecursiveForce, forcePush, resetHard, cleanForce].some(fn => fn(words))) }
  catch { return true }
}

test('active command substitutions are refused, including quoted and nested shell strings', () => {
  for (const command of ['echo "$(rm -rf scratch)"', 'echo $(rm -rf scratch)', 'echo "`rm -rf scratch`"', 'bash -c \'echo "$(rm -rf scratch)"\'']) {
    assert.equal(refused(command), true, command)
  }
  assert.equal(refused('Write-Output "$(Remove-Item scratch -Recurse -Force)"', 'powershell'), true)
  assert.equal(refused('echo "unterminated'), true)
})

test('Bash line continuations cannot hide substitutions or join command names', () => {
  for (const newline of ['\n', '\r\n']) {
    const continued = '\\' + newline
    for (const command of [
      'echo "$' + continued + '(printf harmless)"',
      'echo $' + continued + '(printf harmless)',
      'r' + continued + 'm -rf scratch',
      'bash -lc \'echo "$' + continued + '(printf harmless)"\'',
      "printf '%s' 'literal" + continued + "text'",
    ]) {
      assert.throws(() => commandsOf(command, 'bash'), /continuation/)
      assert.equal(refused(command), true)
    }
  }
  assert.equal(refused('printf harmless\nprintf ordinary'), false)
})

test('literal substitution text is allowed without being interpreted as a command', () => {
  assert.equal(refused("echo '$(rm -rf scratch)'"), false)
  assert.equal(refused('echo "\\$(rm -rf scratch)"'), false)
  assert.equal(refused("Write-Output '$(Remove-Item scratch -Recurse -Force)'", 'powershell'), false)
})

test('shell -lc wrappers and ordinary destructive commands are detected', () => {
  for (const command of ['bash -lc "rm -rf scratch"', 'sh -ec "git reset --hard"', 'bash -lc \'sh -c "git clean -fd"\'', 'git -C app push --force origin main', 'sudo -u root "rm" -r -f scratch']) {
    assert.equal(refused(command), true, command)
  }
  assert.equal(refused('Remove-Item scratch -Recurse -Force', 'powershell'), true)
  assert.equal(refused('git status'), false)
  assert.equal(refused('bash -lc "git status"'), false)
  assert.equal(refused('rm old.log'), false)
  assert.equal(commandsOf('cd app && pnpm run build:prod', 'bash').map(heavyKind).find(Boolean), 'pnpm run build')
})

test('oversized shell input fails closed', () => {
  assert.throws(() => commandsOf('x'.repeat(100_001), 'bash'), /limit/)
})
