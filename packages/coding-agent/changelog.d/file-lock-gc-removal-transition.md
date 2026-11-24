### Fixed

- `gjc gc` no longer fails with `EPERM: operation not permitted, scandir '<file>.lock.removing'` on Windows when it runs while another `gjc` process is releasing a file lock. File-lock discovery no longer descends into a lock's removal transition, which never contains a lock.
