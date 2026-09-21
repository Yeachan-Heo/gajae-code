# Design — the judgement lane

**Status: nothing shipped.** This document is a plan plus the measurements it
rests on. Where a claim is measured, it says who measured it and on what. Where
it is not, it says so.

## The problem this fork exists for

Gajae-Code's headline feature is that an agent's questions reach you anywhere —
Telegram, Discord, Slack. That is genuinely the right idea, and it has a failure
mode built into it: **if everything reaches you, you stop reading.** A harness
that pings you at 2am to confirm a variable name teaches you to mute it, and the
one question that actually needed you is muted along with the rest.

The same shape appears one layer down. `ralplan` critiques a plan with a
generative model. Most of that critique is a matching problem — does this plan
step correspond to a stated requirement, and is any requirement unserved? — and
matching does not need a model that writes prose.

Both are classification problems wearing generation clothes.

## The classifier

Jev (TypeSafe System One) answers typed questions about an input: a `Noul`
(is this so?) and a `Choice` (which of these?), each with a confidence score. It
does not generate.

Measured by the Capitome operator on 2026-09-21, first production run — linking
252 meeting actions against 45 agent sessions:

| | |
|---|---|
| requests | ~11,000 (pairwise) |
| wall clock | 9m37s at 12 concurrent |
| latency | 0.6s average per request |
| input | 8.56M tokens ≈ $0.36 at $0.042/MTok |
| output | free |

Judgement quality on pairs was human-ordered: a correct match scored 0.88 and
0.89, an unrelated pair 0.07. A human reading the same pairs ranks them the same
way.

## Three limits, all measured, all load-bearing

**1. It cannot index into its own state.** Putting 45 candidates in one `state`
array and asking 45 questions that each point at `sessions[k]` produced confident
answers about the *wrong* candidate — 0.93 on a pair that scores 0.07 when asked
alone. So every design below is **one subject per request**. This is a
constraint, not a tuning parameter, and it is why the run above needed 11,000
requests instead of 252.

This is narrower than it first reads, and an earlier draft of this document got
it wrong. Several *questions* about one subject are fine and are the documented
way to use the API — evaluated in one parallel pass, and the official cookbook
measures 13 batched questions as 12.2x cheaper and 10.0x faster than 13 calls.
What breaks is several *subjects* inside one state. See [`api.md`](api.md).

**2. Garbage in gets labelled confidently.** The operator rewrote the input
digest three times. Boilerplate — session banners, skill-injection lines,
closing-report formulas — attracted the judgement away from the actual subject.
"No hallucination" is true and does not help: the type is guaranteed, the truth
is not.

This is the biggest risk for this fork specifically. **Agent transcripts carry
more boilerplate than human speech does**, not less. Any graft that reads a
transcript inherits this problem in a worse form than the run that discovered it.

**3. Overlapping grade statements collapse confidence.** When score-band
descriptions are not mutually exclusive, confidence falls to the 0.3 range.
Enum members must be disjoint by construction.

## Where it attaches, strongest first

### 1. The notification gate

Before a question is routed to Telegram, classify it:

```
Choice(only-the-user-can-answer | answerable-from-repo-or-docs | has-a-reversible-default)
```

Only the first is pushed. The second returns to the agent as a lookup. The third
proceeds on the default and records the choice for review.

This is the best fit in the codebase. One candidate per request, so limit 1 does
not apply. The question text is short and authored by the agent rather than
scraped from a transcript, so limit 2 is at its mildest. The three outcomes are
disjoint, so limit 3 is satisfied by construction. The 0.6s latency is invisible
on a path that is about to wait for a human, and 40 questions a day at ~2K
tokens each is roughly **$0.003**.

It is also the only graft that improves the feature it touches rather than
replacing it. Gajae-Code's routing stays exactly as it is; it just stops crying
wolf.

### 2. `ralplan` pairwise coverage

For each (plan step, stated requirement) pair:

```
Noul(does this step serve this requirement?)
```

Steps that match nothing are scope creep. Requirements that nothing matches are
gaps. Both are findings a reviewer wants before reading prose criticism.

A 20-step plan against 8 requirements is 160 requests — about 8 seconds at 12
concurrent, and a cost that does not round up to a cent. This runs *before* the
generative critic, not instead of it: it hands the critic a list of suspects.

This is the graft that requires the fork. Upstream states that the four bundled
workflow skills cannot be replaced by disk skills, and `ralplan` is one of them.

### 3. `artifact://` recall triage

Gajae-Code already spills oversized shell output to retrievable `artifact://`
references. Deciding what comes *back* is still a judgement:

```
Noul(is this chunk relevant to the current goal?)
```

Cheap enough to run over every chunk. Limit 2 applies with full force here —
these are raw tool outputs, which is exactly the boilerplate-heavy input that
misled the first production run. Chunk cleaning has to be designed before this is
attempted, not after.

### 4. `ultragoal` evidence checking — attractive, and already has a negative result

For each (acceptance criterion, evidence) pair:

```
Choice(done | in_progress | mentioned | unrelated)
```

The shape is perfect and this is the one to be most careful with. **The operator
already ran this question and got zero.** Of 252 actions, completion evidence was
found for none. The cause was the input, not the classifier: the digest carried
only user utterances, so there was no record of anything being *finished*, and
putting results back in reintroduced the boilerplate problem.

So this graft is not "apply the classifier". It is "first build an extractor that
pulls result statements out of a transcript" — which is the actual unsolved
problem, and is not a jev problem at all.

Ordering note: this is the graft that looks most valuable and is furthest from
working. That inversion is the main thing this document exists to record.

## What would make each of these true

None of the above is evidence. The order to build in, and what each has to show:

1. **Notification gate.** Run it in shadow: classify every outgoing question,
   push all of them as today, and record what the classifier would have
   suppressed. After a week, read the suppressed list. If it contains a question
   that needed a human, the gate is not ready. This costs nothing and risks
   nothing, because nothing is suppressed while it runs.
2. **`ralplan` coverage.** Take plans already reviewed by the generative critic
   and check whether the pairwise pass finds the gaps the critic found. Agreement
   is not the goal — finding a gap the critic missed is.
3. **`artifact://` triage.** Blocked on chunk cleaning.
4. **`ultragoal` evidence.** Blocked on result extraction.

Claims about improvement belong here only with the run that produced them.
