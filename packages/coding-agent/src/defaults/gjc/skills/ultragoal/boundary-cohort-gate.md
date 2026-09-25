## Boundary completion cohort gate

The heavyweight gate runs **once per boundary generation**, not once per story and not once per review pass. Intermediate stories use the lightweight deferred gate above; this section applies at the boundary (the run's final required goal, or an explicit batch's final member).

One generation freezes the change set and reviews it exactly once:

1. Run implementation verification for the boundary's cumulative change set.
2. **Freeze the change set.** Run `gjc ultragoal quality-gate source-hash --json` on the clean reviewed snapshot and use its `sourceHash` exactly. The runtime binds this digest to the integration base, merge base, normalized changed paths, captured diff, and untracked-content digest. Every lane in this generation inspects that same frozen snapshot; a lane verdict carrying a different `sourceHash` is rejected. Any later source or base change requires rerunning this command and starting a new generation.
3. **Run the cohort lanes on the frozen snapshot** — at most one `cleaner`, one `architect`, and one `qa` lane per generation. They may run in parallel because they share the frozen source; a second architect or QA lane in the same generation is rejected. The `cleaner` lane is the internal ai-slop-cleaner skill fragment run over the frozen change set: a read-only detector that emits an `AI SLOP CLEANUP REPORT`, and it still runs and records a passed/no-op report when there are no relevant edits. Its BLOCKING findings join the cohort findings rather than starting their own fix loop; advisory findings are included in the gate report only and are not written to the Ultragoal ledger.
4. Delegate an `architect` review covering all three lanes:
   - architecture-side: system boundaries, layering, data/control flow, operational risks.
   - product-side: user-visible behavior, acceptance criteria, edge cases, regressions.
   - code-side: maintainability, tests, integration points, and unsafe shortcuts.
5. Delegate an `executor` QA/red-team lane with typed `executionMode: "ultragoal-red-team"` (preferred) — or assignment text that explicitly labels Ultragoal completion QA/red-team — to build and run the e2e/red-teaming QA suite appropriate for the story. A bare `executorQa` field-name mention is not enough to activate the mode. This lane must try to break the change, not just confirm the happy path. It must start from the approved plan/spec/acceptance criteria, then user-facing contracts, and only then implementation code as supporting evidence. Plan/code mismatches are blockers, not items to paper over with implementation intent.
6. The executor QA/red-team lane must prove evidence by the real surface under test:
   - GUI/web surfaces require a valid automation transcript plus a non-uniform screenshot. Bare `inlineEvidence` text or typed receipts never prove live GUI/web execution.
   - CLI surfaces require a safe runtime argv replay (`schemaVersion: 1`, `kind: "cli-replay"`, `replaySafe: true`) or the existing audited `replayExempt` path with a screenshot, automation, or PTY structural fallback. Runtime replay is limited to the pinned Bun runtime for `bun --version` or literal `bun -e "console.log(...)"`; the gate never executes model-authored test files. Shells, interpreters with code strings, path-qualified executables, package/git/network mutation commands, `bun test`, and arbitrary argv are rejected. Structured `test-report` fallback remains unsupported pending a separately reviewed provenance design.
   - Native/desktop/tui surfaces require a structurally valid screenshot, PTY capture with terminal control codes, or app-automation transcript.
   - API/package surfaces require a real artifact file or typed receipt whose artifact `kind` contains one of `api`, `package`, `consumer`, `black-box`, or `test-report`; examples: `api-package-test-report`, `package-consumer-report`, `black-box-api-receipt`. Algorithm/math surfaces require a real artifact file or typed receipt whose artifact `kind` contains one of `property`, `boundary`, `edge`, `adversarial`, `failure`, `math`, `algorithm`, or `test-report`; examples: `property-test-report`, `algorithm-boundary-report`. Bare `inlineEvidence` text alone is not sufficient for any surface.
   - The mandatory **computer-use** red-team suite (`kill-switch-bypass`, `suspended-enforcement`, `permission-revoked`, …) is conditional, not universal: require it only when computer/desktop control is genuinely part of the product surface being dogfooded. For every other product type, prove the change through the matching live surface instead — browser-use automation for web/GUI, bash/CLI live invocation or argv replay for CLI, and real artifacts or typed receipts for API/package/algorithm/math. Editing docs, prompts, or skills that merely mention computer-use does not by itself make the computer-use suite applicable; pick the red-team surface that matches what the change actually ships.
   - **The runtime decides applicability from the change set, and it fails closed.** Judgement about "what the change actually ships" does not override it, so check the paths before assuming the suite is skippable. `gjc ultragoal checkpoint --status complete` requires the suite whenever the computed change set touches computer source (`crates/pi-natives/src/computer/**`), the computer tool (`packages/coding-agent/src/tools/computer.ts`, `packages/coding-agent/src/tools/computer/**`), or a **shared behavior registry** — `packages/coding-agent/src/config/settings-schema.ts`, `packages/coding-agent/src/tools/index.ts`, `packages/coding-agent/src/tools/renderers.ts`. The registries are deliberately unconditional: they mix computer and non-computer entries, and a path-only or uninspectable change cannot prove computer controls were untouched, so *any* edit to them demands the suite even when the diff contains nothing computer-related. The suite is also required whenever change-set capture was incomplete. Generated bindings (`packages/natives/native/index.{d.ts,js}`), prompt/skill/doc files, and every other path do not trigger it on their own.
   - Practical consequence: a change that is not about computer-use at all — say a new settings key in `settings-schema.ts` — will still be gated on the seven mandatory cases. Do **not** fabricate them to get past the gate, and do not weaken the gate. Either supply a genuine suite, or treat it as a blocker and escalate to the operator (`gjc ultragoal record-critic-gate-override` exists for an authorized override).
7. The executor QA/red-team lane must report a matrix using `executorQa.contractCoverage`, `executorQa.surfaceEvidence`, `executorQa.adversarialCases`, and `executorQa.artifactRefs`. Not-applicable rows are allowed only in `contractCoverage` and `surfaceEvidence`; each `status: "not_applicable"` row requires `contractRef` plus `reason`. `adversarialCases` rows cannot be not-applicable.
8. **Join before repairing.** Fold all three lane verdicts and the final code review into the strict gate under `iteration.reviewCohort` (`reviewGeneration`, `sourceHash`, `joined: true`, and the three `lanes`). No lane may checkpoint on its own, and no fix work starts until the findings are joined. Clean means `architectReview.architectureStatus`, `architectReview.productStatus`, and `architectReview.codeStatus` are all `"CLEAR"`, `architectReview.recommendation` is `"APPROVE"`, executor QA statuses are `"passed"`, iteration is `"passed"` with `fullRerun: true`, the cohort is joined with every lane clean and hash-bound, every evidence field is non-empty, every required matrix row is present, and every blockers array is empty. `COMMENT`, `WATCH`, `REQUEST CHANGES`, `BLOCK`, missing evidence, missing or shallow matrix rows, plan/code mismatches, or non-empty blockers are non-clean.
9. If the joined findings contain any blocker, do **not** checkpoint `complete` and do **not** call `goal({"op":"complete"})`. Record **one consolidated blocker batch** for all findings from the whole cohort instead of one story per lane:
   ```sh
   gjc ultragoal record-review-blockers --goal-id <id> --title "Resolve verification blockers" --objective "<blocker-resolution objective>" --evidence "<joined cohort findings>"
   ```

   Review-blocker recursion cap (#3613): `record-review-blockers` dedups identical-objective blockers (same trimmed objective + same blocked goal + open status) and bounds the number of unresolved review_blocker descents per blocked goal to **3**. Descents 1..3 may exist; an attempt to create a 4th throws a typed `review_blocker_recursion_cap` terminal handoff (CLI exit 1, operator-visible marker) — never silently auto-completing findings. When the cap fires, record a human pause/escalation or resolve existing blockers before recording more.
10. One consolidated fix batch produces exactly **one new generation**. Re-freeze the fixed source as a new `sourceHash`, bump `reviewGeneration`, and set `deltaOnly: true` with `priorGenerationSourceHash` and the `deltaPaths` actually changed. Generation 2+ reviews are **delta-only**: they may not pull in unrelated scope without an explicit `scopeExpansion` carrying `severity`, `novelty`, and `justification`. Repeat until a generation joins clean.
11. Only after a generation joins clean, checkpoint the story as complete with a structured quality gate. The terminal critic runs **once** on that final joined generation; when `criticReview.sourceHash` is present it must match the cohort's `sourceHash`. The checkpoint creates a receipt in `ledger.jsonl`; `goals.json.status` alone is not proof. In aggregate mode, the final aggregate receipt must exist before the agent calls `goal({"op":"complete"})` to reconcile the inline UX goal state.

While an Ultragoal run is active, the `ask` tool is blocked for all agents. Record unresolved review decisions as durable blockers with `gjc ultragoal record-review-blockers` instead of prompting interactively.

The native `checkpoint --status complete` command rejects missing or shallow gates, and reports **all** structural, evidence, surface, cohort, and declaration errors in one run rather than one per attempt. Each diagnostic carries a stable `path`, a stable machine-readable `code`, and a human `message`.

Validate before you checkpoint. `gjc ultragoal quality-gate validate --quality-gate-json <json-or-path> [--goal-id <id>] [--json]` applies exactly the same rules as `checkpoint --status complete` (including deferred-vs-boundary gate selection and artifact existence checks) but is strictly read-only: it never touches `goals.json`, `ledger.jsonl`, or goal state. It exits non-zero with the full diagnostics list when invalid, so authoring a gate is one pass instead of an edit/retry loop. `--quality-gate-json` must include:

```json
{
  "architectReview": {
    "architectureStatus": "CLEAR",
    "productStatus": "CLEAR",
    "codeStatus": "CLEAR",
    "recommendation": "APPROVE",
    "evidence": "architect review synthesis across architecture/product/code",
    "commands": ["architect review command or agent evidence id"],
    "blockers": []
  },
  "executorQa": {
    "status": "passed",
    "e2eStatus": "passed",
    "redTeamStatus": "passed",
    "evidence": "executor-built e2e and red-team QA commands/results",
    "e2eCommands": ["bun test:e2e"],
    "redTeamCommands": ["bun test:red-team"],
    "artifactRefs": [
      { "id": "<ref-id>", "kind": "<surface-appropriate kind; see step 6>", "path": "artifacts/<file>", "description": "live-surface evidence" }
    ],
    "contractCoverage": [
      { "id": "<id>", "contractRef": "<approved contract id>", "obligation": "<required behavior>", "status": "covered", "surfaceEvidenceRefs": ["<surface-id>"], "adversarialCaseRefs": ["<case-id>"] }
    ],
    "surfaceEvidence": [
      { "id": "<surface-id>", "contractRef": "<surface under test>", "surface": "gui|web|cli|api|package|algorithm|math|native|desktop|tui", "invocation": "<real invocation>", "verdict": "passed", "artifactRefs": ["<ref-id>"] }
    ],
    "adversarialCases": [
      { "id": "<case-id>", "contractRef": "<approved contract id>", "scenario": "<boundary/adversarial input>", "expectedBehavior": "<required handling>", "verdict": "passed", "artifactRefs": ["<ref-id>"] }
    ],
    "blockers": []
  },
  "iteration": {
    "status": "passed",
    "evidence": "blockers absent or resolved and the full loop was rerun cleanly",
    "fullRerun": true,
    "rerunCommands": ["bun test:e2e", "bun test:red-team"],
    "reviewCohort": {
      "reviewGeneration": 1,
      "sourceHash": "sha256:<frozen change-set hash every lane inspected>",
      "joined": true,
      "lanes": {
        "cleaner": { "status": "passed", "sourceHash": "sha256:<same>", "evidence": "AI SLOP CLEANUP REPORT: zero blocking findings", "blockers": [] },
        "architect": { "status": "CLEAR", "sourceHash": "sha256:<same>", "evidence": "architecture/product/code review of the frozen set", "blockers": [] },
        "qa": { "status": "passed", "sourceHash": "sha256:<same>", "evidence": "e2e + red-team run against the frozen set", "blockers": [] }
      }
    },
    "blockers": []
  }
}
```

Provide one `artifactRefs` entry per live surface actually exercised, using the surface-appropriate `kind` and evidence rules from steps 6–7 above; the CLI rejects missing or shallow gates. `status: "not_applicable"` rows are allowed only in `contractCoverage` and `surfaceEvidence` and each requires `contractRef` plus `reason`.

For safe CLI replay artifacts, the JSON at `path` must be an object like `{"schemaVersion":1,"kind":"cli-replay","replaySafe":true,"command":["bun","-e","console.log(\"ultragoal-cli-ok\")"],"cwd":".","env":{"LC_ALL":"C"},"timeoutMs":30000,"expectedExitCode":0,"recordedStdout":"ultragoal-cli-ok\n","recordedStderr":"","invariants":[{"type":"substring","value":"ultragoal-cli-ok"},{"type":"not_substring","value":"error"}]}`. `replaySafe: true` is required but is never authority by itself: executable replay is limited to the pinned Bun runtime for `bun --version` or deterministic literal `bun -e "console.log(...)"`. Shells, nested interpreters, path-qualified executables, test source, install/publish commands, git mutation, network clients, and every other argv are rejected. The declared cwd and artifact files are realpath-confined beneath the repository, but the safe probe itself runs from a fresh empty temporary cwd/home so repository `bunfig.toml` preloads and user configuration cannot execute. Mixed inline/nested/file-backed rows fail closed, POSIX timeout cleanup signals the replay process group, stdout and stderr are validated after normalization, output is capped at 1 MiB, and the child environment is scrubbed to `CI`, `NO_COLOR`, `GJC_ULTRAGOAL_REPLAY`, trusted temporary `HOME`/`TMPDIR`, plus optional `LANG`, `LC_ALL`, `LC_CTYPE`, and `TZ`.

Compiled GJC binaries fail executable replay closed because their `process.execPath` launches GJC rather than a Bun CLI. Those runs must use the existing audited `replayExempt` structural fallback; the validator never resolves an untrusted `bun` from `PATH`.

Focused `bun test` execution is blocked because repository test source is still arbitrary host code without an operating-system sandbox. The current `replayExempt` contract continues to require an existing screenshot, automation transcript, or PTY structural fallback; a `test-report` or `bun-test-report` JSON file is intentionally not accepted yet. Keep that design work open until test-result provenance, output binding, and consumer authority can be made fail-closed. Allowed `reasonCode` values remain `unsafe_side_effect`, `requires_credentials`, `requires_network`, `non_deterministic_external`, `destructive`, `interactive_only`, and `platform_unavailable`.
