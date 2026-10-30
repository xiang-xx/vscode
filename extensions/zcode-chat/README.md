# ZCode / Cursor Chat (built-in)

Peer AI brains in this Code-OSS shell: **ZCode** and **Cursor**, sharing one global chat history.

## What you get

- Right-side **Secondary Side Bar** webview with top switch **ZCode | Cursor**
- **ZCode**: Start Plan / BigModel, models, thinking intensity (same as ZCode desktop)
- **Cursor**: official Agent CLI over **ACP** (`agent acp`) — modes agent / plan / ask
- Default Chat participant `@zcode` (ZCode path)
- **Global chat history** at `~/.zcode/v2/ide-chat/` — highest layer; both brains continue `messages`
- Shared working set + Chat editing Keep/Undo markers for file edits

## Cursor setup

1. Install Cursor Agent CLI (`~/.local/bin/agent`)
2. Run `agent login` (or set `CURSOR_API_KEY`)
3. In the panel, switch brain to **Cursor** and send a message

Settings: `zcode.cursor.agentPath`, `zcode.cursor.mode`, `zcode.cursor.model`.

## Global chat history

| Path | Content |
|---|---|
| `~/.zcode/v2/ide-chat/index.json` | Session list + active id |
| `sessions/<id>.json` | `messages` (canonical) + optional `timeline` / `todos` |

```ts
const ext = vscode.extensions.getExtension('zcode.zcode-chat');
await ext?.activate();
const api = ext?.exports as import('./ideChatStore').IdeChatExtensionApi;
const session = await api.ideChat.getActiveSession();
// api.sources.zcode | api.sources.cursor | api.sources.deepseek
```

## Settings

| Setting | Default | Meaning |
|---|---|---|
| `zcode.activeBrain` | `zcode` | `zcode` \| `cursor` |
| `zcode.providerMode` | `startPlan` | ZCode only: `startPlan` \| `bigmodel` |
| `zcode.cursor.mode` | `agent` | `agent` \| `plan` \| `ask` |
| `zcode.cursor.model` | `` | Cursor model id (empty = CLI default) |
| `zcode.cursor.agentPath` | `` | Override path to `agent` |
| `zcode.bridge.mode` | `agent` | ZCode bridge: `agent` \| `stub` \| `http` |

## Develop

```bash
npx gulp compile-extension:zcode-chat
./scripts/code.sh
```

Command **ZCode: Switch Brain (ZCode / Cursor)** or use the panel tabs.
