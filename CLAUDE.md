# Neovate Desktop

## Project Info

- Electron desktop app (monorepo, single package at `packages/desktop/`)
- Settings directory: `~/.neovate-desktop`
- Package manager: `bun`

## Architecture

Three Electron processes with strict separation:

- **main** (`src/main/`) — Node.js: app lifecycle, IPC server, ACP subprocesses, plugins
- **renderer** (`src/renderer/src/`) — React 19 + Zustand + Tailwind: all UI
- **preload** (`src/preload/`) — context bridge, MessagePort forwarding
- **shared** (`src/shared/`) — oRPC contracts and types shared between main/renderer

IPC: oRPC over MessagePort (contracts in `src/shared/contract.ts`, client in `src/renderer/src/orpc.ts`)

## Process Boundaries

- NEVER import from `src/main/` in renderer code or vice versa
- NEVER import `electron` in renderer code
- The only shared code lives in `src/shared/`
- electron-vite enforces this at build time — violations cause cryptic errors

## Adding a New IPC Method

1. Define contract in `src/shared/features/<domain>/contract.ts` (zod schema)
2. Implement handler in `src/main/features/<domain>/router.ts`
3. Call from renderer via `client.<domain>.<method>()` (import client from `src/renderer/src/orpc.ts`)

## Renderer State

- All stores use: `create<State>()(immer((set, get) => ({ ... })))`
- Stores call oRPC client for persistence, update local state optimistically
- Convention: one store per feature at `features/<name>/store.ts`

## Commands

- `bun dev` — start dev server with hot reload
- `bun check` — typecheck + lint + format check
- `bun test:run` — unit tests (vitest)
- `bun ready` — full pre-push readiness check (format + check + test)
- `bun lint` — oxlint
- `bun format` — oxfmt

## Before Finishing

Run `bun ready` — it runs format check + typecheck + lint + tests. This is the same gate CI enforces.

## Code Conventions

- Commits: Conventional Commits (`feat:`, `fix:`, `chore:`)
- Linter: oxlint. Formatter: oxfmt. NOT eslint/prettier.
- Relative imports in renderer code (no `@/` aliases)
- `components/ui/` files are shadcn-generated — use `/coss-ui-sync` skill to add/update, don't edit by hand
- Debug logging: `import debug from "debug"` with `neovate:` namespace prefix
- Validation: zod schemas in shared contracts
- Plugin pattern: `MainPlugin` interface in `src/main/core/plugin/types.ts`

## Library Choices (don't suggest alternatives)

- Animations: `motion` (not framer-motion)
- Headless UI: `@base-ui/react` (not radix)
- Linter: `oxlint` (not eslint)
- Formatter: `oxfmt` (not prettier)
- Tailwind CSS 4 (CSS-first config, no tailwind.config.js)
- Zod 4 (not zod 3)
- Icons: `lucide-react` (general use), `@hugeicons/core-free-icons` (sidebar/plugin icons)

## Browser Automation Plugin

Allows the AI Agent to control the built-in browser via MCP tools.

**Architecture** — main-process CDP service with a thin renderer tab bridge:

```
┌─────────────────────────────────────┐
│         AI Agent (main)             │  ← 发起工具调用
│         MCP 工具层                   │
└──────────────┬──────────────────────┘
               │
               │ direct method calls
               ▼
┌──────────────┴──────────────────────┐
│   BrowserCdpService (main process)  │  ← CDP / ref cache / dialogs / network
└──────────────┬──────────────────────┘
               │ webContents.debugger
               ▼
┌──────────────▼──────────────────────┐
│         浏览器视图层（React）          │  ← 实际页面渲染与事件上报
└─────────────────────────────────────┘
```

**Key files:**

- `src/main/plugins/browser-automation/mcp-server.ts` — AgentBrowser-style MCP tool surface
- `src/main/plugins/browser-automation/browser-cdp-service.ts` — CDP-backed runtime for snapshots, refs, dialogs, frames, network, cookies, and storage
- `src/main/plugins/browser-automation/index.ts` — MCP server factory + webContents registration IPC
- `src/renderer/src/plugins/browser/browser-view.tsx` — browser tab UI; registers `webContentsId` with main and syncs active tab
- `src/renderer/src/plugins/browser/index.tsx` — listens for tab open/switch/close commands from main

**Critical constraints:**

- MCP server instance must be created fresh per session (`createFreshBrowserMcpServer()`) — instances are closed after each session and cannot be reused
- Public refs are `@eN`; tool inputs may accept bare `eN`, but tool output and docs should emit `@eN`
- `browser_snapshot` is the only inspection primitive; full accessibility tree is the default, while `interactiveOnly: true` is the recommended action-planning mode
- Never bind webview `src` to React state — React reconciliation will overwrite it and trigger unintended navigation; use `loadURL()` instead
- Browser tab lifecycle still crosses the renderer boundary, but automation semantics live in main only

## Design Context

### Users

Professional developers who use AI-assisted coding tools daily. They value efficiency, speed, and control. The interface should evoke **confidence and focus** — never get in the way, always feel fast.

### Brand Personality

**Minimal, quiet, elegant.** Understated sophistication like iA Writer or Things. The hot pink primary (`#fa216e`) provides a single bold accent against otherwise restrained, neutral surfaces.

### Aesthetic Direction

- **Visual tone:** Clean, spacious, low-contrast surfaces with precise typography and subtle depth. Information-dense when needed, but never cluttered.
- **References:** Claude/ChatGPT conversational AI interfaces — clean chat with clear message hierarchy, generous whitespace, readable markdown rendering.
- **Anti-references:** Overly decorative UIs, heavy gradients, gamified elements, neon/cyberpunk aesthetics.
- **Theme:** Full light and dark mode. Light uses cool gray-blue (`#f5f7fa`) backgrounds; dark uses near-black neutrals. Both themes share the `#fa216e` accent.
- **Logo:** Geometric angular arrow mark — sharp, abstract, black/white. Matches the minimal brand voice.

### Design Principles

1. **Quiet confidence** — The UI should feel calm and authoritative. Avoid visual noise, excessive borders, and competing focal points. Let content breathe.
2. **Developer-first density** — Respect screen real estate. Provide information density when developers need it (code, diffs, terminals) while keeping chat conversational and spacious.
3. **One accent, used sparingly** — `#fa216e` is the single brand color. Use it for primary actions and key interactive states only. Everything else stays neutral.
4. **Motion with purpose** — Animations should orient and inform, never decorate. Use `motion` library for transitions that help users track state changes.
5. **Consistent primitives** — Build from the existing shadcn/base-ui component library. Maintain consistent spacing, radius (`0.625rem`), and token usage across all features.
