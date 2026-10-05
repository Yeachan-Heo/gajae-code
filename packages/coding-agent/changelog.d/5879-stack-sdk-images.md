### Added

- Stage images on both standalone and notification SDK hosts using authenticated, one-shot upload references while preserving original bytes and MIME under the existing 256 KiB frame cap.
- Enforce pending, accepted and shared decode/copy allocation budgets; retain accepted capacity until exact consuming-run settlement or teardown, and prevent closed connection controls from recreating resources.
- Expire uploads after two minutes without successful staging progress; renew only live entries owned by the same authenticated connection and explicit batch, never rejected traffic or unrelated work. Enforce elapsed expiry even when cleanup callbacks are delayed, including redemption and in-flight finalization.

### Fixed

- Authenticate existing managed scope bindings and retained filesystem identities before cold cleanup recovery; never initialize or repair missing storage as a recovery shortcut.
- Re-certify a stale cleanup-completion digest only after independently verified completion through an exact descriptor-backed replacement; refuse destination swaps and replacement failures without replaying transcript deletion.
- Omit explicitly cleared optional owner fields from SDK cleanup replay decoding, matching their persisted JSON shape while retaining strict validation of present owner evidence and refusing replaced scope authority.
- Refuse task-owner capability publication when the existing transcript cannot durably accept its locator; retain uncertainty and close the unreturned owner without recreating a removed transcript.
