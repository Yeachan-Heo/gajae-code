### Fixed

- The SDK broker's session-index rejection audit (`index-audit.jsonl`) no longer grows without bound or makes every cold SDK client parse all of it under the machine-global index lock. Long-lived readers now catch up on rows other processes appended instead of re-archiving them from a once-seeded view, and an audit past 4 MiB (and past twice the current rejections) rotates to `index-audit.jsonl.1` before it is read.
