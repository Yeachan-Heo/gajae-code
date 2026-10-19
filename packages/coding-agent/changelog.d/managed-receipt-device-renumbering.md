### Fixed

- Managed session startup now quarantines a valid v3 replacement-cleanup receipt when its publisher is verified dead and its inode still matches after the encoded device number changes. Receipt bytes are preserved, and live, remote, or unknown owners still fail closed.
