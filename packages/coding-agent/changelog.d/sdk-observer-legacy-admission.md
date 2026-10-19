### Fixed

- SDK observer streams now deliver live tool activity only to authenticated clients that negotiated the required capabilities, without replaying it as durable history or exposing the prompt owner's identity.
- Legacy broker admission refusals now retain a fixed public diagnostic while keeping outcome certainty and retryability unknown.
