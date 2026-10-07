### Changed
- Production rollout of durable logical-session task-artifact ownership is deferred; persistent sessions still key artifacts by transcript basename. `SessionManager#getOrCreateArtifactManager` remains under development.
- Preserve previously admitted artifact capabilities across session reset while assigning the successor a distinct owner. Keep staged child artifact adoption and legacy artifact-tree publication intact, and propagate required owner-allocation failures through SDK tools.
