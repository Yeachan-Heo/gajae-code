# Gajae-Code Agent Contract

Gajae-Code (`gjc`) is this repository's coding-agent implementation. Treat this file as the repo-local operating contract for contributors and automated agents working in this tree.

## Public workflow surface

GJC intentionally exposes exactly four default workflow skills. Do not add, document, install, or route to additional default workflow definitions without an explicit product decision and gate update. GJC also bundles exactly four source-defined task role agents for delegation; these are not workflow skills and are not committed repo-visible `.gjc` defaults.

| Workflow skill | Purpose | Bundled source file |
| --- | --- | --- |
| `deep-interview` | Socratic requirements interview; writes approved specs under `.gjc/specs/`. | `packages/coding-agent/src/defaults/gjc/skills/deep-interview/SKILL.md` |
| `ralplan` | Consensus planning and approval gate; writes plans under `.gjc/plans/`. | `packages/coding-agent/src/defaults/gjc/skills/ralplan/SKILL.md` |
| `ultragoal` | Durable multi-goal execution ledger under `.gjc/ultragoal/`. | `packages/coding-agent/src/defaults/gjc/skills/ultragoal/SKILL.md` |
| `team` | Tmux-backed parallel execution using `.gjc/state/team/`. | `packages/coding-agent/src/defaults/gjc/skills/team/SKILL.md` |

| Role agent | Purpose | Bundled source file |
| --- | --- | --- |
| `executor` | Bounded implementation/fix/refactor tasks. | `packages/coding-agent/src/prompts/agents/executor.md` |
| `architect` | Read-only architecture and code-review lane. | `packages/coding-agent/src/prompts/agents/architect.md` |
| `planner` | Read-only sequencing and handoff planning lane. | `packages/coding-agent/src/prompts/agents/planner.md` |
| `critic` | Read-only plan critique and actionability review. | `packages/coding-agent/src/prompts/agents/critic.md` |

Rules:
- Bundled default workflow skills load from `packages/coding-agent/src/defaults/gjc/skills`.
- Bundled role agents load from `packages/coding-agent/src/prompts/agents`.
- `architect`, `planner`, and `critic` remain read-only for product files, but may use their restricted `bash` tool only for sanctioned workflow CLI persistence (`gjc ralplan --write ...`) and GJC workflow state read/write/contract commands (`gjc state ...`); the bash tool blocks arbitrary env overrides, direct handoffs, state clears, artifact file-path ingestion, and all other command shapes for those role agents, allowing only `GJC_RALPLAN_ARTIFACT` for `gjc ralplan --write ... --artifact-env GJC_RALPLAN_ARTIFACT`.
- Do not commit repo-visible `.gjc` default definitions; runtime user/project `.gjc` discovery remains supported for local overrides and installed configs.
- Runtime state, plans, specs, and workflow ledgers belong under `.gjc/`.
- Preserve upstream attribution in source comments/docs where appropriate, but public commands, paths, and examples must use `gjc` and `.gjc`.
- Keep source-bundled workflow skills and role agents in sync with tests/gates; do not rely on committed `.gjc` copies.

## Workflow routing

Use the smallest workflow that satisfies the request:

1. Direct implementation for clear, low-risk edits.
2. `deep-interview` when intent, scope, or acceptance criteria are ambiguous.
3. `ralplan` when requirements are clear enough to plan but architecture, sequencing, or verification needs consensus.
4. `ultragoal` when work should be split into durable goals with an auditable ledger.
5. `team` when approved work benefits from parallel workers.

Do not execute implementation from `deep-interview` or `ralplan` unless the user explicitly approves execution. Planning artifacts must remain `pending approval` until that approval exists.

Subagent await timeouts are observation windows, not failure signals. Do not cancel a subagent merely because `subagent await` timed out; inspect/list, continue independent work, and cancel only when the subagent has actually failed, gone off-track, or become unrecoverably wrong.

## Repository focus

This repo contains multiple packages, but `packages/coding-agent/` is the primary product surface. Unless otherwise specified, assume work refers to that package.

When the user says "agent" or asks why the agent behaves a certain way, they mean the coding-agent CLI implementation, not the assistant currently editing the repo.

| Package | Description |
| --- | --- |
| `packages/ai` | Multi-provider LLM client with streaming support |
| `packages/agent` | Agent runtime with tool calling and state management |
| `packages/coding-agent` | Main GJC CLI application |
| `packages/tui` | Terminal UI library with differential rendering |
| `packages/natives` | Native text/image/grep bindings |
| `packages/stats` | Local observability dashboard (`gjc stats`) |
| `packages/utils` | Shared utilities |
| `crates/pi-natives` | Rust native helpers |

## Code quality

- No `any` unless absolutely necessary.
- Never use `ReturnType<>`; write the actual type name.
- No inline imports: no `await import()`, no `import("pkg").Type`, no dynamic type imports. Use top-level imports.
- Check `node_modules` for external API types instead of guessing.
- Prefer `export * from "./module"` in barrel files. If star exports create ambiguity, remove the redundant path.
- Use ES `#private` fields. Do not use `private`, `protected`, or `public` on fields/methods except constructor parameter properties where TypeScript requires it.
- Use `Promise.withResolvers()` instead of `new Promise((resolve, reject) => ...)`.
- Prompts live in static `.md` files imported with `with { type: "text" }`; do not build prompts inline in code.
- Never edit `packages/ai/src/models.json` directly. Change generator/descriptors/resolvers and regenerate with `bun --cwd=packages/ai run generate-models`.

## Bun and filesystem conventions

Prefer Bun APIs where they are cleaner:

| Operation | Use | Avoid |
| --- | --- | --- |
| File read/write | `Bun.file()`, `Bun.write()` | `readFileSync`, `writeFileSync` |
| Spawn simple commands | Bun Shell (`$\`cmd\``) | `child_process` |
| Sleep | `Bun.sleep(ms)` | timeout promises |
| JSON5/JSONL | `Bun.JSON5`, `Bun.JSONL` | ad-hoc parsers |
| String width/wrap | `Bun.stringWidth`, `Bun.wrapAnsi` | custom ANSI wrapping |

Use namespace imports for Node modules:

```ts
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
```

Use `node:fs/promises` for directory operations. Avoid redundant parent-directory creation before `Bun.write()`.

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

Do not use `console.log`, `console.warn`, or `console.error` in `packages/coding-agent/`; it corrupts TUI rendering. Use the centralized logger from `@gajae-code/pi-utils`.

All text displayed in tool renderers must be sanitized:
- tabs to spaces via `replaceTabs()`
- truncation via `truncateToWidth()` / `ui.truncate()` and shared limits
- home paths shortened via `shortenPath()`
- previews bounded by shared preview constants

Apply sanitization to success, error, diff, and streaming render paths.

## UI design and visual QA

For future UI, dashboard, terminal, and TUI visual work, follow [`docs/ui-design-visual-qa.md`](docs/ui-design-visual-qa.md) before broad product-screen implementation. The contract requires a pre-implementation UI workflow branch, complete `DESIGN.md` source material, component showcase/state harness coverage, fresh full-surface visual evidence with CJK semantic line-break defects blocking completion, independent review, ANSI-preserving terminal/TUI evidence requirements, and an explicit provenance boundary against raw third-party corpus vendoring.

## Commands and verification

- Never commit unless explicitly asked.
- Never run `tsc` or `npx tsc`; use `bun check` / `bun run check:ts`.
- For focused package changes, prefer targeted tests first, then type/lint/build checks as appropriate.
- Required rebrand/default-surface gates after workflow-definition changes:
  - `bun scripts/check-visible-definitions.ts`
  - `bun scripts/verify-g002-gates.ts`
  - `bun scripts/rebrand-inventory.ts --strict`
  - `bun test packages/coding-agent/test/default-gjc-definitions.test.ts`

## Testing rules

Test externally observable contracts: behavior, output shape, state transition, error mapping, or regression-prone parsing boundaries.

Avoid placeholder tests, tautologies, broad `not.toThrow()` assertions, duplicated coverage, long-lived global mutations, and `mock.module()`. Prefer `vi.spyOn(...)` with cleanup. Runtime compile-time guarantees belong in type checks, not placeholder runtime tests.

## Changelog and release

Package changelogs live at `packages/*/CHANGELOG.md`. Add new entries under `## [Unreleased]`; do not edit released sections.

Release flow is `bun run release` after changelogs and verification are complete.
