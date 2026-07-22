# Secret Obfuscation

Prevents sensitive values (API keys, tokens, passwords) from being sent to LLM providers. When enabled, secrets are replaced with authenticated placeholders before leaving the process, and restored in tool call arguments returned by the model.

## Enabling

Disabled by default. Toggle via `/settings` UI or directly in `config.yml`:

```yaml
secrets:
  enabled: true
```

## How it works

1. On session startup, secrets are collected from two sources:
   - **Environment variables** whose names match common secret patterns (`KEY`, `SECRET`, `TOKEN`, `PASSWORD`, `PASS`, `AUTH`, `CREDENTIAL`, `PRIVATE`, `OAUTH`) with values >= 8 characters
   - **`secrets.yml` files** (see below)

2. Outbound text messages to the LLM have secret values replaced with authenticated, versioned placeholders like `#GJC1_…#`.

3. Session context/tool arguments returned from the model are deep-walked and obfuscation placeholders are restored to original values before display or execution.

Two modes control what happens to each secret:

| Mode                  | Behavior                                        | Reversible                                      |
| --------------------- | ----------------------------------------------- | ----------------------------------------------- |
| `obfuscate` (default) | Replaced with authenticated `#GJC1_…#` token    | Yes (deobfuscated in tool args/session context) |
| `replace`             | Replaced with deterministic same-length string | No (one-way)                                    |

Authenticated placeholders use a process-local key. Plain-secret tokens remain stable across sessions, reloads, and forks within the running process; after a process restart, earlier tokens intentionally remain opaque.

Regex-discovered tokens are reversible only by the originating obfuscator instance. A fresh obfuscator in the same process or after restart keeps them opaque because regex matches are not reconstructed from persisted placeholders.

## secrets.yml

Define custom secret entries in YAML. Two locations are checked:

| Level   | Path                       | Purpose                     |
| ------- | -------------------------- | --------------------------- |
| Global  | `~/.gjc/agent/secrets.yml` | Plain and regex secrets across all projects |
| Project | `<cwd>/.gjc/secrets.yml`   | Project-specific plain secrets              |

Project plain entries override global plain entries with matching `content`; a global regex with the same `content` remains active. Project-scope regex entries are ignored because workspace-contained files are not trusted to supply executable regex patterns. This project scope includes `<cwd>/.gjc/secrets.yml` and any caller-supplied agent directory whose lexical or canonical path is contained within the workspace.

### Schema

Each entry in the array has these fields:

| Field         | Type                         | Required | Description                                       |
| ------------- | ---------------------------- | -------- | ------------------------------------------------- |
| `type`        | `"plain"` or `"regex"`       | Yes      | Match strategy                                    |
| `content`     | string                       | Yes      | The secret value (plain) or regex pattern (regex) |
| `mode`        | `"obfuscate"` or `"replace"` | No       | Default: `"obfuscate"`                            |
| `replacement` | string                       | No       | Custom replacement (replace mode only)            |
| `flags`       | string                       | No       | Regex flags (regex type only)                     |

### Examples

#### Plain secrets

```yaml
# Obfuscate a specific API key (default mode)
- type: plain
  content: sk-proj-abc123def456

# Replace a database password with a fixed string
- type: plain
  content: hunter2
  mode: replace
  replacement: "********"
```

#### Regex secrets

Regex entries are supported only by agent configuration outside the current workspace (normally `~/.gjc/agent/secrets.yml`). Use `type: plain` for workspace-contained configuration.

```yaml
# Obfuscate any AWS-style key
- type: regex
  content: "AKIA[0-9A-Z]{16}"

# Case-insensitive match with explicit flags
- type: regex
  content: "api[_-]?key\\s*=\\s*\\w+"
  flags: "i"

# Regex literal syntax (pattern and flags in one string)
- type: regex
  content: "/bearer\\s+[a-zA-Z0-9._~+\\/=-]+/i"
```

Regex entries always scan globally (the `g` flag is enforced automatically). The regex literal syntax `/pattern/flags` is supported as an alternative to separate `content` + `flags` fields. Escaped slashes within the pattern (`\\/`) are handled correctly. The sticky `y` flag is rejected because it would prevent global scanning.

#### Replace mode with regex

```yaml
# One-way replace connection strings (not reversible)
- type: regex
  content: "postgres://[^\\s]+"
  mode: replace
  replacement: "postgres://***"
```

## Interaction with env var detection

Environment variables are collected first, then file-defined entries are appended. File entries can cover secrets that don't live in env vars (config files, hardcoded values, etc.). If the same plain value appears in both env and file entries, the env entry's obfuscate-mode mapping is used first.

## Key files

- `packages/coding-agent/src/secrets/index.ts` -- loading, merging, env var collection
- `packages/coding-agent/src/secrets/obfuscator.ts` -- `SecretObfuscator` class, placeholder generation, message obfuscation
- `packages/coding-agent/src/secrets/regex.ts` -- regex literal parsing and compilation
- `packages/coding-agent/src/config/settings-schema.ts` -- `secrets.enabled` setting definition

## See also

- [`auth-broker-gateway.md`](./auth-broker-gateway.md) -- remote credential vault and forward-proxy that keep provider OAuth refresh tokens and access tokens off developer hosts entirely (complementary to in-process obfuscation).
