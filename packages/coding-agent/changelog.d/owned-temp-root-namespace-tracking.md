### Fixed

- `gjc gc` no longer prunes a live temp root owned by a process in another PID namespace (for example a same-user container sharing the temp directory). On Linux, owned temp roots now record their PID namespace and are only reclaimed when it matches the collector's; roots from another namespace or without one are kept.
