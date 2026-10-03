### Added

- Stage images on both standalone and notification SDK hosts using authenticated, one-shot upload references while preserving original bytes and MIME under the existing 256 KiB frame cap.
- Enforce pending, accepted and shared decode/copy allocation budgets; retain accepted capacity until exact consuming-run settlement or teardown, and prevent closed connection controls from recreating resources.
- Expire uploads after two minutes without successful staging progress; renew only live entries owned by the same authenticated connection and explicit batch, never rejected traffic or unrelated work.
