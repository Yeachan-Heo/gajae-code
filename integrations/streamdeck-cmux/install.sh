#!/bin/zsh
set -eu

root="${0:A:h}"
streamdeck_root="${HOME}/Library/Application Support/com.elgato.StreamDeck"
plugin_target="${streamdeck_root}/Plugins/dev.gajae.streamdeck.sdPlugin"
profile_source="${root}/profile"
profile_target="${streamdeck_root}/ProfilesV3"
profile_name="GJC-cmux-Control-$(date +%Y%m%d-%H%M%S).streamDeckProfile"

command -v gjc >/dev/null || { print -u2 'gjc is not on PATH'; exit 1; }
[[ -x /Applications/cmux.app/Contents/Resources/bin/cmux ]] || { print -u2 'cmux is not installed in /Applications'; exit 1; }
[[ -d "$streamdeck_root" ]] || { print -u2 'Elgato Stream Deck data directory was not found'; exit 1; }

mkdir -p "${streamdeck_root}/ManualBackups"
if [[ -d "$plugin_target" ]]; then
  /usr/bin/ditto -c -k --sequesterRsrc --keepParent "$plugin_target" "${streamdeck_root}/ManualBackups/dev.gajae.streamdeck-before-install-$(date +%Y%m%d-%H%M%S).zip"
fi
rm -rf "$plugin_target"
/usr/bin/ditto "$root/plugin" "$plugin_target"
chmod +x "$plugin_target/bin/plugin" "$plugin_target/bin/worktree-session"

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
mkdir -p "$work/Profiles"
cp -R "$profile_source/page-2" "$work/Profiles/C8F6A2A1-6DB4-49F4-9E3C-4E6A7ED88931"
cp -R "$profile_source/page-3" "$work/Profiles/E1C9D4C3-8FD6-4B16-B05E-607C9FAAB153"
cat > "$work/manifest.json" <<'JSON'
{"Name":"GJC cmux Control","Pages":{"Current":"c8f6a2a1-6db4-49f4-9e3c-4e6a7ed88931","Default":"c8f6a2a1-6db4-49f4-9e3c-4e6a7ed88931","Pages":["c8f6a2a1-6db4-49f4-9e3c-4e6a7ed88931","e1c9d4c3-8fd6-4b16-b05e-607c9faab153"]},"Version":"3.0"}
JSON
/usr/bin/ditto -c -k --sequesterRsrc "$work" "$HOME/Desktop/$profile_name"

pkill -TERM -f '^/Applications/Elgato Stream Deck.app/Contents/MacOS/Stream Deck$' 2>/dev/null || true
sleep 2
open -a '/Applications/Elgato Stream Deck.app'
print "Installed plugin: $plugin_target"
print "Profile bundle: $HOME/Desktop/$profile_name"
print 'Double-click the profile bundle to import it into Stream Deck.'
