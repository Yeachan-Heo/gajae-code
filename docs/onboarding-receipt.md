# Onboarding Packet Receipt

- Date: 2026-06-01
- Scope: docs-only no-new-skill onboarding packet experiment for this repository.
- Output files:
  - `docs/onboarding-packet.md`
  - `docs/onboarding-receipt.md`
- Public-safe boundary: no secrets, tokens, hidden prompts, private infrastructure, internal ops, or private paths beyond repo-relative paths.
- Product boundary: no new skill, command, agent slot, issue, config, or runtime behavior.

## Evidence inspected

- `README.md`
- `docs/codebase-overview.md`
- `package.json`
- `packages/coding-agent/package.json`
- `packages/coding-agent/src/cli.ts`
- `packages/coding-agent/src/main.ts`
- `packages/coding-agent/src/sdk/session.ts`
- `packages/coding-agent/src/defaults/gjc-defaults.ts`
- `packages/coding-agent/src/task/agents.ts`
- `packages/coding-agent/test/default-gjc-definitions.test.ts`
- `.github/workflows/ci.yml`
- `.github/workflows/dev-ci.yml`

## Result

The packet records repo purpose, package layout, main entrypoints, build/test commands, danger zones, unknowns, and first safe tasks without changing the product surface. It is suitable as a public context seed for future onboarding experiments, not as a feature intake mechanism.

## Caveats

- The attempted `omx question --input '<json>' --json` interview round failed before user input because the runtime reported no attached tmux client; no human answer was inferred from that failed call.
- Public issue context is limited to the user-provided prompt summary for this run.
- Full CI was not required for the docs-only artifact unless later code/runtime files change.
