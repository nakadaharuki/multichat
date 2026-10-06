# multichat

One mod for running several Claude Code chats side by side on the desktop. Install it and it works: nothing to configure, nothing to switch.

```
Week 70% → 123% by reset (runs out 1 d before reset) · 5h 12% · Context 31% · 3 chats · 1 building · app.ts also changed in "Add rate limiting"   [Details]
```

Chats running at once share four things. multichat looks after each:

| Shared | What multichat does |
| --- | --- |
| The plan's usage limits | The band says where the week will land at this pace, and turns red when it runs out before the reset |
| The files | Before an edit, it asks when another open chat changed the same file in the last 30 minutes (Edit anyway / Cancel) |
| The PC | A heavy command (install, build, test, type check) waits while two other chats already run one. After 3 holds in 10 minutes it goes through, so nothing is stuck |
| The repository and your keys | `rm -rf`, force push, `reset --hard` and `clean -f` are refused (they throw away other chats' work too). Keys, emails and public IPs in what Claude reads become `[REDACTED-…]` placeholders, and go back to the real value in tool inputs |

`/multichat` (or **Details** in the band) opens a pane with the usage, every chat on this PC and what was held or refused.

English and Japanese, following Claude Code's `language` setting.

## Install

```
/plugin marketplace add nakadaharuki/multichat
/plugin install multichat@multichat
```

Claude Code v2.1.287 or later. Made for the desktop app (the Code tab); it also works in the terminal.

## What it touches

Mods are not sandboxed, so here it is before you install. The code is three files: [hooks/register.tsx](hooks/register.tsx), [hooks/guard.ts](hooks/guard.ts) (reads shell commands) and [hooks/redact.ts](hooks/redact.ts) (finds secrets).

- No network, no files, no environment variables, no outside programs
- `$.store` (this plugin's own storage on this PC): one entry per chat, with a heartbeat, the chat's first prompt cut to 48 characters (with secrets already hidden), the files it changed in the last 30 minutes and the kind of heavy command it runs (`npm install`, never its arguments). A chat closed for a day is removed
- It reads Claude Code's `language` setting and the usage figures the status line shows
- It watches `Bash`, `PowerShell`, `Edit`, `Write` and `NotebookEdit` calls, and rewrites tool results only to hide secrets

The command reader sees the command text only: a script file, an alias or `cmd /c` gets through. Keep deny rules in settings.json as well.

## Tests

```
claude plugin validate .
claude plugin test .
```

## Credits

[hooks/redact.ts](hooks/redact.ts) is Ray Amjad's [secret-redactor](https://github.com/ray-amjad/awesome-claude-code-function-hooks) (MIT, [LICENSE.secret-redactor](LICENSE.secret-redactor)). The rest is [PolyForm Noncommercial 1.0.0](LICENSE.md): free for personal and other noncommercial use.

## 日本語

デスクトップ版 Claude Code で、チャットを何本も並べて走らせるための Mod です。入れるだけで動き、設定も切り替えもありません。

- **使用量**: 帯に、このペースだと週の枠がリセット時に何 % になるかを出し、リセット前に尽きるなら赤くします
- **ファイル**: 別のチャットが 30 分以内に変えたファイルを編集する前に聞きます（編集する／やめる）
- **PC**: 別のチャットが 2 本重い処理（install・build・test・型検査）を走らせている間は、新しい重い処理を待たせます。10 分で 3 回待たせたら通します
- **リポジトリと鍵**: `rm -rf`・強制 push・`reset --hard`・`clean -f` は止めます。Claude が読む結果の中の鍵・メール・公開 IP は伏せ字にし、道具に渡すときは元に戻します

`/multichat`（帯の「詳しく」）で、使用量・この PC のチャット・止めたことを欄に出します。通信・ファイル・環境変数・外部プログラムは使いません。

ライセンス: [PolyForm Noncommercial 1.0.0](LICENSE.md)（個人など商用でない利用は自由）。`hooks/redact.ts` だけは Ray Amjad の secret-redactor で MIT（[LICENSE.secret-redactor](LICENSE.secret-redactor)）。
