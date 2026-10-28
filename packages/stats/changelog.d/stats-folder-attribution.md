### Fixed

- Stats folder attribution reads the session header's recorded `cwd`, so sessions stored under the v2 managed `v2-<digest>` directories show their real project path in the `gjc stats` folder summary and dashboard instead of the opaque digest; existing databases re-parse sessions once to repair stored folder values.
