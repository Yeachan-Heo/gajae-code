### Fixed

- Windows native loading now installs a bounded Tokio runtime and probed Rayon pool before async or parallel work starts. If no safe Rayon workers can be created, cached grep uses its serial path rather than initializing Rayon’s default global pool.
