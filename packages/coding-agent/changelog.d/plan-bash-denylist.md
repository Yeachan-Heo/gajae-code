### Fixed

- Planning-phase Bash now refuses sed `w` destinations with spaces and compound scripts, awk quoted redirections, command pipes and opaque program files, alternate awk executables, `ln`, and writes from inline interpreters. Dynamic execution and reflective loading fail closed across supported interpreter one-liners, including Ruby, PHP, Lua, and shell `-c` forms. Read-only planning commands, including GNU awk `-W lint`, stay allowed.
