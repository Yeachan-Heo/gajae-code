### Fixed

- Kiro (CodeWhisperer) streams now surface explicit content-filter refusal messages with category and explanation instead of the generic "Kiro API key stream returned no tokens" error when a `messageMetadataEvent` carries `stopDetails.refusal` (#6150).
