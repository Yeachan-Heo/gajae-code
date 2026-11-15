### Fixed

- `gjc gc` no longer prunes a live temp root owned by a process on another host or in another PID namespace (for example a same-user container or machine sharing the temp directory). On Linux, owned temp roots now record an owner scope derived from the kernel boot id and PID namespace, and are only reclaimed when it matches the collector's; roots from another scope or without one are kept.
