# macOS + iTerm2 Option/Alt key setup for GJC

How to make the macOS Option key reach GJC as Alt/Meta input instead of producing composed characters like `œ` or `ˆ`.

## iTerm2 settings

In **Settings → Profiles → Keys → General** for the profile you use:

- Left Option Key: `+Esc`
- Right Option Key: `+Esc`

A verified live configuration sets `Option Key Sends = 1` and `Right Option Key Sends = 1` for both the `Default` and `tmux` profiles. `+Esc` delivers `Option+Q` as `ESC q` and `Option+I` as `ESC i`.

In **Settings → Profiles → Keys → Key Mappings**, remove any `Send Text`, `Send Escape Sequence`, or other mappings that intercept `Option+Q` or `Option+I`, then open a new session for each profile after changing settings.

## macOS input source

Switch the active keyboard layout to `ABC` when typing GJC Alt commands. `scripts/verify-option-key.sh` does not merely check that ABC is in the list; it verifies `AppleCurrentKeyboardLayoutInputSourceID = com.apple.keylayout.ABC` together with ABC in the selection list.

## Verification

```sh
./scripts/verify-option-key.sh
python3 scripts/capture-option-key.py
```

The verify script checks the `Default` and `tmux` profiles, both Option keys, Option+Q/I mapping conflicts in both physical-keycode (`Q=12`, `I=34`) and character-code (`q=0x71`, `i=0x69`) form, the active ABC layout, Bun, and the GJC smoke test.

Use the capture tool in a real TTY. In raw mode, Ctrl-C arrives as `0x03` rather than `KeyboardInterrupt`; the tool detects it, restores the terminal, and exits. Confirm with physical key presses in fresh Default and tmux sessions that `Option+Q` and `Option+I` arrive as `ESC q` and `ESC i` and trigger the GJC commands.

Related live and fixture verification evidence is recorded in `artifacts/option-key-verification.json`.
