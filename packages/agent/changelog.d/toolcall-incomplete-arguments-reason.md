### Fixed

- The typed `incompleteArgumentsReason` an adapter recorded on a tool-call block survives the accepted attempt snapshot. The snapshot rewrote every incomplete call to `malformed`, so a call the adapter had typed as `truncated`, `conflicting`, or `ambiguous` reached dispatch with only the boolean left and was reported with the generic wording.
- An incomplete tool call with no typed reason is no longer reported as an output-token-limit truncation unless the turn actually stopped for length, or as a decode failure the provider never declared. The rejection keeps the same actionable `Re-issue the call` guidance.
