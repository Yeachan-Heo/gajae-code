### Fixed

- Live SDK sessions periodically ensure their broker remains available instead of requiring a new CLI invocation after broker loss. Recovery uses the existing ownership-fenced startup path and stops with the session runtime.
- Keep standalone Telegram command reception alive across periods with no attached sessions, so a temporary routing outage does not remove the remote recovery interface.
