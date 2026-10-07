# Pre-tool hook examples

These files are examples for GJC's project-local loose hook surface. Review an example before enabling it, then copy the selected file to the canonical tool hook path under `.gjc/hooks/pre/`.

## HOL Guard command preflight

`bash-hol-guard.ts` shows how a project can put HOL Guard in front of Bash tool calls without rebuilding Guard logic inside GJC. Copy it to:

```text
.gjc/hooks/pre/bash.ts
```

The example invokes `hol-guard command test <command> --json` directly and proceeds only when Guard reports both an explicitly benign classification and `minimum_action: allow`. Because that Guard command evaluates command text rather than caller-supplied Bash environment overrides, the example blocks any `env` override instead of allowing an execution shape Guard did not inspect. A timeout, CLI failure, malformed result, review requirement, unsupported environment override, or stricter action blocks the Bash tool call. Timeout cleanup waits for the Guard child process and escalates to a forceful kill within a bounded grace period before returning.

Install HOL Guard separately and keep `hol-guard` available on `PATH`. This example is additive to the target project's own authentication, permissions, review, and recovery controls.
