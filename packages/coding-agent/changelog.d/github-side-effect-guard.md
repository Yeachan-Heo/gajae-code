### Fixed

- Side-effect `github` operations (`pr_create`, `pr_checkout`, `pr_push`) now go through the session approval gate and the planning-phase mutation guard, while read-only operations stay available.
