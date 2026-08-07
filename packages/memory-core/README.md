# @gajae-code/memory-core

`@gajae-code/memory-core` is a provider-independent, deterministic, local-first filesystem memory engine for Gajae-Code.

## Package boundary

This package is opt-in and inert until a consumer explicitly supplies an initialized memory root and invokes it. It owns the provider-independent local Markdown/MAP memory substrate and its strict, fail-closed policy boundary.

It does not own:

- CLI, TUI, session-runtime, provider, model, database, or network behavior.
- Ambient `cwd`, environment-variable, profile, or session discovery.
- Root, repository, identity, or session resolution; consumers inject the resolved environment and identity.

Filesystem access is gated by initialization and policy checks. Consumers remain responsible for choosing when to enable the package and for supplying the resolved environment required by each operation.
