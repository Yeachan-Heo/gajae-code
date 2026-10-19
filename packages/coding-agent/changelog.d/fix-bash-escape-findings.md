### Fixed

- Planning mutation guard now blocks Node preload options (`-r`/`--require`) when stdout writes are exempted, as preload code cannot be scanned.
- Aliased stdout stream mutations are now detected: commands that pass `process.stdout` through function parameters or arrow functions are blocked during planning, as the method may be rebound.
- Perl `open` mode operand is now correctly parsed by position instead of gathering unrelated quoted strings; variable modes and unparsed opens fail closed.
- Python `from os import system as X` import aliases are now detected and calls to the imported alias are marked as unclassifiable during planning.
