### Fixed

- Recover SDK broker startup when a stale lock's PID has been reused by a different process incarnation, serialize concurrent reclamation, and reap aged PID-reuse tombstones without weakening fail-closed behavior when incarnation evidence is unavailable. Lock reclamation now requires host qualification: only same-host owners are reclaimed using PID/incarnation evidence; foreign-host and host-unqualified (legacy) owners are never reclaimed from local PID evidence alone (#6719).
