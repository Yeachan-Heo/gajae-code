### Fixes

- Fixed false positive blocks in workflow mutation guard when command arguments contain quoted glob characters like `--require="[a-z]"`. The scanner was incorrectly treating these as unquoted globs because it inspected the dequoted word instead of checking the original quoting. This could cause legitimate commands with option arguments containing brackets, asterisks, or question marks to be incorrectly blocked if those characters were quoted in the shell command. (Fixes #7857)
