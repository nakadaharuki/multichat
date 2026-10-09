# multichat

One mod for running several Claude Code chats side by side on the desktop. Install it and it works: nothing to configure, nothing to switch.

Chats running at once share four things. multichat looks after each:

| Shared | What multichat does |
| --- | --- |
| The plan's usage limits | The pane says where the week will land at this pace, and turns red when it runs out before the reset |
| The files | Before an edit, it asks when another open chat changed the same file in the last 30 minutes (Edit anyway / Cancel) |
| The PC | A heavy command (install, build, test, type check) waits while two other chats already run one. After 3 holds in 10 minutes it goes through, so nothing is stuck |
| The repository and your keys | `rm -rf`, force push, `reset --hard` and `clean -f` are refused (they throw away other chats' work too). Detected keys, emails and public IPs become `[REDACTED-…]` placeholders. Tool calls containing placeholders are refused; values are never automatically restored |

`/multichat` opens a pane with the usage, every chat on this PC and what was held or refused.

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

No secret vault or reverse mapping is retained. Each detected occurrence gets a new placeholder; repeated values need not have the same placeholder. Tool inputs containing placeholders (including placeholders from old conversations) are refused, including file edits, to prevent accidental credential replacement. Use credentials configured outside the conversation in the destination tool instead of asking Claude to forward a hidden value.

Every JSON field in a tool result is inspected, including `data`, keys, error text and context. Credential names such as `token` retain their detection context in structured JSON too. Non-enumerable properties, symbols and accessors are rejected; tools receive only the inspected copy of a JSON input. If a result exceeds the inspection limits, contains unsupported objects, or cannot be inspected, the entire result is withheld with a fixed error. Binary/image content is not a supported secret-redaction format and may be withheld or altered; this is a text-pattern filter, not an assurance that every kind of secret is detected.

The command reader sees the command text only: a script file, an alias, variable-based execution or `cmd /c` gets through. It is not a shell sandbox. Active command substitutions such as `$(...)` and Bash backticks are refused, even inside double quotes; `bash -lc` strings are inspected. Bash backslash-newline sequences are refused conservatively even in literal quoted text; use single-line commands instead. Malformed quotes and excessive nesting fail closed. Keep deny rules in settings.json as well.

## Tests

Offline security regressions using Node 24+ (no installs, real credentials, network or shell execution):

```
node --test tests/security.node.mjs
```

Host integration tests require the Claude Code plugin test environment:

```
claude plugin validate .
claude plugin test .
```

## Credits

[hooks/redact.ts](hooks/redact.ts) is Ray Amjad's [secret-redactor](https://github.com/ray-amjad/awesome-claude-code-function-hooks) (MIT, [LICENSE.secret-redactor](LICENSE.secret-redactor)). The rest is [PolyForm Noncommercial 1.0.0](LICENSE.md): free for personal and other noncommercial use.

## 日本語

デスクトップ版 Claude Code で、チャットを何本も並べて走らせるための Mod です。入れるだけで動き、設定も切り替えもありません。

- **使用量**: `/multichat` のペインに、このペースだと週の枠がリセット時に何 % になるかを出し、リセット前に尽きるなら赤くします
- **ファイル**: 別のチャットが 30 分以内に変えたファイルを編集する前に聞きます（編集する／やめる）
- **PC**: 別のチャットが 2 本重い処理（install・build・test・型検査）を走らせている間は、新しい重い処理を待たせます。10 分で 3 回待たせたら通します
- **リポジトリと鍵**: `rm -rf`・強制 push・`reset --hard`・`clean -f` は止めます。検出した鍵・メール・公開 IP は伏せ字にします。秘密値の対応表は保持せず、自動復元もしません。伏せ字を含む道具の入力は、送信や誤った上書きを防ぐため止めます

認証情報は会話の外で道具に設定してください。`data` を含むJSONの全項目を検査し、上限超過や検査失敗時は結果全体を伏せます。画像・バイナリの秘密検出は対象外で、結果を伏せたり変更したりする場合があります。文字列パターンによる検出であり、すべての秘密を検出する保証ではありません。コマンド置換は拒否しますが、シェルの隔離機能ではないため、設定側の拒否規則も維持してください。

構造化JSONでも `token` などの親キーを判定に使います。非列挙・Symbol・アクセサーのプロパティは拒否し、道具へ渡すのは検査済みのコピーだけです。Bashのバックスラッシュ改行は、引用文字列内も含めて拒否します。代わりに1行のコマンドを使ってください。

`/multichat` で、使用量・この PC のチャット・止めたことを欄に出します。通信・ファイル・環境変数・外部プログラムは使いません。

ライセンス: [PolyForm Noncommercial 1.0.0](LICENSE.md)（個人など商用でない利用は自由）。`hooks/redact.ts` だけは Ray Amjad の secret-redactor で MIT（[LICENSE.secret-redactor](LICENSE.secret-redactor)）。
