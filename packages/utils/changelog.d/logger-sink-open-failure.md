### Fixed

- A log file that cannot be opened or written (permission denied, the path taken by a directory, too many open files, or the log directory removed while gjc runs) no longer crashes the process from the next `logger` call. `winston-daily-rotate-file` never listened for errors on its underlying file stream, so the failure surfaced as an uncaught exception; the logger now drops the record instead, as it already intended for logging failures.
