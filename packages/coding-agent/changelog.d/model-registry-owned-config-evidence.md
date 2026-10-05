### Fixed
- Compare discovery preflight, cached authorization, and peek evidence against the registry's actual configuration owner. Sibling config/fallback changes do not invalidate an unrelated registry, while own changes and shared credential replacement retain their invalidation fences.
- Preserve authoritative discovery cache provenance when installing the registry's initial resolver, without activating owner-specific OAuth registration or CLI login/usage paths.
- Reject discovery and cache publication after the owner's effective fallback configuration changes during a request, preserving explicit credentialless policy and the existing idle state of stale discovery results.
