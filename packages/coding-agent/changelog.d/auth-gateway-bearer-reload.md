### Fixed

- `gjc auth-gateway serve` re-reads `auth-gateway.token` on each request, so `token --regenerate` retires the previous bearer without a restart.
