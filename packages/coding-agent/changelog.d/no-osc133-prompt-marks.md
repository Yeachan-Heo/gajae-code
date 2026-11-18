### Fixed

- Shift+Enter keeps inserting a newline after the first message in terminals that reset keyboard modes at a shell prompt, such as Tern. Rendered user messages no longer carry OSC 133 shell-prompt marks, which told the terminal gjc had exited and made it drop the Kitty keyboard flags.
