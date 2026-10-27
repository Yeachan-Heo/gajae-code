# Benchmark-only `exec` tool

Run one constrained, read-only repository investigation plan. Its input is exactly one JSON object containing a `steps` array. Each step has a unique `id`, a `tool` name (`read` or `search` only), and an `input` object validated against the matching GJC tool schema below.

Execute steps sequentially. The first step uses literal values. Every later step must use at least one reference to the immediately preceding step's result in its `read.path`, `search.pattern`, or `search.paths` field. A reference has this shape:

```json
{"$ref":"previous-step-id","select":"details.files.0"}
```

`select` is a safe dot path into the prior result. Numeric segments select array items, for example `details.files.0` or `content.0.text`. To pass an exact distinctive substring from prior text, use `{"$ref":"previous-step-id","select":"content.0.text","contains":"ExactIdentifier"}`. References must point backward; no JavaScript, shell, `eval`, filesystem mutation, or other interpreter is available. The one `exec` result returns the bounded results from all steps after the complete chain runs.

## Callable API: `read`

{{read_description}}

Input JSON Schema:

```json
{{read_schema}}
```

## Callable API: `search`

{{search_description}}

Input JSON Schema:

```json
{{search_schema}}
```
