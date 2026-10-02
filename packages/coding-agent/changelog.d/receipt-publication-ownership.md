### Fixed

- Keep managed replacement receipts owned by their exact publishing attempt until it settles, preventing concurrent sessions in one workspace from stealing active receipts and failing transcript persistence with `identity_mismatch`. Peer recovery of publisher-bound receipts requires positive owner-exit or PID-reuse evidence; orphan receipt identity checks and external transcript replacement guards remain intact.
