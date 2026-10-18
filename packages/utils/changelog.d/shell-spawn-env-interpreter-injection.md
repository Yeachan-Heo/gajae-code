### Fixed

- The bash tool's shell processes now also drop project-provided `NODE_OPTIONS`, `PYTHONPATH`, `PYTHONUSERBASE`, `PYTHONSTARTUP`, `PERL5OPT`, `PERL5LIB`, `JAVA_TOOL_OPTIONS`, `JDK_JAVA_OPTIONS`, `LD_PRELOAD`, `LD_AUDIT`, `LD_LIBRARY_PATH`, `DYLD_INSERT_LIBRARIES`, and the `DYLD_*_LIBRARY_PATH`/`DYLD_*_FRAMEWORK_PATH` search overrides when the value comes from the project `.env`, so a repository cannot make `node`, `python3`, `perl`, `java`, or any dynamically linked command run repository code; values the launching shell exported are still honored.
