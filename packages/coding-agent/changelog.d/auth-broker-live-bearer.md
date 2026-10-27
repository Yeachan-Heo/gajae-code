### Fixed

- `gjc auth-broker serve` re-reads the bearer token file on each request, so `token --regenerate` revokes the previous bearer while the broker is running.
