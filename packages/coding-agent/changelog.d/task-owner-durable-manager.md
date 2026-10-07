### Changed
- Defer durable logical-session artifact-owner production after reverting its activation. Persistent sessions continue to use transcript-basename artifact storage; owner-aware cleanup APIs do not imply that producer activation has shipped.
