# Gajae-Code Agent Contract

Gajae-Code (`gjc`) is a Bun-workspace TypeScript monorepo with Rust natives. This file is the repo-local operating contract: architecture map, dev utilities, and the rules that are not derivable from `docs/`. For deep dives, start at `docs/` (per-topic) and `docs/tools/` (per-tool runtime docs).

## Architecture

Runtime is Bun (`bun@<pinned in package.json>`); everything runs from source via `bun`, and release binaries are compiled with `packages/coding-agent/scripts/build-binary.ts`.

Dependency direction (roughly bottom-up):

```
utils ─┬─▶ ai ─────┬─▶ agent ─▶ coding-agent (gjc CLI, primary product surface)
       ├─▶ tui ────┘               │
       └─▶ natives (napi-rs ◀── crates/pi-natives)
                                   └─▶ stats (dashboard), bridge-client, sdk surfaces
```

| Workspace | Role |
| --- | --- |
| `packages/coding-agent` | Main `gjc` CLI. Entry: `src/cli.ts`. Subsystems live in `src/` (tools, tui, session, sdk, workflow, hooks, lsp, daemon, …). Unless stated otherwise, work targets this package. |
| `packages/agent` | Agent runtime: tool calling, state, orchestration. |
| `packages/ai` | Multi-provider LLM client with streaming. `src/models.json` is generated — never edit; regenerate via `bun run generate-models`. |
| `packages/tui` | Terminal UI library with differential rendering. |
| `packages/natives` + `packages/natives-<platform>` | napi-rs bindings over `crates/pi-natives` (text/image/grep/shell/pty). See `docs/natives-*.md`. |
| `packages/stats` | Local observability dashboard (`gjc stats`). |
| `packages/utils` | Shared utilities (`@gajae-code/pi-utils`): logger, `isCompiledBinary`, path/string helpers. |
| `packages/bridge-client` | OOO bridge client (`docs/ooo-bridge-extension-contract.md`). |
| `packages/*-benchmark` | Edit / orchestration-token benchmarks; not shipped. |
| `crates/` | Rust: `pi-natives`, `pi-shell`/`brush-*` (vendored shell), `pi-ast`, `pi-iso`, `git-daemon`, `gjc-sdk`. Driven via `bun scripts/run-rs-task.ts`. |
| `python/gjc-sdk` | Python SDK (`check:py-sdk`, `test:py-sdk`). |

When the user says "agent" or asks why the agent behaves a certain way, they mean the coding-agent CLI implementation, not the assistant editing the repo.

## Dev utilities

Run the CLI from source — no build step needed:

```sh
bun run dev                 # run gjc from source (packages/coding-agent/src/cli.ts)
bun run dev -- <args>       # e.g. bun run dev -- stats --help
bun run stats               # gjc stats from source
```

One-time / environment setup:

```sh
bun run install:dev         # bun install + workspace links + dev:link + setup defaults
bun run dev:link            # symlink `gjc` on PATH to the source CLI (scripts/dev-link.ts)
bun run dev:doctor          # verify PATH resolution of `gjc` points at this workspace
bun run install:defaults    # (re)install bundled default definitions
```

Verification (never run `tsc`/`npx tsc` directly at repo root; use these):

```sh
bun run check               # full TS + Rust checks (types, schemas, gates, workspaces)
bun run check:ts            # TS-only aggregate
bun --cwd=packages/<pkg> run check   # targeted package typecheck
bun test packages/<pkg>/test/<file>.test.ts   # targeted tests — prefer this first
bun run test                # full TS + Rust test suites (slow)
bun run lint / fmt / fix    # biome + workspace variants; :rs suffix for Rust
```

Generated artifacts — change the generator, then regenerate; `check` enforces sync:

```sh
bun run generate-schemas    # schemas/*.schema.json    (check:schemas)
bun run generate-models     # packages/ai/src/models.json
bun run generate-plugins    # plugins/                 (check:plugins)
bun run generate-docs-index # coding-agent docs index
```

Other useful entry points:

```sh
bun run ci:test:smoke                 # --version/--help/--smoke-test fast sanity
bun run restart:sdk-broker            # restart the local SDK broker
bun run conformance:run               # ACP conformance
bun run bench:edit / bench:orchestration-tokens
bun run stats:sync / stats:tools / stats:edits   # session-stats analysis (python3)
```

Required rebrand/default-surface gates after workflow-definition changes:

- `bun scripts/check-visible-definitions.ts`
- `bun scripts/verify-g002-gates.ts`
- `bun scripts/rebrand-inventory.ts --strict`
- `bun test packages/coding-agent/test/default-gjc-definitions.test.ts`

## Public workflow surface

GJC exposes exactly four default workflow skills (`deep-interview`, `ralplan`, `ultragoal`, `team`; bundled at `packages/coding-agent/src/defaults/gjc/skills/`) and exactly four role agents (`executor`, `architect`, `planner`, `critic`; bundled at `packages/coding-agent/src/prompts/agents/`). Do not add, document, install, or route to additional defaults without an explicit product decision and gate update.

- Do not commit repo-visible `.gjc` default definitions; runtime `.gjc` discovery covers local overrides.
- Runtime state, plans, specs, and ledgers belong under `.gjc/`.
- Public commands, paths, and examples must use `gjc` and `.gjc`; preserve upstream attribution in source comments where appropriate.
- Keep source-bundled skills/agents in sync with tests/gates; do not rely on committed `.gjc` copies.
- Planning workflows (`deep-interview`, `ralplan`) never execute implementation without explicit user approval; artifacts stay `pending approval` until then.
- Subagent await timeouts are observation windows, not failure signals; inspect before cancelling.

## Code quality

- No `any` unless absolutely necessary.
- Never use `ReturnType<>`; write the actual type name.
- No inline imports: no `await import()`, no `import("pkg").Type`. Top-level imports only.
- Check `node_modules` for external API types instead of guessing.
- Prefer `export * from "./module"` in barrel files; remove redundant paths on ambiguity.
- Use ES `#private` fields; no `private`/`protected`/`public` modifiers except constructor parameter properties.
- Use `Promise.withResolvers()` instead of `new Promise((resolve, reject) => ...)`.
- Prompts live in static `.md` files imported with `with { type: "text" }`; never build prompts inline.

## Bun and filesystem conventions

| Operation | Use | Avoid |
| --- | --- | --- |
| File read/write | `Bun.file()`, `Bun.write()` | `readFileSync`, `writeFileSync` |
| Spawn simple commands | Bun Shell (`$\`cmd\``) | `child_process` |
| Sleep | `Bun.sleep(ms)` | timeout promises |
| JSON5/JSONL | `Bun.JSON5`, `Bun.JSONL` | ad-hoc parsers |
| String width/wrap | `Bun.stringWidth`, `Bun.wrapAnsi` | custom ANSI wrapping |

Use namespace imports for Node modules (`import * as fs from "node:fs/promises"`, same for `path`, `os`). Use `node:fs/promises` for directory ops; skip redundant parent-dir creation before `Bun.write()`.

## Worker scripts

Spawn workers with the compile-safe hybrid pattern:

```ts
import { isCompiledBinary } from "@gajae-code/pi-utils";

const worker = isCompiledBinary()
	? new Worker("./packages/<pkg>/src/<worker>.ts", { type: "module" })
	: new Worker(new URL("./<worker>.ts", import.meta.url).href, { type: "module" });
```

Every worker entry must also be listed as an extra compile entrypoint in `packages/coding-agent/scripts/build-binary.ts`. Validate new worker paths with the relevant smoke test; `gjc --smoke-test` covers the stats sync worker.

## Logging and TUI safety

No `console.log`/`console.warn`/`console.error` in `packages/coding-agent/` — it corrupts TUI rendering. Use the centralized logger from `@gajae-code/pi-utils`.

All text in tool renderers must be sanitized: `replaceTabs()`, `truncateToWidth()`/`ui.truncate()` with shared limits, `shortenPath()` for home paths, shared preview constants for previews. Apply to success, error, diff, and streaming render paths alike.

For UI/dashboard/TUI visual work, follow `docs/ui-design-visual-qa.md` before broad product-screen implementation.

## Testing rules

Test externally observable contracts: behavior, output shape, state transitions, error mapping, regression-prone parsing boundaries.

Avoid placeholder tests, tautologies, broad `not.toThrow()` assertions, duplicated coverage, long-lived global mutations, and `mock.module()`. Prefer `vi.spyOn(...)` with cleanup. Compile-time guarantees belong in type checks, not runtime tests.

## Commit, changelog, release

- Always commit incrementally; atomic commits are preferred. One logical change per commit — never batch unrelated work.
- For targeted branch / PR-like work, always open a PR targeting `dev`.
- Commit messages use the lore format: conventional-commit subject, a short why-focused body, then structured trailers. Include only the trailers that apply.

  ```
  feat(auth): switch session store from JWT to server-side sessions

  Client-side JWTs leaked user roles into browser storage.
  Server-side sessions let us revoke access instantly on permission changes.

  Lore-id: a1b2c3d4
  Constraint: must support horizontal scaling -- use Redis-backed store
  Constraint: session TTL must not exceed 24h per compliance policy
  Rejected: JWT with short expiry | still leaks roles to client
  Rejected: encrypted JWT | adds decryption overhead on every request
  Confidence: high
  Scope-risk: wide
  Reversibility: migration-needed
  Directive: do not cache session objects at the application layer
  Tested: concurrent session creation under load
  Not-tested: Redis failover behavior
  Supersedes: f7e8d9c0
  ```

- Package changelogs live at `packages/*/CHANGELOG.md`; add entries under `## [Unreleased]`, never edit released sections.
- Release flow: `bun run release` (scripts/release.ts) after changelogs and verification are complete.
