### Fixed

- A provider's cached model list in `models.db` is now rewritten after a successful models.dev fetch even when the stored row was written under a different discovery provenance, so `/model` lists newly published models (such as `anthropic/claude-fable-5-2`) instead of keeping an old snapshot forever. The rewrite uses compare-and-swap and is skipped when another writer changed the row concurrently (#7748).
