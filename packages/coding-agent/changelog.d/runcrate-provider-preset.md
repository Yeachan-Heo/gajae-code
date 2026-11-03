### Added

- `gjc setup provider --preset runcrate` (alias: `runcrate-ai`): OpenAI-compatible custom provider for Runcrate (`RUNCRATE_API_KEY`, live `/v1/models` discovery limited to text-output models, `vendor/model` model ids, `reasoning_content` reasoning field).
- `discovery.outputModalities` for `openai-models-list` providers: admit only catalog rows whose advertised `output_modalities` fall inside the list, so image, audio, video and embedding rows are not registered as chat-completion models.
