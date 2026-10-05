### Fixed
- Persist managed task artifacts under a durable logical-session owner instead of the movable transcript basename, publish its locator before exposing artifacts or allocating initial task outputs and children, and authenticate the owner again when reopening a session.
- Preserve previously admitted artifact capabilities across session reset while assigning the successor a distinct owner. Keep staged child artifact adoption and legacy artifact-tree publication intact, and propagate required owner-allocation failures through SDK tools.
