### Fixed

- Reading the SDK broker restart intent no longer fails with `ENOENT ... lstat '<agent>/sdk/broker.restart.json'` when the authorized successor clears the intent during the read. The cleared intent now reads as absent. Before, the race could refuse an ordinary broker startup.
