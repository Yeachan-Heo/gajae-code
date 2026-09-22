### Fixed

- Session host liveness now tracks admitted, queued, and continuing session work with a reference-counted lease, preventing idle reaping while work remains pending (#5652).
