### Fixed

- A run that fails with the generic `Agent run failed.` now logs its underlying cause (error name, message, `cause` chain, and a short stack) as a `warn` entry in the local gjc log, with credentials redacted. The transcript and SDK clients still receive only the generic message; previously the cause was discarded entirely, so these failures could not be diagnosed.
