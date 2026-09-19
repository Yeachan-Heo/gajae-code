### Fixed

- Managed session rewrites that exceed the per-file transcript cap no longer leak a raw `content_too_large` rejection. The atomic rewrite path now reports a typed `SessionNearLimitRewriteError` with the rejected transcript size and cap, while the append recovery path keeps converting the same overflow into `SessionNearLimitAppendError` with fields derived from the appended entry.
