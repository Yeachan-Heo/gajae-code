### Fixed

- Cron schedules whose day-of-month or day-of-week field starts with `*` (including stepped forms like `*/2`) now follow vixie-cron semantics: that field counts as unrestricted, so when the other day field is restricted both must match. Expressions such as `0 0 */2 * 1` no longer fire on every stepped day; they fire only when the weekday also matches.
- The `cron` tool's `cron_expression` schema description now states this rule explicitly: a day field counts as restricted only when it does not start with `*`.
