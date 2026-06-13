# Grok Build provider design

## Status

Proposal for maintainer design review. This document intentionally does not add a bundled provider implementation. It records the product/API decisions that must be accepted before any Grok Build implementation PR should land.

This is not an authorization claim for xAI endpoints, not a final naming decision, not approval for a bundled-loading exception, and not trademark/display-name approval. Those items require explicit owner sign-off before implementation.

## Required owner sign-off gates

Implementation should remain blocked until the owner signs off on these gates:

1. **Authorized use / ToS** — confirm that GJC may use `cli-chat-proxy.grok.com` and the xAI CLI OAuth public client from a third-party tool. A public OAuth client id is not proof that this use is authorized.
2. **Bundled-loading trust boundary** — confirm whether a source-controlled bundled provider may load even when ordinary user extension discovery is disabled.
3. **Public selector naming** — choose the stable provider selector prefix: `grok-cli`, `grok-build`, or another owner-selected id.
4. **Trademark/display-name** — confirm whether GJC may present the provider/profile using `Grok Build` or should use a more neutral owner-approved label.

If gate 1 is not accepted, the Grok Build provider implementation should not ship against `cli-chat-proxy.grok.com`. The fallback direction would be a documented user-supplied xAI/API-key provider or a different officially authorized integration path.

## Problem

GJC can load third-party extensions, but the first-run interactive path needs a maintainer-owned decision before a bundled Grok Build provider can be accepted. The desired product flow is:

```text
gjc -> /login -> OAuth -> Grok Build -> browser xAI login -> /model -> <provider-id>/grok-composer-2.5-fast
```

The previously proposed implementation touched bundled extension loading, OAuth registration, model profiles, vendor code, usage reporting, and tests in one PR. That is too much surface for review without first agreeing on the provider contract and the owner sign-off gates above.

## Goals

- Keep Grok Build, if accepted, as a bundled provider extension rather than a workflow skill.
- Preserve the existing four bundled workflow skills and four role agents.
- Define the `/login` OAuth contract for an owner-approved display name, with `Grok Build` only as a candidate label.
- Define the `/model` contract for `grok-composer-2.5-fast` without committing to the final selector prefix before owner sign-off.
- Define the guardrails for any bundled provider that loads while ordinary extension discovery is disabled.
- Keep credentials in the existing auth storage path; no tokens or user env values are checked into the repo.
- Keep implementation PRs small enough for independent review, rejection, or rollback.

## Non-goals

- No new workflow command or `/skill` surface.
- No automatic installation from npm or remote code at runtime.
- No direct `packages/ai/src/models.json` edits.
- No broad model-profile reshuffle.
- No provider-specific secrets in source.
- No claim that xAI has authorized this endpoint/client usage without owner review.

## Candidate provider contract

These are candidate values for owner review, not final commitments:

| Field | Candidate value | Decision status | Notes |
| --- | --- | --- | --- |
| Public provider id | `grok-cli` or `grok-build` | **Owner decision required** | See naming section below. |
| Display name | `Grok Build` or owner-selected label | **Owner decision required** | Name shown in `/login` and UI surfaces; see trademark/display-name section below. |
| Default model id | `grok-composer-2.5-fast` | Proposed | Full selector depends on final provider id. |
| Secondary model id | `grok-build` | Proposed | Candidate for executor/architect roles if a profile is accepted. |
| Base URL | `https://cli-chat-proxy.grok.com/v1` | **Authorized-use sign-off required** | Undocumented/private-looking endpoint; do not ship without owner approval. |
| OAuth issuer | `https://auth.x.ai` | **Authorized-use sign-off required** | OIDC discovery must validate xAI-owned HTTPS endpoints. |
| OAuth callback | loopback `127.0.0.1` | Proposed | Uses PKCE + state validation. |
| API adapter | `grok-cli-responses` | Proposed internal name | Provider-specific stream adapter; not a new generic API shape. |
| Env bypass | `GROK_CLI_OAUTH_TOKEN` | Optional follow-up | Local bypass only; no refresh or discovery guarantees. |

## Authorized-use and ToS caveat

`cli-chat-proxy.grok.com` and the xAI CLI OAuth public client appear to be designed for xAI/Grok CLI traffic. Reusing them from GJC may be technically possible but still unauthorized or contrary to xAI terms.

Before implementation, the owner should explicitly decide one of:

- **Accept** — proceed with this integration after reviewing the legal/product risk.
- **Defer** — keep this design document only; no code ships until authorization is clarified.
- **Reject** — do not integrate against `cli-chat-proxy.grok.com`; use only an official public API path.

Implementation PRs must not describe the public client id as a secret, but they also must not present it as authorization. Tests should avoid real tokens and should not require an xAI account.

## Trademark/display-name caveat

`Grok` and `xAI` are third-party marks. `Grok Build` may also imply an official xAI/Grok product relationship even when the integration is third-party. Before implementation, the owner should explicitly choose one of:

- **Use `Grok Build`** — acceptable as the user-facing provider/profile label after trademark/product-risk review.
- **Use a neutral label** — for example `xAI Grok`, `Grok OAuth`, or another owner-selected name that avoids implying official endorsement.
- **Avoid built-in branding** — keep any Grok-specific naming only in user-provided configuration until authorization/branding is clarified.

Implementation PRs should avoid lock-in language such as "official" unless there is explicit authorization. UI labels, profile names, docs, tests, and screenshots must all use the owner-approved label consistently.

## OAuth behavior

If authorized-use is accepted, the OAuth implementation should use the existing custom OAuth provider path:

1. The chosen provider id registers an OAuth provider using the owner-approved display name.
2. `/login` calls the existing auth storage login path for that provider.
3. The provider opens an xAI authorization URL using OIDC discovery, PKCE, `state`, and a loopback callback.
4. The callback exchanges the authorization code for access and refresh tokens.
5. Credentials are stored by the existing auth storage code path.
6. Refresh uses the stored refresh token and validates the token endpoint origin.

Security constraints:

- OIDC `authorization_endpoint` and `token_endpoint` must be HTTPS and under owner-approved xAI hosts.
- The callback server binds to loopback by default.
- The callback must reject state mismatches.
- Access and refresh tokens must not be logged, rendered, committed, or included in tests.
- Error messages may include status and provider error text, but not credential values.
- Env overrides for base URL, scope, callback host, or client id must be treated as local developer/debug escape hatches, not default product behavior.

## Bundled-loading trust boundary

A bundled provider is different from ordinary user extension discovery, but loading it while `disableExtensionDiscovery: true` still expands the bootstrap trust boundary. Owner sign-off is required before implementation.

Minimum guardrails if accepted:

- Load only source-controlled, maintainer-reviewed bundled provider paths.
- Use a static allowlist or exported enumerator; never scan arbitrary user directories for this path.
- Do not install, fetch, or resolve remote package code at runtime.
- Keep ordinary user extension discovery disabled when `disableExtensionDiscovery: true`; the exception is only for bundled provider defaults.
- Add tests proving bundled providers load before model selection and caller-supplied `additionalExtensionPaths` still coexist.
- Keep this bootstrap change separate from the Grok vendor implementation so it can be reviewed independently.

Alternatives the owner may choose:

- Do not load bundled providers when extension discovery is disabled; require explicit setup/defaults install.
- Gate bundled provider loading behind a setting or compile-time default.
- Allow bundled loading only in packaged builds, not arbitrary source checkouts.

## Provider selector naming

The selector prefix is a stable user-facing contract and must be chosen before implementation.

| Option | Example selector | Pros | Cons |
| --- | --- | --- | --- |
| `grok-cli` | `grok-cli/grok-composer-2.5-fast` | Matches the upstream CLI/proxy lineage and existing prototype. | User-facing name is less aligned with `Grok Build`; may expose implementation detail. |
| `grok-build` | `grok-build/grok-composer-2.5-fast` | Matches UI label and requested product wording. | Diverges from existing prototype and env names; migration needed if prototypes used `grok-cli`. |
| Owner-selected third id | `<id>/grok-composer-2.5-fast` | Lets maintainers align with broader provider taxonomy. | Requires updating all docs/tests before implementation. |

Until this is decided, implementation docs and PRs should use `<provider-id>` when describing the public selector. Internal adapter names may still use `grok-cli-responses` if maintainers accept that as an implementation detail.

## Model/profile behavior

Model registration should be provider-owned. If accepted, the provider should register at least:

- `grok-composer-2.5-fast`
- `grok-build`

A built-in profile is optional and should be reviewed separately. If accepted, a candidate profile is:

```text
grok-pro.default   -> <provider-id>/grok-composer-2.5-fast
grok-pro.planner   -> <provider-id>/grok-composer-2.5-fast
grok-pro.critic    -> <provider-id>/grok-composer-2.5-fast
grok-pro.executor  -> <provider-id>/grok-build
grok-pro.architect -> <provider-id>/grok-build
```

If maintainers prefer not to add a built-in profile, the provider can still satisfy the core `/login` and `/model` flow through direct model selection.

## Usage reporting behavior

Usage reporting should be an optional follow-up after login/model support lands:

- Provider id: the owner-selected `<provider-id>`.
- Fetches usage with the effective OAuth access token.
- Returns `null` when no token is available.
- Does not require the usage provider for chat/model selection to work.
- Should be skipped entirely if the authorized-use gate is not accepted.

## Staged PR plan

### PR 1: this design document

Purpose: agree on caveats, owner sign-off gates, provider id, OAuth contract, bundled-loading trust boundary, model selector, security boundaries, and implementation split.

### PR 2: bundled provider bootstrap contract

Small core change only, after owner sign-off on the bundled-loading gate:

- Add a maintainer-owned way to enumerate bundled provider extension paths.
- Load those paths during session/bootstrap only under the accepted guardrails.
- Add tests proving bundled providers and caller-supplied extension paths coexist.

No Grok vendor implementation in this PR.

### PR 3: Grok Build provider extension

Provider implementation only, after owner sign-off on authorized use, public selector naming, and trademark/display-name:

- Add bundled Grok Build provider source.
- Register the chosen provider id, OAuth provider, and models.
- Include sanitize and provider-specific stream handling.
- Test `/login` provider registration and `grok-composer-2.5-fast` model availability.

### PR 4: profile and model defaults

Optional product-surface PR:

- Add `grok-pro` only if maintainers accept a built-in profile.
- Add model profile catalog tests.

### PR 5: usage reporting

Optional observability PR:

- Add usage provider for the owner-selected provider id.
- Add focused usage tests.

## Acceptance criteria for the implementation series

- Owner sign-off is recorded for authorized use, bundled loading, selector naming, and trademark/display-name before implementation lands.
- Fresh checkout test proves `createAgentSession` registers the bundled provider under the accepted bootstrap rules.
- `/login` includes the owner-approved display name for the owner-selected provider id.
- `/model` includes `<provider-id>/grok-composer-2.5-fast`.
- A real OAuth URL redirects to the owner-approved xAI account login page.
- Third-party extension paths still load alongside bundled providers when configured.
- Token values never appear in tests, logs, checked-in docs, or git history.

## Open maintainer decisions

- Is using `cli-chat-proxy.grok.com` plus the xAI CLI OAuth client from GJC authorized and acceptable for this project?
- Should bundled provider defaults load while `disableExtensionDiscovery: true`, and under which guardrails?
- Should the final public provider id be `grok-cli`, `grok-build`, or another id?
- May GJC use `Grok Build` as the display/profile name, or should the integration use a neutral owner-selected label?
- Should `grok-pro` be a built-in profile or documented as a user profile?
- Should usage reporting be included in the initial provider PR or kept as a separate follow-up?