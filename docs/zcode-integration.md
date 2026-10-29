# ZCode × VS Code shell

Product direction: keep this repo as the **editor shell** (Code-OSS) and embed the **ZCode brain** (providers, agent, Start Plan OAuth) via a built-in extension + runtime bridge.

## Layout

- Left: VS Code editor / explorer
- Right: Secondary Side Bar → **ZCode** chat (`extensions/zcode-chat`)

## P0 (shipped)

Built-in extension `extensions/zcode-chat`:

- Webview chat in `secondarySidebar`
- Provider switch: Start Plan / BigModel (aligned with ZCode)
- Default chat participant `@zcode`
- Bridge: `agent` (default) talks to BigModel Coding Plan / Start Plan and edits the workspace via tools; `stub` / `http` still available
- **Account (bottom-left status bar)**: reuses `~/.zcode/v2/credentials.json` (same encrypted store as ZCode desktop). Fresh login uses ZCode **CLI OAuth polling** (browser → poll), not `zcode://` deep link into Code-OSS.

See `extensions/zcode-chat/README.md`.

## Auth model

| Path | Behavior |
|---|---|
| Reuse desktop | Decrypt shared `~/.zcode/v2/credentials.json` with ZCode’s machine-local cipher |
| Sign in | `POST /api/v1/oauth/cli/init` → open browser → poll `/api/v1/oauth/cli/poll/:id` → write tokens back into the shared credentials file |
| Why not URI callback? | Z.ai/BigModel OAuth apps are registered for `zcode://oauth/callback`; fighting desktop for that scheme is brittle. CLI poll is the supported headless path. |

## Global IDE chat history

Shared session store (ZCode now; DeepSeek later): `~/.zcode/v2/ide-chat/`.

- Canonical field: `messages` (`user` / `assistant`) — any module can continue the same thread
- Optional: ZCode `timeline` / `todos` for rich UI
- API: activate `zcode.zcode-chat` and use `exports.ideChat` (`IdeChatStore`)

## P1+

1. Run ZCode runtime from `/Users/xiang/apps/ZCode` (server / zcode-server-cli) as a sidecar
2. Point `zcode.bridge.mode=http` at its chat endpoint; bridge already sends JWT when `providerMode=zcode`
3. Agent file edits / terminal / diff against the shell workspace
4. Optional product rename / default auxiliary bar visibility
5. DeepSeek module: same `IdeChatStore` / `messages` for cross-provider continuity
