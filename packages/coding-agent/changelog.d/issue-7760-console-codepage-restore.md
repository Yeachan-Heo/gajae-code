### Fixed

- Windows: the TUI no longer stays garbled (mojibake, one editor line per keystroke) after a bash-tool command runs a program that switches the console code page, such as `monolix --no-gui` or `chcp 1252`. GJC records the console's code pages before the first bash command and restores them after each command ends. ([#7760](https://github.com/Yeachan-Heo/gajae-code/issues/7760))
