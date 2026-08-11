#!/bin/sh
set -u

fail=0

tmpdir=$(mktemp -d "${TMPDIR:-/tmp}/gjc-option-key.XXXXXX") || {
  printf '%s\n' 'FAIL: could not create a temporary directory.' >&2
  exit 1
}
trap 'rm -rf "$tmpdir"' EXIT

if ! command -v defaults >/dev/null 2>&1; then
  printf '%s\n' 'FAIL: macOS defaults command is unavailable.' >&2
  exit 1
fi
if ! command -v python3 >/dev/null 2>&1; then
  printf '%s\n' 'FAIL: python3 is required to inspect macOS preference plists.' >&2
  exit 1
fi

iterm_plist="$tmpdir/iterm.plist"
terminal_plist="$tmpdir/terminal.plist"
input_plist="$tmpdir/input.plist"
iterm_available=0
terminal_available=0
if defaults export com.googlecode.iterm2 "$iterm_plist" >/dev/null 2>&1; then
  iterm_available=1
fi
if defaults export com.apple.Terminal "$terminal_plist" >/dev/null 2>&1; then
  terminal_available=1
fi
if ! defaults export com.apple.HIToolbox "$input_plist" >/dev/null 2>&1; then
  printf '%s\n' 'FAIL: could not export macOS input-source preferences.' >&2
  exit 1
fi

if ! python3 - "$iterm_plist" "$terminal_plist" "${TERM_PROGRAM:-}" "$iterm_available" "$terminal_available" <<'PY'
import plistlib
import sys

iterm_path, terminal_path, term_program, iterm_available, terminal_available = sys.argv[1:6]


def load_plist(path, available):
    if available != "1":
        return None
    with open(path, "rb") as fh:
        return plistlib.load(fh)


def check_iterm(prefs, emit):
    if prefs is None:
        return False
    profiles = prefs.get("New Bookmarks", [])
    required = {"Default", "tmux"}
    by_name = {profile.get("Name"): profile for profile in profiles}
    missing = sorted(required - by_name.keys())
    problems = [f"required iTerm2 profiles are missing: {', '.join(missing)}"] if missing else []

    # iTerm2 key maps may encode letter keys as physical macOS keycodes (Q=12, I=34)
    # or as character codes (q=0x71, i=0x69). Option is 0x80000.
    keycodes = {12: "Option+Q", 34: "Option+I", 0x71: "Option+Q", 0x69: "Option+I"}
    option_mask = 0x80000
    if not missing:
        for name in sorted(required):
            profile = by_name[name]
            left = profile.get("Option Key Sends")
            right = profile.get("Right Option Key Sends")
            if emit:
                print(f"iTerm2 profile {name}: left={left}, right={right}")
            if left != 1 or right != 1:
                problems.append(f"{name}: Option keys are not +Esc")
            keyboard_map = profile.get("Keyboard Map", {}) or {}
            for map_key, mapping in keyboard_map.items():
                mapping = mapping if isinstance(mapping, dict) else {}
                keycode = mapping.get("Keycode")
                modifiers = mapping.get("Modifiers")
                try:
                    parts = str(map_key).split("-")
                    if keycode is None:
                        keycode = int(parts[0], 16)
                    if modifiers is None:
                        modifiers = int(parts[1], 16) if len(parts) > 1 else 0
                except (TypeError, ValueError):
                    continue
                if int(keycode) in keycodes and int(modifiers) & option_mask:
                    problems.append(f"{name}: conflicting {keycodes[int(keycode)]} mapping ({map_key})")

    if emit:
        if problems:
            print("FAIL: " + "; ".join(problems))
        else:
            print("PASS: iTerm2 Default and tmux send both Option keys as +Esc with no Option+Q/I overrides")
    return not problems


def check_terminal(prefs, emit):
    if prefs is None:
        return False
    settings = prefs.get("Window Settings", {})
    names = []
    for key in ("Default Window Settings", "Startup Window Settings"):
        name = prefs.get(key)
        if isinstance(name, str) and name and name not in names:
            names.append(name)
    problems = [] if names else ["Terminal.app has no default or startup profile"]
    if names:
        for name in names:
            profile = settings.get(name)
            value = profile.get("useOptionAsMetaKey") if isinstance(profile, dict) else None
            if emit:
                print(f"Terminal.app profile {name}: useOptionAsMetaKey={value!r}")
            if value not in (True, 1):
                problems.append(f"{name}: enable 'Use Option as Meta key' in Profiles > Keyboard")
    if emit:
        if problems:
            print("FAIL: " + "; ".join(problems))
        else:
            print("PASS: Terminal.app default and startup profiles send both left and right Option keys as Meta/Esc")
    return not problems


iterm = load_plist(iterm_path, iterm_available)
terminal = load_plist(terminal_path, terminal_available)
checks = {
    "Apple_Terminal": [("Terminal.app", terminal, check_terminal)],
    "iTerm.app": [("iTerm2", iterm, check_iterm)],
    "iTerm2": [("iTerm2", iterm, check_iterm)],
}
selected = checks.get(term_program)
if selected is None:
    selected = [
        ("Terminal.app", terminal, check_terminal),
        ("iTerm2", iterm, check_iterm),
    ]

passing = [label for label, prefs, check in selected if check(prefs, False)]
if not passing:
    for _label, prefs, check in selected:
        check(prefs, True)
    print("FAIL: no active terminal profile forwards Option as Meta/Esc.")
    print("Terminal.app fix: Settings > Profiles > Keyboard > Use Option as Meta key.")
    raise SystemExit(1)

label = passing[0]
for candidate_label, prefs, check in selected:
    if candidate_label == label:
        check(prefs, True)
        break
print(f"PASS: using {label} Option/Alt profile for the physical-key test")
PY
then
  fail=1
fi

if ! python3 - "$input_plist" <<'PY'
import plistlib
import sys

with open(sys.argv[1], "rb") as fh:
    prefs = plistlib.load(fh)
current_id = prefs.get("AppleCurrentKeyboardLayoutInputSourceID")
selected = prefs.get("AppleSelectedInputSources", [])
selected_abc = any(
    source.get("InputSourceKind") == "Keyboard Layout"
    and source.get("KeyboardLayout Name") == "ABC"
    for source in selected
    if isinstance(source, dict)
)
if current_id != "com.apple.keylayout.ABC" or not selected_abc:
    print(f"FAIL: active keyboard layout is not ABC (current={current_id!r}, selectedABC={selected_abc})")
    raise SystemExit(1)
print("PASS: ABC is the active macOS keyboard layout")
PY
then
  fail=1
fi

if command -v bun >/dev/null 2>&1; then
  printf 'Bun: '; bun --version
else
  printf '%s\n' 'FAIL: bun is not on PATH.' >&2
  fail=1
fi

if command -v gjc >/dev/null 2>&1; then
  printf 'GJC: '; gjc --version
  if ! gjc --smoke-test; then
    printf '%s\n' 'FAIL: gjc --smoke-test failed.' >&2
    fail=1
  fi
else
  printf '%s\n' 'FAIL: gjc is not on PATH.' >&2
  fail=1
fi

if [ "$fail" -eq 0 ]; then
  printf '%s\n' 'PASS: Option/Alt environment checks passed; perform the physical-key test in a fresh Terminal.app or iTerm2 session.'
else
  printf '%s\n' 'FAIL: one or more required environment checks failed.' >&2
fi
exit "$fail"
