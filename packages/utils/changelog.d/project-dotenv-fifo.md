### Fixed

- A FIFO (or other non-regular file) as a project `.env`, `.env.local`, or other dotenv layer no longer hangs GJC at startup. Even `gjc --version` used to block before argument parsing, because GJC's own dotenv readers (several of which run at import time) opened the file with a blocking read, while Bun's autoload skips it. Every reader now opens the file non-blocking and reads it only if it is a regular file. A skipped layer marks `projectEnvSnapshot` incomplete, the same as the bounded reads already did. Closes #7428.
