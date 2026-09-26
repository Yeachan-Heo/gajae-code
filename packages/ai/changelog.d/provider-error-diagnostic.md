### Added

- Anthropic failures now carry an optional bounded `providerDiagnostic` (`category`, `httpStatus`, `code`, `evidence`) on the terminal assistant message, minted only from structured SDK error metadata or an explicit SSE `event: error` envelope. It distinguishes auth rejections, rate limits and upstream outages without exposing provider text, and contradictory, unsupported or unreadable metadata produces no diagnostic at all. The legacy `errorStatus`, error messages, retry admission and fallback behaviour are unchanged.
