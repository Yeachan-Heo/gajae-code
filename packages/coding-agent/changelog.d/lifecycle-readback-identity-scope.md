### Fixed

- Lifecycle read-back no longer rejects its own settled terminal row because an unrelated identity's ledger row exceeds the JSON bounds. A cleanup receipt carrying an artifact snapshot larger than the 1024-element limit no longer makes every later lifecycle result unverifiable on that agent directory; rows for the requested identity, undecodable rows, and unsupported state versions still withhold proof.
