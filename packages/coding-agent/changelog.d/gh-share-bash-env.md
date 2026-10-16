### Fixed

- The default `/share` GitHub CLI child environment now omits project-declared shell, Node, Python, Ruby, Perl, Java, PHP, and .NET startup hooks and module paths (`BASH_ENV`, `ENV`, `ZDOTDIR`, `NODE_OPTIONS`, `NODE_PATH`, `PYTHONHOME`, `PYTHONPATH`, `PYTHONUSERBASE`, `PYTHONSTARTUP`, `RUBYOPT`, `RUBYLIB`, `PERL5OPT`, `PERL5LIB`, `PERLLIB`, `JAVA_TOOL_OPTIONS`, `JDK_JAVA_OPTIONS`, `_JAVA_OPTIONS`, `CLASSPATH`, `PHPRC`, `PHP_INI_SCAN_DIR`, and `DOTNET_STARTUP_HOOKS`), preventing checkout-controlled code from running with operator GitHub credentials.
- Trusted GitHub CLI children run from the filesystem root rather than the checkout, preventing Bun wrappers from loading project `bunfig.toml` preloads.
