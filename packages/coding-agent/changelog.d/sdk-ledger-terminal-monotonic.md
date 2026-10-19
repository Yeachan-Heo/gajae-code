### Fixed

- Preserve proven lifecycle terminal results when a late transition attempts to overwrite them, avoiding contradictory ledger history on restart. Broker retries of proven errors return the recorded response even when it contains cleanup metadata. Existing uncertain or quarantined history is not repaired automatically.
