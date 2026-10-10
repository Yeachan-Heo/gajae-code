### Fixed

- Kiro streams now surface explicit content-filter refusal messages with category and explanation instead of the generic "no tokens" error when a refusal is detected. Both bearer token (via `messageMetadataEvent`) and API-key (`ksk_`, via `metadataEvent`) paths are supported, with proper provider safety-stop minting. Text is streamed incrementally unless a thinking block precedes it, in which case the entire answer (after thinking) is buffered until the stream end; tool calls are emitted only at stream end (#6150).
- Detail-free `stopReason: "CONTENT_FILTERED"` (without `stopDetails.refusal` object) is now treated as a refusal and suppresses unconfirmed content.
- Text events are now emitted immediately when a completion event is received, instead of being deferred to EOF. This prevents text events from being lost if subsequent reads fail.
- Parser no longer resyncs into nested objects when an incomplete outer JSON frame is encountered. Incomplete frames are retained as remainder; EOF with incomplete frame throws an error.
- Server error events now emit `text_end` for confirmed text before throwing the error, ensuring complete text lifecycle.
