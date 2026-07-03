# GJC Coordinator MCP Hardening Plan

**Goal:** Make the GJC Coordinator MCP path work end-to-end for the real `gjc --worktree` runtime instead of repeatedly fixing mocked tmux delivery symptoms.
**Issue lineage:** #1409, #1416, #1417, #1418; new upstream follow-up issue/PR to be created after private-fork patch is verified.
**Status:** Approved for execution by Grant in chat: "Do not stop until complete."

## Context inspected
- `AGENTS.md`: repo-local law; primary surface is `packages/coding-agent/`; no arbitrary workflow defaults; use Bun commands; no `tsc`/`npx tsc`; no `console.*` in coding-agent.
- `packages/coding-agent/src/coordinator-mcp/server.ts`: Coordinator starts tmux sessions, sends prompt via paste buffer + Enter, and waits for runtime sidecar ack.
- `packages/coding-agent/src/session/agent-session.ts`: runtime emits coordinator state from agent session events.
- `packages/coding-agent/src/gjc-runtime/session-state-sidecar.ts`: sidecar state writer/reader boundary.
- `packages/tui/src/components/editor.ts`: TUI editor owns paste, autocomplete, slash-command matching, and Enter behavior.
- Upstream issues/PRs: #1409/#1410 fixed submit key; #1416/#1417 fixed multiline paste preservation; #1418 preserved tmux sessions after PTY close.
- Live repro after #1417: multiline prompt is preserved, but runtime still does not emit `turn_start`; pane shows slash autocomplete state for `skill:ultragoal`, so Enter is likely being consumed by slash-command autocomplete rather than submitting the pasted prompt.
- Existing tests: mostly mock Coordinator command runners or fake runtime scripts; no true live-runtime Coordinator MCP E2E that launches actual `gjc --worktree` and verifies real sidecar ack.

## Non-goals
- Do not redesign the public MCP contract unless evidence proves tmux/TUI delivery cannot be made reliable.
- Do not add new workflow skills or change public workflow defaults.
- Do not mass-refactor TUI/editor architecture.
- Do not rely on mocks as proof of fix.
- Do not merge or publish upstream without Grant approval.

## Recommendation
Start with the smallest root-cause fix: make Coordinator-delivered pasted prompts submit as prompts instead of being intercepted by TUI autocomplete/slash-command selection. Add the missing real-runtime E2E/smoke harness so future maintainer fixes cannot pass with mocks only. If tmux/TUI delivery remains fragile after this proof, escalate to a follow-up architecture change where Coordinator preserves MCP contract but uses GJC RPC/live-control underneath.

Simple path: patch the current Coordinator/TUI path and add a real E2E proof.
Skipped complexity: no full RPC-backed Coordinator rewrite yet, no new daemon, no broad TUI rewrite.
Upgrade trigger: if real E2E remains flaky after a narrow TUI submit fix, or if multiple further tmux/TUI state failures appear in the same MCP path.

## Plan

### Task 1: Reproduce on latest upstream dev
**Objective:** Confirm whether upstream `0a5eac6d` still fails before patching.
**Steps:**
1. Build/link latest branch runtime from this worktree or a dedicated source path.
2. Restart Coordinator MCP so it uses the new runtime.
3. Create a clean scratch repo.
4. Run `gjc_delegate_execute` with a no-edit smoke task.
5. Capture session id, turn id, delivery state, sidecar state, pane tail, and cleanup.

### Task 2: Add failing behavioral coverage
**Objective:** Capture the real broken invariant before implementation.
**Candidate files:**
- `packages/tui/test/editor.test.ts`
- `packages/tui/test/editor-autocomplete-actions.test.ts`
- `packages/coding-agent/test/coordinator-mcp-server.test.ts`

**Invariant:** A multi-line pasted delegated prompt beginning with `/skill:ultragoal` must submit as a prompt when Coordinator sends Enter, not remain in autocomplete selection state.

### Task 3: Patch narrow submit/autocomplete behavior
**Objective:** Prevent pasted multi-line delegated prompts from being hijacked by slash autocomplete on submit.
**Candidate files:**
- `packages/tui/src/components/editor.ts`
- `packages/tui/src/autocomplete.ts` only if needed.

**Constraints:**
- Preserve normal interactive slash autocomplete for typed single-line commands.
- Preserve normal Tab/Enter selection behavior when the user intentionally opens autocomplete.
- Keep change small and canonical style.

### Task 4: Add real-runtime E2E proof
**Objective:** Stop accepting mock-only fixes for this failure class.
**Candidate locations:**
- `packages/coding-agent/test/coordinator-mcp-server.test.ts` for test harness extension, or a dedicated smoke script if full test is too environment-sensitive.

**Proof shape:**
- Launch actual `gjc --worktree` in tmux through Coordinator code path.
- Send Coordinator prompt.
- Verify sidecar moves to `source=agent_session_event` / matching `current_turn_id` or equivalent acknowledged delivery.
- Cleanup tmux/worktree in `finally`.

### Task 5: Verify and iterate to green
**Commands/surfaces:**
- Focused TUI/editor test(s).
- Focused Coordinator MCP test(s).
- `bun run build:native` if native/runtime path changed or needed for live smoke.
- `gjc --smoke-test` using built/linked runtime.
- Real `gjc_delegate_execute` MCP repro against clean scratch repo.
- Broader package checks as practical: `bun run check:ts`, targeted `bun test ...`.

### Task 6: Preserve docs/changelog and upstream handoff
**Files:**
- `packages/coding-agent/CHANGELOG.md` and/or `packages/tui/CHANGELOG.md` if user-visible behavior changes.
- This plan and a GJC/implementation receipt under `.plans/` or `.gjc/`.
- Upstream issue with lineage and real E2E proof.
- PR from private fork/branch to upstream after verification.

## Risks / approval gates
- Material architecture fork: if tmux/TUI prompt delivery cannot be made robust and Coordinator should switch to RPC/live-control underneath, stop and summarize evidence before broad rewrite unless the needed change is clearly the smallest reliable path.
- External side effects: opening upstream issue/PR is approved by Grant's current request, but merging/publishing is not approved.
- Live sessions: do not kill unrelated `gjc --worktree` processes; only cleanup sessions created for this repro/fix.

## Execution handoff
Approved coding loop execution is degraded by the broken GJC Coordinator MCP itself. Use direct local tools and bounded subagents as needed to repair GJC; verify with real MCP tool output before claiming completion.
