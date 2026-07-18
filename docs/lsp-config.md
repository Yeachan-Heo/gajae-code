# LSP configuration in GJC

This guide explains how to configure language servers for the GJC coding agent.

Source of truth in code:

- Server config type: `packages/coding-agent/src/lsp/types.ts` (`ServerConfig`)
- Config loader: `packages/coding-agent/src/lsp/config.ts`
- Built-in server definitions: `packages/coding-agent/src/lsp/defaults.json`

## Auto-detection

When no LSP config file is present, GJC auto-detects servers by intersecting two conditions:

1. The project directory contains at least one of the server's `rootMarkers`.
2. The server binary is a trusted external executable. Project-local binaries, including paths reached through symlinks, are rejected.

No configuration is required for common setups. The built-in server list covers most popular languages; see [`defaults.json`](../packages/coding-agent/src/lsp/defaults.json) for the full set.

## Config file locations

GJC merges LSP config from multiple files, lowest to highest priority:

| Priority | Location |
|----------|----------|
| 5 (lowest) | `~/lsp.json`, `~/.lsp.json`, `~/lsp.yaml`, `~/.lsp.yaml` |
| 4 | Preloaded trusted external plugin LSP config outside the project (internal loader support; no current CLI/startup producer) |
| 3 | `~/.gjc/agent/lsp.json`, `~/.gjc/agent/lsp.yaml`, `~/.gemini/lsp.*` |
| 2 | `<project>/.gjc/lsp.json`, `<project>/.gjc/lsp.yaml`, `<project>/.gemini/lsp.*` |
| 1 (highest) | `<project>/lsp.json`, `<project>/.lsp.json`, `<project>/lsp.yaml` |

Each location accepts both `.json` and `.yaml` / `.yml` variants, as well as hidden-file versions (`.lsp.json`, `.lsp.yaml`). Configuration is merged in order, but project-controlled files can only control declarative server matching, activation, and capabilities. They cannot define or override a server's `command`, `args`, executable, client factory, `initOptions` / `initializationOptions`, or `settings`; opaque options that can instruct a trusted server belong to trusted user configuration.

The recommended trusted user configuration is `~/.gjc/agent/lsp.json` (or YAML equivalent). Legacy user-wide `~/.gemini/lsp.*` and home-root `~/lsp.*` / `~/.lsp.*` files are also outside the project and may define launch settings and opaque server options, including custom servers. Project files may refine declarative matching and activation fields of built-in or user-defined servers.

**Recommended locations:**

- Trusted user launch settings, `initOptions`, and `settings` → `~/.gjc/agent/lsp.json`
- Project-specific matching and activation → `<project>/.gjc/lsp.json`

> **Note:** The presence of any LSP config file disables auto-detection. When at least one file is found, GJC skips the binary-scan phase and loads matching, available, non-disabled servers using trusted launch definitions.

## File shape

Both JSON and YAML are accepted. The top-level object can use either a `servers` wrapper key or a flat map directly:

```json
{
  "servers": {
    "server-name": { ... }
  },
  "idleTimeoutMs": 300000
}
```

or (flat, without the `servers` wrapper):

```json
{
  "server-name": { ... },
  "idleTimeoutMs": 300000
}
```

Top-level keys:

- `servers` — map of server name to `ServerConfig` (optional wrapper; flat form is equivalent)
- `idleTimeoutMs` — shut down idle language servers after this many milliseconds; disabled by default

## ServerConfig fields

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `command` | `string` | trusted user config only | Server executable name or absolute path; project configuration cannot set or override it |
| `args` | `string[]` | no | Launch arguments; trusted user config only |
| `fileTypes` | `string[]` | yes | File extensions this server handles, e.g. `[".ts", ".tsx"]` |
| `rootMarkers` | `string[]` | yes | Files/dirs that indicate a project root; glob patterns (e.g. `*.cabal`) are supported |
| `initOptions` | `object` | trusted user config only | Sent as `initializationOptions` during LSP handshake |
| `settings` | `object` | trusted user config only | Workspace settings pushed via `workspace/didChangeConfiguration` |
| `disabled` | `boolean` | no | Set to `true` to disable this server entirely |
| `warmupTimeoutMs` | `number` | no | Startup timeout in ms for this server (overrides the global default) |
| `isLinter` | `boolean` | no | Mark server as linter/formatter only; excluded from type-intelligence operations (hover, go-to-definition, etc.) |
| `capabilities` | `object` | no | Opt-in server-specific features; see [Capabilities](#capabilities) |

`resolvedCommand` is populated automatically at runtime — do not set it manually.

### Capabilities

The `capabilities` object enables optional server-specific features that GJC supports on a per-server basis:

```json
{
  "capabilities": {
    "flycheck": true,
    "ssr": true,
    "expandMacro": true,
    "runnables": true,
    "relatedTests": true
  }
}
```

All fields are boolean and optional. They are currently used by `rust-analyzer`.

## Common recipes

### Override a built-in server's settings from trusted user configuration

Opaque server settings may contain process-affecting instructions, so place these partial overrides in trusted user configuration such as `~/.gjc/agent/lsp.json`:

```json
{
  "servers": {
    "typescript-language-server": {
      "settings": {
        "typescript": {
          "preferences": {
            "quoteStyle": "single"
          }
        }
      }
    }
  }
}
```

```yaml
servers:
  gopls:
    settings:
      gopls:
        gofumpt: false
        staticcheck: false
```

### Disable a built-in server

```json
{
  "servers": {
    "eslint": {
      "disabled": true
    }
  }
}
```

### Register a custom server

Register custom servers in the canonical trusted user configuration, `~/.gjc/agent/lsp.json`. New servers require `command`, `fileTypes`, and `rootMarkers`; `args` is optional. Project configuration cannot register a launch definition or override a server's command, arguments, executable, or client factory.

```json
{
  "servers": {
    "my-lsp": {
      "command": "my-lsp-server",
      "args": ["--stdio"],
      "fileTypes": [".xyz"],
      "rootMarkers": [".xyz-project", ".git"]
    }
  }
}
```

### Set a global idle timeout

Shut down language servers that have been inactive for more than five minutes:

```json
{
  "idleTimeoutMs": 300000
}
```

### Disable a server for one project, keep it globally

Place the override in `<project>/.gjc/lsp.json`:

```json
{
  "servers": {
    "pylsp": {
      "disabled": true
    }
  }
}
```

The user-level config in `~/.gjc/agent/lsp.json` is unaffected; pylsp is only suppressed in this project.

When multiple built-in primary servers support the same file, a default server can list lower-precedence servers in `supersedes`. For example, `csharp-ls` supersedes `omnisharp` only when both C# servers are installed and detected; if `csharp-ls` is unavailable, `omnisharp` remains the fallback.

## lspmux

`GJC_DISABLE_LSPMUX=1` is the canonical opt-out. `PI_DISABLE_LSPMUX=1` is a supported compatibility alias. A truthy value for either variable disables lspmux probing and wrapping.

## Built-in server list

The following servers ship in `defaults.json` and are eligible for auto-detection:

| Server key | Language(s) | Binary |
|---|---|---|
| `rust-analyzer` | Rust | `rust-analyzer` |
| `clangd` | C, C++, ObjC | `clangd` |
| `zls` | Zig | `zls` |
| `gopls` | Go | `gopls` |
| `typescript-language-server` | TypeScript, JavaScript | `typescript-language-server` |
| `denols` | TypeScript, JavaScript (Deno) | `deno` |
| `biome` | TS/JS/JSON (linter) | `biome` |
| `eslint` | TS/JS/Vue/Svelte (linter) | `vscode-eslint-language-server` |
| `vscode-html-language-server` | HTML | `vscode-html-language-server` |
| `vscode-css-language-server` | CSS, SCSS, Less | `vscode-css-language-server` |
| `vscode-json-language-server` | JSON | `vscode-json-language-server` |
| `tailwindcss` | HTML, CSS, TS/JS | `tailwindcss-language-server` |
| `svelte` | Svelte | `svelteserver` |
| `vue-language-server` | Vue | `vue-language-server` |
| `astro` | Astro | `astro-ls` |
| `pyright` | Python | `pyright-langserver` |
| `basedpyright` | Python | `basedpyright-langserver` |
| `pylsp` | Python | `pylsp` |
| `ruff` | Python (linter) | `ruff` |
| `jdtls` | Java | `jdtls` |
| `kotlin-lsp` | Kotlin | `kotlin-lsp` |
| `metals` | Scala | `metals` |
| `hls` | Haskell | `haskell-language-server-wrapper` |
| `ocamllsp` | OCaml | `ocamllsp` |
| `elixirls` | Elixir | `elixir-ls` |
| `erlangls` | Erlang | `erlang_ls` |
| `gleam` | Gleam | `gleam` |
| `solargraph` | Ruby | `solargraph` |
| `ruby-lsp` | Ruby | `ruby-lsp` |
| `rubocop` | Ruby (linter) | `rubocop` |
| `bashls` | Bash, Zsh | `bash-language-server` |
| `lua-language-server` | Lua | `lua-language-server` |
| `intelephense` | PHP | `intelephense` |
| `phpactor` | PHP | `phpactor` |
| `csharp-ls` | C# | `csharp-ls` |
| `omnisharp` | C# | `omnisharp` |
| `yamlls` | YAML | `yaml-language-server` |
| `terraformls` | Terraform | `terraform-ls` |
| `dockerls` | Dockerfile | `docker-langserver` |
| `helm-ls` | Helm | `helm_ls` |
| `nixd` | Nix | `nixd` |
| `nil` | Nix | `nil` |
| `ols` | Odin | `ols` |
| `dartls` | Dart | `dart` |
| `marksman` | Markdown | `marksman` |
| `texlab` | LaTeX | `texlab` |
| `graphql` | GraphQL | `graphql-lsp` |
| `prismals` | Prisma | `prisma-language-server` |
| `vimls` | Vim script | `vim-language-server` |
| `emmet-language-server` | HTML, CSS, JSX | `emmet-language-server` |
| `sourcekit-lsp` | Swift | `sourcekit-lsp` |
| `swiftlint` | Swift (linter) | `swiftlint` |
| `tlaplus` | TLA+ | `tlapm_lsp` |
