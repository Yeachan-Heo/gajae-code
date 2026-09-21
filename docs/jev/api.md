# The Jev API, as the official docs describe it

Verified 2026-09-21 against `docs.typesafe.ai` and Opper's gateway docs. Facts
here are quoted from those; anything not stated there says so.

> **`jevapi.org` is not official.** It carries a disclaimer and points at a
> third-party reseller endpoint (`tokenra.io/v1/decisions`). Do not use it.

## Calling it

```http
POST https://api.typesafe.ai/v1/systemone
Authorization: Bearer $TYPESAFE_API_KEY
Content-Type: application/json
```

Keys at `console.typesafe.ai/keys`. Models list at `GET /v1/models`.

Through Opper's gateway, the base URL becomes `https://api.opper.ai/v3/compat`
and the model id becomes `typesafe/jev-1.13.0`. Opper requires a paid plan and
returns 402 on a free one.

## Shape

Three top-level fields: `model`, `state`, `questions`.

`state` is the situation — `string | object | array`. `questions` is a map you
key yourself; answers come back under the same keys, and the docs say those keys
are not passed to the model.

Three question types, each needing `type` and `instructions`:

| type | `criteria` | bounds |
|---|---|---|
| `noul` | optional `{"true": …, "false": …}` | — |
| `choice` | required map of option → description (`null` allowed) | 1–255 options |
| `score` | required ordered array | 2–10 levels, indexed from 0 |

Answers: a `noul` returns `noul` (0–1, and that probability **is** the answer —
there is no separate confidence field). A `choice` returns `choice`,
`confidence`, `probabilities`. A `score` returns `score` (probability-weighted,
so fractional), `confidence`, `probabilities`, `legend`.

## Limits

| | |
|---|---|
| total context | 64k tokens per request (state + all questions) |
| state + longest single question | 32k tokens |
| rate | 1,200 requests/min **and** 250,000 tokens/sec; either trips `429` |
| questions per request | no documented cap — bounded only by the 64k budget |
| concurrency cap | not documented |

Errors: `401` auth, `422` validation, `429` rate, `529` overloaded. Back off
exponentially; the official SDKs retry and honour `retry-after`.

No streaming, no tool calling, no chat-completions protocol. Text input only.

## Cost and version

$0.042 per 1M input tokens. **Output tokens are free.** No free tier is
documented.

Current version is `jev-1.13.0`. `jev-latest` and `jev-preview` are aliases and
both resolve there today. The docs say to **pin the version** once confidence
thresholds are tuned against it, since aliases move. Responses always report the
version that actually answered in `model`.

`docs.typesafe.ai/model-jaggedness/jev-1.13` lists that version's known weak
spots. Read it before tuning a threshold.

## SDK

```sh
npm install @typesafe-ai/sdk     # Node 20+
```

```ts
import { choice, TypeSafeClient } from "@typesafe-ai/sdk";

const client = new TypeSafeClient();
const response = await client.systemOne({
  state: { document: "I was charged twice. Please fix this ASAP." },
  questions: {
    category: choice("What is this ticket about?", {
      billing: null,
      technical: null,
      other: null,
    }),
  },
});

console.log(response.answers.category.choice);
```

Factories are `choice()`, `noul()`, `score()`; answer types are inferred from the
questions. Python is `pip install typesafe-sdk`.

## Two things that change the plan in this repo

### Batching questions is encouraged; batching candidates is what breaks

The docs say questions in one request are evaluated **in parallel in a single
pass**, and the official cookbook reports 13 questions batched into one request
being **12.2x cheaper and 10.0x faster** than 13 calls, with identical answers.

This is not in tension with the operator's finding. What failed there was
putting 45 *candidates* in one `state` array and having each question point at
`sessions[k]` — the model answered confidently about the wrong element. The rule
is therefore precise:

> **Many questions about one subject: batch them, it is much cheaper.**
> **Many subjects: one request each.**

An earlier draft of `replace-sites.md` blurred these into "one candidate per
request, so no batching." That was wrong and the cost estimates built on it were
too pessimistic.

### Korean accuracy is explicitly not equal to English

The docs state English is the primary training language and that other
languages, CJK included, are processed but **not at equal accuracy**, with a
recommendation to test directly and watch confidence.

This lands squarely on site 1. The `ralplan` scope gate reads *the user's own
request*, and this harness has Korean, Japanese, and Chinese READMEs because it
has those users. A classifier that is weaker in Korean deciding whether a Korean
request is specific enough is a worse failure than the regex it replaces, because
the regex is at least language-neutral — a file path looks the same in any
locale.

So site 1 needs a language split before it ships:

- measure the gate separately on Korean and English requests,
- require a higher confidence threshold for non-English input, or
- fall back to the existing pattern signals below that threshold.

Whichever it is, it has to be measured per language, not in aggregate. An
aggregate pass rate hides exactly this.
