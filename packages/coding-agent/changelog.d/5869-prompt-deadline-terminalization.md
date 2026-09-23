### Fixed

- SDK prompt deadlines no longer publish a terminal failure while a correlated turn or dispatched tool may still be running; verified runs stop with their terminal event, while unproven runs retain a recoverable in-flight status (#5869).
