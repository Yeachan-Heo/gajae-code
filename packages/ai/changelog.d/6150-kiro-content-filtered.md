### Fixed

- Kiro streams now surface explicit content-filter refusal messages with category and explanation instead of the generic "no tokens" error when a refusal is detected. Both bearer token (via `messageMetadataEvent`) and API-key (`ksk_`, via `metadataEvent`) paths are supported, with proper provider safety-stop minting (#6150).
