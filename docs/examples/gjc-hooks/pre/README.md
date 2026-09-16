# Pre-tool hook examples

These files are examples for GJC's project-local loose hook surface. Review an example before enabling it, then copy the selected file to the canonical tool hook path under `.gjc/hooks/pre/`.

## PR preflight

`bash.ts` is the repository's own PR-contract preflight. Copy it to:

```text
.gjc/hooks/pre/bash.ts
```

It is specific to this repository and should not be installed as a user-global hook.

## HOL Guard command preflight

`bash-hol-guard.ts` shows how a project can put HOL Guard in front of Bash tool calls without rebuilding Guard logic inside GJC. Copy it to:

```text
.gjc/hooks/pre/bash.ts
```

The example invokes `hol-guard command test <command> --json` directly and proceeds only when Guard reports both an explicitly benign classification and `minimum_action: allow`. A timeout, CLI failure, malformed result, review requirement, or stricter action blocks the Bash tool call.

Install HOL Guard separately and keep `hol-guard` available on `PATH`. This example is additive to the target project's own authentication, permissions, review, and recovery controls.

Do not install both Bash examples at the same path. Choose the policy boundary appropriate for the project or combine the logic deliberately in one reviewed local hook.
