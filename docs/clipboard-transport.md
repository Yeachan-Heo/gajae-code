# Clipboard transport

By default (`clipboard.transport: auto`), GJC copies text by emitting OSC 52 over a real terminal and best-effort calling the native OS clipboard, and reads pasted images through the platform-specific bridge (native, or `powershell.exe` under WSL). This is unchanged from prior releases.

## Explicit transports

```bash
gjc --clipboard-transport <auto|native|osc52|ssh>
gjc --clipboard-ssh-host <alias>   # required when --clipboard-transport ssh
```

Or persist the equivalent settings:

```yaml
clipboard:
  transport: ssh
  sshHost: mac
```

Precedence is `CLI flag > persisted config > auto`. The CLI flag is an ephemeral runtime override — it is never written back to config.

- `auto` — current OSC52 + best-effort native behavior (default, unchanged).
- `native` — OS native clipboard only; never emits OSC 52.
- `osc52` — text copy only, via terminal OSC 52; never calls the native clipboard.
- `ssh` — every GJC text copy runs `ssh -o BatchMode=yes -o ConnectTimeout=3 -- <host> pbcopy` via argv spawn (never a shell string, so the host and payload cannot be reinterpreted as shell syntax) with exact UTF-8 stdin. The explicit "Paste text from configured clipboard" command-palette action (`app.clipboard.pasteText`, no default key — it never collides with the platform image-paste binding) runs `pbpaste` the same way and inserts the result at the cursor.

## `ssh` mode contract

- **Host validation**: `clipboard.sshHost` must be a non-empty alias with no leading dash, whitespace, or control characters. Invalid hosts are rejected before any process spawns.
- **Payload bounds**: outbound and inbound text must be valid UTF-8, contain no NUL byte or unpaired UTF-16 surrogate, and stay under 1 MiB; oversize or invalid payloads are rejected before spawning `ssh` (outbound) or abort the inbound stream before it is fully buffered (inbound — the 1 MiB check runs while draining, not after).
- **Fatal decoding**: inbound bytes are decoded as strict UTF-8 (`TextDecoder("utf-8", { fatal: true })`). Invalid remote bytes are rejected outright — never silently normalized to the U+FFFD replacement character.
- **Timeout**: the whole operation (connect + remote command + stdin write + stdout/stderr drain + exit) is bounded to 5 seconds; a hung `ssh` is killed and the operation fails.
- **No silent fallback**: unlike `auto`, explicit `ssh` mode never falls back to native clipboard or OSC 52 on failure — a nonzero exit, timeout, or validation failure raises a sanitized, user-visible error and leaves the editor and clipboard unchanged.
- **Privacy**: clipboard payloads are never written to logs, artifacts, or diagnostics. Only the operation name, host, and exit code/error class are recorded.

## Boundary

`clipboard.transport: ssh` only affects GJC's own text copy/paste actions (composer copy/paste, session dump, todo copy, debug log/SSE copy). It does not change how any other program on the host resolves `pbcopy`/`pbpaste`, and it does not add or read shell aliases. Image clipboard (`app.clipboard.pasteImage`) is unaffected — it continues to use the native/WSL PowerShell bridge described above.

## Related docs

- [Keybindings](./keybindings.md)
