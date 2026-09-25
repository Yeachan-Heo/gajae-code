# calc

> Evaluates one or more arithmetic expressions and returns formatted numeric results.

## Source
- Entry: `packages/coding-agent/src/tools/calculator.ts`
- Model-facing prompt: `packages/coding-agent/src/prompts/tools/calculator.md`
- Key collaborators:
  - `packages/coding-agent/src/tui/status-line.ts`, `packages/coding-agent/src/tui/tree-list.ts` — status lines and tree-list rendering
  - `packages/coding-agent/src/tools/render-utils.ts` — preview limits and formatting helpers

## Inputs

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `calculations` | `Calculation[]` | Yes | Batch of expressions to evaluate in order. |

### `Calculation`

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `expression` | `string` | Yes | Arithmetic expression string. |
| `prefix` | `string` | Yes | Prepended verbatim to the rendered numeric result. |
| `suffix` | `string` | Yes | Appended verbatim to the rendered numeric result. |

## Outputs
- Single-shot result.
- `content[0].text` is the newline-joined `prefix + value + suffix` string for each calculation.
- `details.results` is an array of `{ expression, value, output }`.
- On renderer fallback, if `details` is missing but `content[0].text` exists, the TUI tries to pair each output line with the original expressions from call args.

## Flow
1. `execute()` wraps evaluation in `untilAborted(...)`.
2. For each entry, `evaluateExpression(...)` tokenizes the expression, parses it with a recursive-descent parser, rejects non-finite outputs, and normalizes `-0` to `0`.
3. `tokenizeExpression(...)` accepts whitespace, parentheses, operators, and number literals; any other character throws immediately.
4. `ExpressionParser` applies precedence in this order: `+ -`, `* / %`, unary `+ -`, exponentiation `**`, parentheses/literals.
5. Exponentiation is right-associative (`2 ** 3 ** 2` parses as `2 ** (3 ** 2)`).
6. Each numeric result is formatted with `String(value)` and wrapped with the provided `prefix` and `suffix`.
7. The tool returns text output plus structured `details`.

## Side Effects
- Background work / cancellation
  - Supports abort via `untilAborted(...)`.
- Session state
  - None.
- Filesystem / Network / Subprocesses
  - None.

## Limits & Caps
- Supported operators: `+`, `-`, `*`, `/`, `%`, `**` (`packages/coding-agent/src/tools/calculator.ts`).
- Supported numeric literals:
  - decimal integers/floats, including leading-dot forms like `.5`
  - scientific notation like `1e10`, `2.5E-3`
  - hexadecimal `0x...`
  - binary `0b...`
  - octal `0o...`
- Results must be finite; `Infinity` and `NaN` are rejected.
- The renderer collapses long result lists using `PREVIEW_LIMITS.COLLAPSED_ITEMS` from `packages/coding-agent/src/tools/render-utils.ts`.

## Errors
- Invalid characters: e.g. `Invalid character "x" in expression`.
- Malformed numbers: invalid prefixed literal, invalid exponent, invalid number.
- Syntax errors: `Unexpected token in expression`, `Unexpected end of expression`, `Missing closing parenthesis`, `Expression is empty`.
- Non-finite arithmetic: `Expression result is not a finite number`.
- Any evaluation error aborts the whole batch; the tool does not return partial successes.

## Notes
- Despite the schema example showing `sqrt(16)`, the parser does not support functions, identifiers, units, or constants; only numeric literals, operators, and parentheses are accepted.
- Precision is plain JavaScript `number` semantics throughout, including floating-point rounding behavior.
- `/` and `%` use JavaScript numeric operators directly; there is no integer-only mode or unit handling.
- Unary operators bind tighter than `*`/`/`/`%` but looser than exponentiation because unary parsing delegates to `#parsePower()`.
