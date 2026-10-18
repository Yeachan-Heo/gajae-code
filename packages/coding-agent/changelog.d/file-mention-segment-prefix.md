### Fixed

- Stop `@word` mentions that name no file (chat handles such as `(@handle)` in gateway speaker headers, email addresses) from auto-attaching an unrelated workspace file: the fuzzy fallback now requires the query to spell prefixes of path segments in order instead of any scattered subsequence.
