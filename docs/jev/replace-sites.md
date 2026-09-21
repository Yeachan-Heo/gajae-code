# Replacement sites

Concrete places in this codebase where a decision is currently made by a
heuristic that a typed classifier should make instead. File and line are against
the fork point. Each entry says what is there now, why it is a classification
problem, and what replaces it.

The last section lists sites that look like candidates and must **not** be
touched. That list matters as much as the first.

---

## 1. `ralplan` scope gate — the strongest site

`packages/coding-agent/src/defaults/gjc/skills/ralplan/SKILL.md:213-219`

**Now.** Whether a request is specific enough to execute directly, or vague
enough to need a planning pass, is decided by pattern signals: a file path, an
issue/PR number, a camelCase/PascalCase/snake_case symbol, a test runner,
numbered steps, acceptance criteria, an error reference, a code block, or a
`force:` / `!` prefix.

**Why it is a classification.** "Is this request specific enough to act on" is a
judgement about meaning. The signal list is a proxy for it, and the document
says so itself: *"If it fires on a well-specified prompt, add one concrete
anchor."* The user is asked to work around the heuristic. The `force:` escape
hatch exists for the same reason.

Both failure directions cost. A false pass sends an under-specified request
straight to execution, which is the exact failure gajae-code was built to
prevent. A false block puts a planning ceremony on a one-line fix, which is how
a workflow tool teaches people to stop calling it.

**Replace with.**

```
Choice(executable-as-stated | scope-or-criteria-still-guessed | ambiguous-needs-user)
```

One subject per request, so the candidate-indexing failure does not apply. The
input is the user's own short request — no transcript boilerplate — so the
garbage-in problem is at its mildest in the whole codebase. The three outcomes
are disjoint.

**Blocked on a language split.** The official docs state accuracy in CJK is not
equal to English, and this gate reads the user's own words. See
[`api.md`](api.md) — measured per language, not in aggregate, before it ships.

Keep the pattern signals as a **fast pass**: if a signal fires *and* the
classifier says `executable-as-stated`, skip. Disagreement routes to planning.
`force:` / `!` keeps overriding everything, unchanged.

---

## 2. Ask timeout auto-selection

`packages/coding-agent/src/tools/ask.ts:216` — `getAutoSelectionOnTimeout`

**Now.**

```ts
if (typeof recommended === "number" && …) return [optionLabels[recommended]];
return [optionLabels[0]];
```

When no answer arrives before the deadline, the recommended option is taken, and
with no recommendation **option zero** is taken. Array position decides.

**Why it is a classification.** Some questions have a reversible default and are
fine to auto-answer. Some are the user's to make and must never be auto-answered
— a retention window, a destructive migration, a pricing default. Nothing here
distinguishes them, so a timeout silently converts the second kind into a
decision nobody made, and the transcript records it as settled.

**Replace with.** Classify at ask time, not at timeout:

```
Choice(reversible-default-ok | user-must-decide | answerable-from-repo)
```

- `reversible-default-ok` → current behaviour, plus a record of what was
  auto-taken and why.
- `user-must-decide` → never auto-select. Extend the deadline and keep escalating
  rather than manufacturing an answer.
- `answerable-from-repo` → return to the agent as a lookup instead of paging a
  human at all.

The third outcome is what makes the notification lane worth having: it removes
questions from the phone rather than ranking them.

---

## 3. Review-conflict detection across targets

`packages/coding-agent/src/gjc-runtime/ralplan-review-conflicts.ts:209-212`

**Now.** The code's own comment:

> Only cross-role incompatible pairs on the same `targetId` are conflicts.

Conflict = exact `targetId` string equality **and** the action pair appearing in
`INCOMPATIBLE_ACTION_PAIRS` (line 81).

**Why it is a classification.** Two findings can prescribe incompatible work
while naming different targets. Architect says remove the retry wrapper in one
module; Critic says add retry at a caller in another. Different `targetId`, no
conflict derived, both dispositions stay closed, and the plan goes to approval
carrying a contradiction the gate was built to catch.

**Replace with.** Nothing — **add** a second pass. Keep the deterministic table
as the fast path, then for finding pairs whose `targetId` differs:

```
Noul(do these two findings prescribe work that cannot both stand?)
```

This is the pairwise shape the classifier was measured on: correct pairs 0.88
and 0.89, unrelated 0.07. Both findings are short typed records with
`evidence` — clean input, not transcript text.

Each pair is its own subject, so each is its own request: 12 architect findings
against 10 critic findings is 120 requests. Do **not** try to fold the ten into
one `state` array and ask ten questions against it — that is precisely the
indexing failure. See [`api.md`](api.md) for where batching does help.

Above threshold the pair opens a conflict requiring a disposition, exactly like a
same-target conflict does today. The writer already fails closed on open
conflicts, so no new enforcement path is needed.

---

## 4. Context pruning — relevance where recency stands in for it

`packages/agent/src/compaction/pruning.ts:825-826` in
`collectToolOutputPruneCandidates` (line 785)

**Now.**

```ts
const insideProtectWindow = accumulatedTokens < config.protectTokens;
if ((insideProtectWindow && !isStale) || isProtected) { … }
```

A tool result survives pruning if it is recent enough, or its tool is on a static
protected list. The file's own comment on the stale path admits the substitution:

> Stale results are prunable even inside the recency protect window — they are
> superseded, so **recency no longer implies relevance**.

**Why it is a classification.** Recency is a proxy for relevance, and the code
knows it. A result that was never superseded but has nothing to do with the
current goal survives on recency alone and holds context that a relevant older
result needed.

**Replace with.** Nothing in the staleness index — see the do-not-touch list.
Add a third state for entries the index is silent about:

```
Noul(is this output still relevant to the current goal?)
```

**Do not build this yet.** Limit 2 applies here at full force: raw tool output is
the boilerplate-heavy input that misled the first production run, and agent
output carries more of it than human speech. Chunk cleaning is the prerequisite
and it is unsolved. Ordered fourth deliberately.

---

## 5. `ultragoal` evidence checking — has a negative result already

For each (acceptance criterion, evidence) pair:
`Choice(done | in_progress | mentioned | unrelated)`

The shape is exact and this is the one to be most careful with. **The operator
already ran this question and got zero** — 0 of 252 actions matched completion
evidence on 2026-09-21. The cause was the input, not the classifier: the digest
carried only user utterances, so nothing recorded anything being *finished*, and
adding results back reintroduced the boilerplate problem.

So this is not "apply the classifier." It is "first build an extractor that pulls
result statements out of a transcript" — an unsolved problem, and not a
classifier problem.

Ordered last on purpose. It looks the most valuable and is the furthest from
working; recording that inversion is most of why this file exists.

---

## Do not touch

**`packages/coding-agent/src/tools/ask.ts:261` — `classifyAskRemoteInteraction`.**
The name says classify, the body is protocol parsing: control id lookup, option
membership, whitespace checks. It is deterministic, total, and correct. A
classifier here would add latency and a failure mode to code that has neither.

**`packages/agent/src/compaction/pruning.ts:534` — `buildStalenessIndex`.**
"A later result for the same target supersedes an earlier one" is a structural
fact, computed exactly and for free. Judging it would be slower, cost money, and
be wrong sometimes. The gap is the entries this index says nothing about, not the
ones it decides.

**`INCOMPATIBLE_ACTION_PAIRS`, same file as site 3, line 81.** `add` vs `remove`
on one target is a table lookup. Keep it as the fast path; site 3 only covers
what the table cannot see.

The pattern across all three: **where a rule is exact, leave it.** The classifier
belongs where a proxy is currently standing in for a judgement — recency for
relevance, string equality for incompatibility, regex for specificity.
