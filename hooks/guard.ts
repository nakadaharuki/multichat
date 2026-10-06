// Reads a shell command the way the shell will: quotes and escapes resolved, wrappers
// (sudo, env, timeout, xargs, find -exec) skipped, bash -c "…" and pwsh -Command "…" read again.
// It sees the command text only: a script file, an alias or cmd /c gets through.

export type Shell = 'bash' | 'powershell'


// A command line split into simple commands, each a list of words with quotes and
// escapes resolved. Splits at ; & | newlines and ` in bash. A line ending in the
// escape character (\ in bash, ` in PowerShell) continues on the next. A quoted
// string with spaces stays one word. What stands inside ( ), $( ) or { } is read
// twice: as part of the command around it (`rm (Join-Path a b) -Recurse -Force`)
// and as a command of its own (`echo $(rm -rf x)`, `% { rm $_ -Recurse -Force }`).
const simpleCommands = (command: string, shell: Shell): string[][] => {
  const out: string[][] = []
  let words: string[] = []
  let nested: number[] = []
  let word = ''
  let has = false
  let quote = ''
  const endWord = () => {
    if (has) words.push(word)
    word = ''
    has = false
  }
  const endCommand = () => {
    endWord()
    for (const at of [0, ...nested]) if (words.length > at) out.push(words.slice(at))
    words = []
    nested = []
  }
  const escape = shell === 'bash' ? '\\' : '`'
  const s = command.replace(shell === 'bash' ? /\\\r?\n/g : /`\r?\n/g, ' ')
  for (let i = 0; i < s.length; i++) {
    const c = s[i]
    if (quote) {
      if (c === quote) quote = ''
      else if (c === escape && quote === '"' && i + 1 < s.length && (shell === 'powershell' || /[$`"\\]/.test(s[i + 1]))) word += s[++i]
      else word += c
      continue
    }
    if (c === '"' || c === "'") (quote = c), (has = true)
    else if (c === escape && i + 1 < s.length) (word += s[++i]), (has = true)
    else if (c === '\n' || c === ';' || c === '&' || c === '|' || (shell === 'bash' && c === '`')) endCommand()
    else if (c === '(' || c === '{' || (c === '$' && s[i + 1] === '(')) {
      if (c === '$') i++
      endWord()
      nested.push(words.length)
    } else if (c === ')' || c === '}' || /\s/.test(c)) endWord()
    else (word += c), (has = true)
  }
  endCommand()
  return out
}

// A shell started from this one runs a string of its own: that string is read again
// with the inner shell's grammar. (cmd /c and a script file are not followed.)
const SHELLS: Record<string, [(word: string) => boolean, Shell]> = {
  bash: [w => w === '-c', 'bash'],
  sh: [w => w === '-c', 'bash'],
  zsh: [w => w === '-c', 'bash'],
  dash: [w => w === '-c', 'bash'],
  pwsh: [w => w.length >= 2 && '-command'.startsWith(w.toLowerCase()), 'powershell'],
  powershell: [w => w.length >= 2 && '-command'.startsWith(w.toLowerCase()), 'powershell'],
}
export const commandsOf = (command: string, shell: Shell): string[][] =>
  simpleCommands(command, shell).flatMap(words => {
    const i = commandIndex(words)
    const inner = i < 0 ? undefined : SHELLS[program(words[i])]
    const at = inner ? words.findIndex((w, k) => k > i && inner[0](w)) : -1
    return at < 0 || at + 1 >= words.length ? [words] : [words, ...commandsOf(words[at + 1], inner![1])]
  })

// Words that run the command after them, and the options of theirs that take a value.
const WRAPPERS: Record<string, RegExp | null> = {
  sudo: /^-(u|g|C|h|p|r|t|U|T)$/,
  doas: /^-(u|C)$/,
  env: /^-(u|C|S)$/,
  nice: /^-n$/,
  ionice: /^-[cn]$/,
  nohup: null,
  time: null,
  timeout: /^-[ks]$/,
  command: null,
  exec: /^-a$/,
  xargs: /^-(I|L|n|P|d|E|s|a)$/,
  caffeinate: /^-[tw]$/,
}
// Shell words that may stand before a command.
const KEYWORDS = /^(if|then|else|elif|fi|while|until|do|done|!)$/
const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/

// The program a word names, without its path or .exe: /bin/rm, .\rm, "C:\…\git.exe".
export const program = (word: string) => word.replace(/^.*[\\/]/, '').replace(/\.exe$/i, '').toLowerCase()

// The index of the word that is the command proper, after keywords, assignments and
// wrappers. `find … -exec cmd` and `xargs cmd` continue at cmd. -1 when none.
export const commandIndex = (words: string[]): number => {
  let i = 0
  while (i < words.length) {
    const w = words[i]
    if (KEYWORDS.test(w) || ASSIGNMENT.test(w)) i++
    else if (program(w) in WRAPPERS) {
      const takesValue = WRAPPERS[program(w)]
      i++
      if (program(w) === 'timeout' && /^\d/.test(words[i] ?? '')) i++
      while (i < words.length && (words[i].startsWith('-') || ASSIGNMENT.test(words[i]))) i += takesValue?.test(words[i]) ? 2 : 1
      if (program(w) === 'timeout' && /^\d/.test(words[i] ?? '')) i++
    } else if (program(w) === 'find') {
      const at = words.findIndex((x, k) => k > i && /^-(exec|execdir|ok|okdir)$/.test(x))
      return at < 0 ? -1 : commandIndex(words.slice(at + 1)) + (at + 1)
    } else return i
  }
  return -1
}

export const forcePush = (words: string[]): boolean => {
  let i = commandIndex(words)
  if (i < 0 || program(words[i]) !== 'git') return false
  // global options between git and its subcommand: -C <path>, -c <k=v>, --git-dir <path>, --no-pager
  i++
  while (i < words.length && words[i].startsWith('-')) i += /^(-[Cc]|--(git-dir|work-tree|namespace|exec-path|super-prefix|config-env))$/.test(words[i]) ? 2 : 1
  if (words[i] !== 'push') return false
  return words.slice(i + 1).some(w => /^--force(-with-lease|-if-includes)?(=|$)/.test(w) || /^-[a-zA-Z]*f[a-zA-Z]*$/.test(w) || /^\+\S/.test(w))
}

// rm -rf in bash, Remove-Item -Recurse -Force and its aliases in PowerShell. Options
// may be abbreviated (GNU: --rec --for; PowerShell: -r -fo) and clustered (-rf, -Rf).
const RM = /^(rm|remove-item|ri|del|erase|rd|rmdir)$/
export const rmRecursiveForce = (words: string[]): boolean => {
  const i = commandIndex(words)
  if (i < 0 || !RM.test(program(words[i]))) return false
  let recursive = false
  let force = false
  for (const raw of words.slice(i + 1)) {
    if (!raw.startsWith('-') || raw === '--') continue
    const w = raw.toLowerCase()
    if (w.startsWith('--')) {
      if (w.length >= 3 && '--recursive'.startsWith(w)) recursive = true
      if (w.length >= 3 && '--force'.startsWith(w)) force = true
    } else if (w.length >= 2 && '-recurse'.startsWith(w)) recursive = true
    else if (w.length >= 3 && '-force'.startsWith(w)) force = true
    else if (/^-[a-z]{1,5}$/.test(w)) {
      // a cluster of short options: -rf, -Rf, -rfv
      if (w.includes('r')) recursive = true
      if (w.includes('f')) force = true
    }
  }
  return recursive && force
}

// The git subcommand and the words after it, past git's global options. null when not git.
const gitArgs = (words: string[]): string[] | null => {
  let i = commandIndex(words)
  if (i < 0 || program(words[i]) !== 'git') return null
  i++
  while (i < words.length && words[i].startsWith('-')) i += /^(-[Cc]|--(git-dir|work-tree|namespace|exec-path|super-prefix|config-env))$/.test(words[i]) ? 2 : 1
  return words.slice(i)
}

// git reset with --hard: throws away uncommitted work, a parallel chat's included
export const resetHard = (words: string[]): boolean => {
  const a = gitArgs(words)
  return a !== null && a[0] === 'reset' && a.includes('--hard')
}

// git clean with -f (alone or in a cluster) or --force: deletes untracked files
export const cleanForce = (words: string[]): boolean => {
  const a = gitArgs(words)
  return a !== null && a[0] === 'clean' && a.slice(1).some(w => w === '--force' || /^-[a-zA-Z]*f[a-zA-Z]*$/.test(w))
}

// Heavy work: installs, builds, tests, type checks. A short label for it, never its arguments.
const RUNNERS = /^(npm|pnpm|yarn|bun|cargo|go|dotnet|gradle|gradlew|mvn|docker|make|tsc|jest|vitest|pytest|playwright|webpack)$/
const ALONE = /^(tsc|jest|vitest|pytest|playwright|webpack|make)$/
const VERB = /^(install|i|ci|add|build|test|t|compile|restore|typecheck|lint|e2e)$/
const SCRIPT = /^(build|test|typecheck|lint|e2e|check|compile|tsc)(:|$)/
export const heavyKind = (words: string[]): string | null => {
  let i = commandIndex(words)
  if (i < 0) return null
  // npx tsc, bunx vitest: the tool after the runner
  if (/^(npx|pnpx|bunx)$/.test(program(words[i]))) {
    i = words.findIndex((x, k) => k > i && !x.startsWith('-'))
    if (i < 0) return null
  }
  const p = program(words[i])
  if (!RUNNERS.test(p)) return null
  if (ALONE.test(p)) return p
  const rest = words.slice(i + 1).filter(w => !w.startsWith('-'))
  const verb = rest[0] ?? ''
  if (p === 'docker') return verb === 'build' ? 'docker build' : null
  // a bare yarn / pnpm / bun installs
  if (!verb) return /^(yarn|pnpm|bun)$/.test(p) ? `${p} install` : null
  if (verb === 'run') return SCRIPT.test(rest[1] ?? '') ? `${p} run ${rest[1].split(':')[0]}` : null
  if (VERB.test(verb)) return `${p} ${verb}`
  // yarn build, pnpm test:unit
  return /^(yarn|pnpm|bun)$/.test(p) && SCRIPT.test(verb) ? `${p} ${verb.split(':')[0]}` : null
}
