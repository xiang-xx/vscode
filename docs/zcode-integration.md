# ZCode × Cursor × VS Code shell

Product direction: keep this repo as the **editor shell** (Code-OSS) and embed peer AI brains via a built-in extension.

## Layout

- Left: VS Code editor / explorer
- Right: Secondary Side Bar → **AI Chat** (`extensions/zcode-chat`)
- Top of the panel: **ZCode | Cursor** (peer brains, not nested providers)

## Brains

| Brain | Runtime | Auth |
|---|---|---|
| **ZCode** | Local tool loop → BigModel Coding Plan / Start Plan | `~/.zcode/v2/credentials.json` + CLI OAuth poll |
| **Cursor** | Official Cursor Agent CLI over **ACP** (`agent acp`) | `agent login` or `CURSOR_API_KEY` |

ZCode still has sub-providers **Start Plan** / **BigModel**. Cursor has ACP modes **agent** / **plan** / **ask** and optional model id.

## Shared history (highest layer)

`~/.zcode/v2/ide-chat/` is brain-agnostic:

- Canonical field: `messages` (`user` / `assistant`) — ZCode and Cursor both continue the same thread
- Optional: `timeline` / `todos` for rich UI
- `source` records who last wrote (`zcode` / `cursor`)
- API: activate `zcode.zcode-chat` → `exports.ideChat` / `exports.sources.cursor`

## File edits

Both brains feed the same `FileEditSession` + workbench `ZCodeChatEditingBridge` (Chat Keep/Undo markers). Cursor ACP writes are tracked via workspace file watchers during a turn.

## Settings

| Setting | Meaning |
|---|---|
| `zcode.activeBrain` | `zcode` \| `cursor` |
| `zcode.cursor.agentPath` | Path to `agent` (default `~/.local/bin/agent`) |
| `zcode.cursor.mode` | `agent` \| `plan` \| `ask` |
| `zcode.cursor.model` | Cursor model id (empty = CLI default) |
| `zcode.providerMode` | ZCode only: `startPlan` \| `bigmodel` |

## P0 shipped

- Peer brain switch in the chat webview
- Cursor ACP client + progress mapping into the shared timeline
- Shared global history
- Working set / editor review decorations for both brains

## P1+

1. Richer Cursor chrome (input / timeline skins) behind `data-brain="cursor"` hooks
2. Permission UI instead of auto `allow-once`
3. ZCode sidecar HTTP runtime
4. DeepSeek as another peer brain on the same history store
