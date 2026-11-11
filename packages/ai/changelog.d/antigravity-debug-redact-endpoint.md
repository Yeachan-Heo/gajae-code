### Fixed

- `GJC_DEBUG_ANTIGRAVITY_DISCOVERY=1` printed the discovery endpoint verbatim, so a custom `GOOGLE_ANTIGRAVITY_BASE_URL` carrying proxy credentials or a query key leaked them to stderr. The dump now prints the same origin-only form the debug logger already used. The variable is now documented in `docs/environment-variables.md`.
