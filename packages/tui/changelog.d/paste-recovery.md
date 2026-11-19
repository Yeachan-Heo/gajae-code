### Fixed

- A bracketed paste whose end marker never arrives now delivers what arrived after a 1 s inactivity watchdog, or at a 64 MiB cap, instead of leaving input dead.
- Unbracketed multi-line pastes (for example `tmux paste-buffer` without `-p`) arrive as one paste instead of submitting line by line.
