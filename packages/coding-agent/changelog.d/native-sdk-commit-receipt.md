### Added

- Prepared session commits return an issuer-bound commit receipt describing the
  exact successor: prepared identity, captured execution target, successor
  identity generation, exclusive owner membership, registered resume operation
  and the storage producer's publication identity.
- A prepared native successor is admitted exclusively before its first
  publication, so a replaced session keeps native ownership instead of
  degrading to a cooperative one.

### Fixed

- A managed publication without replace no longer reports the pre-rename
  `ctime`, and durability repair advances the managed expected identity with the
  timestamps it actually wrote. A receipt therefore validates against the bytes
  the producer published rather than a later observation.
