### Fixed
- Interpret native-authorized child quarantine names against original owner-tree identities, pass only the current logical subset to native retries, and keep shrinking replay authority and physical continuation snapshots intact.
- Preserve aggregate uncertainty when native deletion reports exactly `{ok:true}` but remaining authority is not verified; strict outcome decoding no longer rejects that truthful noncompleted result.
