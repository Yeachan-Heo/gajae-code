### Fixed

- Kiro streams now surface explicit content-filter refusal messages with category and explanation instead of the generic "no tokens" error when a refusal is detected. Both bearer token (via `messageMetadataEvent`) and API-key (`ksk_`, via `metadataEvent`) paths are supported, with proper provider safety-stop minting. API-key text uses one complete-event-batch lookahead so a refusal in the next batch can suppress it without waiting for EOF; a preceding thinking block still defers text until stream end to preserve block order. Tool calls are emitted only at stream end (#6150).
