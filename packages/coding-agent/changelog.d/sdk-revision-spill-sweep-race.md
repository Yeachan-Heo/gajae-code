### Fixed

- SDK queries no longer fail with `ENOENT … /sdk/snapshots/<session>/objects/<hash>` when another query's snapshot sweep runs while their result is being written. This hit clients that reconnected after the 15-minute snapshot TTL and issued several queries at once.
