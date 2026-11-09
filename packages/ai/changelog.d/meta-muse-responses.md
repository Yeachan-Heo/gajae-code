### Added

- The `meta-muse-responses` transport reaches the Muse Code subscription backend directly with the official CLI identity: fingerprint headers and Responses body shaping, per-conversation UUIDv7 sessions with a bounded LRU, one flat-alias retry only on `client_attestation_denied`, and streamed tool-name restoration before shared Responses decoding.
