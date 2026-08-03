---
name: ultratest
description: Verify an added or changed test assertion with a small, evidence-backed mutation loop. Use after test-case, fixture, or assertion changes when a passing test needs proof against realistic regressions; skip pure naming, formatting, or move-only refactors that do not alter a behavior claim.
---

# Ultratest

Demonstrate that the changed test rejects plausible defects in its promised
behavior. Do not use coverage, a green baseline, or arbitrary syntax damage as
that demonstration.

## Decide and establish a baseline

Use this workflow for an assertion, expected value, fixture, test case, or
test-quality claim that changed. Skip only a naming, formatting, or move-only
refactor with no assertion or behavior-claim change; record the scoped diff and
write `Ultratest-Verified: skip(no assertion change)` if a trailer is needed.

Before any result exists, write one line:

`Behavior promise: <consumer-visible rule that this test must protect>.`

Read the test, the exercised production path, and one boundary or caller. Run
the focused baseline command green. Capture its command, the relevant file
hashes, and the pre-experiment scoped diff. Never mutate over unrelated dirty
lines; if exact restoration is not demonstrable, stop and report the conflict.

Persist the start through GJC, never by writing `.gjc` files yourself:

```sh
gjc state ultratest write --input '{"current_phase":"verifying","behavior_promise":"<one line>","baseline":{"command":"<focused test>","result":"pass","scoped_diff":"<receipt>"},"candidate_budget":3}' --json
```

## Choose experiments from product risk

Design three to five compileable temporary mutations. Derive each from a real
product risk, and vary the failure surface: for example a boundary/rounding
rule, a validation or authorization guard, a response mapping, a failure-path
classification, or a persisted state transition. Each must alter the observable
promise on a path the target test reaches.

Reject syntax breaks, random deletions, wording edits, duplicate attacks on one
rule, and changes outside the exercised path. If fewer than three credible
experiments exist, name the exhausted surfaces instead of padding the set.

Before applying each candidate, persist its prediction. Include a compact
ledger row with `id`, `risk`, `target`, `observable_change`, `predicted_test`,
`predicted_failure`, and `validation_command`:

```sh
gjc state ultratest write --input '{"current_phase":"verifying","mutation":{"id":"M1","risk":"<real defect>","target":"<file:symbol>","observable_change":"<promise violation>","predicted_test":"<test name>","predicted_failure":"<assertion/result>","validation_command":"<compile or focused check>"}}' --json
```

The prediction must exist before running the mutation. A nonzero exit alone is
not a catch; the named test must fail for the promised observation.

## Run one clean experiment at a time

For every candidate:

1. Reconfirm the baseline hashes and scoped diff.
2. Apply only that compileable mutation.
3. Run its smallest validation command, then the exact focused test.
4. Capture exit status plus the decisive assertion or observable output.
5. Apply the exact inverse patch immediately.
6. Reconfirm the original hashes, focused baseline, and clean scoped diff before classifying it.

Do not overlap mutations or carry a mutation into the next experiment. A timeout,
tool failure, or surprising failure still requires restoration first.

Persist the restored attempt with only durable, reviewable fields:

```sh
gjc state ultratest write --input '{"current_phase":"verifying","result":{"id":"M1","classification":"caught","test_result":"<decisive output>","restoration":"hashes and scoped diff match baseline"}}' --json
```

## Classify and respond

Use one outcome per attempt.

| Outcome | Response |
| --- | --- |
| caught | Count it only when the predicted test exposes the promised regression. |
| uncovered in this test | Strengthen the in-contract assertion or case, then rerun the same mutation before commit. |
| unowned gap | Record a clearly worded behavior todo, including the consumer and missing owner; do not disguise it as equivalence. |
| unreachable experiment | Replace it with a mutation on the reached path or choose the test that owns the path. |
| equivalent behavior | Record why the observable contract cannot differ, then replace the candidate. |
| invalid experiment | Discard the non-compileable candidate and create a valid replacement. |
| uncertain | Resolve the command, environment, or restoration uncertainty and repeat; do not commit on it. |

Persist classifications and todo wording through the same state command:

```sh
gjc state ultratest write --input '{"current_phase":"verifying","ledger":{"caught":<n>,"noted":<n>,"todo":"<only for an unowned gap>","final_baseline":"<focused command passed after restoration>"}}' --json
```

Every uncovered in-contract behavior is blocking until its test is strengthened
and the repeated mutation is caught. An unowned gap is not silently blocking,
but its todo must name the missing behavior rather than the experiment story.

## Finish with an inspectable receipt

After the final restoration, rerun the focused baseline and persist the final
receipt, including `behavior_promise`, baseline command/result, candidate IDs,
classifications, restoration proof, and any todo:

```sh
gjc state ultratest write --input '{"current_phase":"complete","receipt":{"behavior_promise":"<one line>","baseline":"pass","mutations":"M1,M2,M3","restoration":"clean scoped diff","todo":"<if any>"}}' --json
```

The commit gate only runs while Ultratest is active. It blocks inspectable
inline `git commit -m/--message` commands when a supported test file is staged
and the message has no `Ultratest-Verified:` trailer. It fails open for commit
forms it cannot inspect. Treat `GJC_ALLOW_NO_ULTRATEST=1` as a conscious
bypass, not routine cleanup. For an eligible commit, add exactly one trailer in
this form:

```text
Ultratest-Verified: killed <n> / noted <n>
```

For a justified skip, use:

```text
Ultratest-Verified: skip(no assertion change)
```
