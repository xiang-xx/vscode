# ZCode Chat (built-in)

P0 integration of the **ZCode brain** into this Code-OSS / VS Code shell.

## What you get

- Right-side **Secondary Side Bar** webview (`ZCode` container) with provider switch: **Start Plan** / **BigModel** (same as ZCode)
- Default **Chat participant** `@zcode` for the native Chat UI
- **Bottom-left** `Sign in to ZCode` / account status bar (also Accounts menu + `ZCode: Manage Account`)
- Reuses **ZCode desktop login** from `~/.zcode/v2/credentials.json` when present
- Fresh login via ZCode **CLI OAuth polling** (browser + poll — no `zcode://` hijack)
- Configurable bridge: stub (default) or HTTP sidecar
- **Global chat history** at `~/.zcode/v2/ide-chat/` — shared with future DeepSeek (and other) modules via extension API

## Global chat history (for DeepSeek / others)

Sessions are stored under `~/.zcode/v2/ide-chat/` (not locked to this extension):

| Path | Content |
|---|---|
| `index.json` | Session list + active id |
| `sessions/<id>.json` | Full session: `messages` (canonical) + optional `timeline` / `todos` |

Other extensions continue a chat like this:

```ts
const ext = vscode.extensions.getExtension('zcode.zcode-chat');
await ext?.activate();
const api = ext?.exports as import('./ideChatStore').IdeChatExtensionApi;
const session = await api.ideChat.getActiveSession();
// Prefer session.messages for LLM context; set source to api.sources.deepseek when saving.
```

UI: top-right **历史** / **新对话**, or command `ZCode: New Chat`.

## File changes (working set)

Agent writes go through a shared `FileEditSession` (same shape as VS Code Chat’s session working set):

- Bottom bar: changed files with `+ / -`, **Keep** / **Undo** (per file or all)
- Click a file → open the live editor (same Chat editing review decorations / hunk Keep·Undo as Copilot)
- Multi-file → `vscode.changes` (built-in multi diff)
- Workbench bridge `ZCodeChatEditingBridge` registers a global `IChatEditReviewSession` and creates real `ChatEditingModifiedDocumentEntry` instances (same path as built-in Chat)
- `@zcode` participant uses proposed `externalEdit` when available

## Settings

| Setting | Default | Meaning |
|---|---|---|
| `zcode.providerMode` | `startPlan` | `startPlan` \| `bigmodel` |
| `zcode.model` | `GLM-5.3-Flash` | ZCode default models for the active provider |
| `zcode.reasoningLevel` | `high` | Thinking intensity for the active model |
| `zcode.bridge.mode` | `agent` | `agent` (default: BigModel Coding Plan + local file tools), `stub`, or `http` |
| `zcode.bridge.endpoint` | `http://127.0.0.1:4096/api/chat` | Used only when mode=`http` |
| `zcode.oauth.apiOrigin` | `https://zcode.z.ai` | CLI OAuth init/poll origin |

Composer (VS Code Chat look + ZCode behaviors):
- Rounded input container, pill toolbars, circular ↑ send
- `+` menu (from ZCode `ChatPromptActionMenu`): Attachments, @file, Goal/Workflow (empty draft), slash capabilities
- Provider / model / thinking intensity pickers
- Enter send, Shift+Enter newline

`startPlan` sends the ZCode account JWT; `bigmodel` sends the BigModel OAuth access token from the shared credentials store.

## Bridge contract (HTTP)

`POST` JSON body (OpenAI-compatible subset):

```json
{
  "model": "zcode",
  "messages": [{ "role": "user", "content": "..." }],
  "stream": false,
  "metadata": { "workspaceRoot": "/path", "provider": "zcode" }
}
```

Headers: `Content-Type: application/json`, optional `Authorization: Bearer <jwt|accessToken>`, `X-ZCode-Provider: startPlan|bigmodel`.

Expected response: `{ "choices": [{ "message": { "content": "..." } }] }` (or `{ "content": "..." }`).

## Roadmap

- **P1**: Spawn / attach real ZCode server (`/Users/xiang/apps/ZCode` packages/server or zcode-server-cli), wire OAuth for Start Plan
- **P2**: Agent tools (read/edit/terminal) + diff UX in the editor shell
- **P3**: Product branding (name, icons, default layout: editor left / ZCode right)

## Develop

From the VS Code repo root:

```bash
npm run compile-extensions  # or: npx gulp compile-extension:zcode-chat
./scripts/code.sh
```

Then run **ZCode: Open ZCode Chat** (or look at the secondary side bar).
