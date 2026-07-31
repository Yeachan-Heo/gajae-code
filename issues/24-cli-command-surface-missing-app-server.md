# 24 — CLI command-surface inventory did not list `app-server`

- **Command:** `bun test packages/coding-agent/test/cli-command-surface.test.ts --test-name-pattern "registers launch plus retained workflow/runtime utility endpoints"`
- **Site:** `packages/coding-agent/test/cli-command-surface.test.ts:136`
- **Owner stage:** Stage 12 residual defect triage (durable goal G010)
- **Disposition:** FIX

## Expected behaviour

`cli-command-surface.test.ts` is an intentional inventory guard: it asserts the
exact list of commands the public CLI registers, so a new top-level command cannot
appear without a reviewer seeing it. The list must therefore match the CLI, and a
genuinely shipped command must be added to the expected inventory rather than the
guard being loosened.

## Root cause

This branch registers the `app-server` command in the CLI entry, but the inventory
list in the guard was never updated, so the guard failed with a single extra
element:

```
@@ -5,3 +5,3 @@
    "acp",
+   "app-server",
    "skills",
```

## Red → green receipt

RED (before the fix):

```
bun test packages/coding-agent/test/cli-command-surface.test.ts
 21 pass  1 fail  120 expect() calls
```

GREEN (after adding `app-server` to the expected inventory, in registration order
between `acp` and `skills`):

```
bun test packages/coding-agent/test/cli-command-surface.test.ts
 22 pass  0 fail  120 expect() calls
```

The guard keeps its strength: it still asserts the complete list with `toEqual`, so
any future unreviewed command still fails it.
