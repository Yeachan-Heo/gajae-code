### Added

- Telegram notifications now announce when a foreground `bash` command prints a browser sign-in URL or device code and then waits (for example `tailscale up`, `az login --use-device-code`, `aws sso login`). The notice is sent once per command after 3 s without new output and carries only the prompt kind, never the URL or code, so it is also delivered under `notifications.redact` (#6852).
