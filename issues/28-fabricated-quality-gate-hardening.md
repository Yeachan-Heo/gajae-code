# 28 — fabricated completion gates: what is now refused, and what is still asserted

- **Owner stage:** durable goal G013 (final red-team round, finding 1)
- **Runtime:** `packages/coding-agent/src/gjc-runtime/ultragoal-runtime.ts`
- **Probe note:** every result below comes from the BRANCH SOURCE
  (`bun packages/coding-agent/src/cli.ts ultragoal …`). The installed compiled `gjc`
  is an older build and must not be used to judge these gates.

## The red-team finding

A wholly self-authored `--quality-gate-json` minted a genuine completion receipt: the
checkpoint validated gate SHAPE (required keys, statuses, non-empty arrays, an existing
artifact file) but not gate TRUTH. `commands` could be the literal `never-ran` and the
sole artifact could be a trivial text file.

## What was already enforced (verified, not assumed)

- **Protected gates cannot be completed by a self-authored gate.** A
  `supersedable:false` goal runs the real runtime obligations verifier, and
  agent-authored verifier claims are refused outright
  (`ultragoal-runtime.ts:3040-3090`). Covered by
  `refuses a fabricated quality gate for a protected goal without changing its status`.
- **A gate payload is not reusable verbatim across goals.** Reusing an accepted gate
  for a second goal is refused: `completion quality gate already accepted for G001 in
  this plan; per-goal verification evidence must be distinct`. Reproduced live.

## What this change adds

Placeholder command strings are now refused wherever a completion gate names the
commands its evidence rests on: `architectReview.commands`, `executorQa.e2eCommands`
and `redTeamCommands`, `iteration.rerunCommands`, and the deferred
`targetedVerification.commands` / `iteration.rerunCommands`.

Reproduction before the change (ordinary, non-protected goal):

```
ultragoal checkpoint --goal-id G001 --status complete \
  --quality-gate-json <gate with commands: ["never-ran"]>   → EXIT=0, receipt minted
```

After:

```
→ EXIT=1
qualityGate architectReview.commands names the placeholder "never-ran" instead of a command that was run
qualityGate executorQa commands name the placeholder "never-ran" instead of a command that was run
qualityGate iteration.rerunCommands names the placeholder "never-ran" instead of a command that was run
```

Red → green receipt for
`refuses an ordinary completion gate whose commands are placeholders instead of real invocations`:
RED (0 pass / 1 fail) with the runtime change stashed, GREEN (1 pass / 0 fail) with it
applied. Full ultragoal suites: 178 pass / 0 fail.

## Residual weakness — stated plainly, not implied closed

A placeholder check is a floor, not verification. For an ORDINARY goal:

- a fabricator can still write a plausible command such as `bun test` without running
  it — the runtime does not re-execute agent-named commands, and doing so safely is
  the open design problem the CLI-replay contract already documents (only pinned Bun
  probes are safely replayable; arbitrary argv is refused by design);
- artifact contents are still only required to exist and be non-empty for most
  surfaces, so a substantive-looking file can be hand-written.

Independently reproducible execution binding therefore remains enforced only where it
already was: protected (`supersedable:false`) gates, via the obligations verifier, and
the safe CLI-replay artifacts the executor QA lane can supply. Extending
verifier-backed completion to ordinary goals is tracked as its own work (durable goal
G014) rather than being claimed here.
