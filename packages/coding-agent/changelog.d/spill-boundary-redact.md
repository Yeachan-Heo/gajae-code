### Fixed

- Pre-admission artifact spill redacts configured secrets on the full tool result before the head/tail cut, so a secret that straddles the cut is not sent to the provider as plaintext.
