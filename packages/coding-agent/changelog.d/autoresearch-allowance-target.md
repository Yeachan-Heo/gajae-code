### Fixed

- The autoresearch research-only allowance no longer passes a mutation that names no target. It was keyed on `targets.paths.every(isAuthorized)`, which is vacuously true for an empty list, and it ran ahead of the fail-closed check, so an opaque interpreter write such as `python3 -c "open('src/product.ts','w').write('x')"` was returned as allowed on a research mission. The allowance now requires at least one named target and no unanalyzable mutation; `autoresearch.sh` stays writable.
