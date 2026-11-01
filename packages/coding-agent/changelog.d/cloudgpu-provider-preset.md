### Added

- `gjc setup provider --preset cloudgpu` (alias: `cloudgpu-app`): OpenAI-compatible custom provider for CloudGPU (`CLOUDGPU_API_KEY`, live `/v1/models` discovery limited to rows whose input and output modalities are text, `system` role instead of `developer`, `reasoning_content` reasoning field).
- `discovery.inputModalities` for `openai-models-list` providers: admit only catalog rows whose advertised `input_modalities` fall inside the list. Text-output filtering alone still admits transcription rows, which advertise audio input and text output.
