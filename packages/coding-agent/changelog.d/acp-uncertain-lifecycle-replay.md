### Fixed

- ACP session launches now recover a lost broker lifecycle response by replaying the same idempotency key, instead of immediately failing `session/new` when the original request may have committed.
- ACP lifecycle uncertainty replays now consume the original operation deadline without extending the shared SDK client deadline.
