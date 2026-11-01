### Fixed

- Fuzzy search in the model selector, command palette, session selector, OAuth provider selector, and `gjc --list-models <search>` now scores the best alignment of the query instead of the first occurrence of each character, so an exact word later in the text (for example "model" in `src/modes/model-picker.ts`, or a model id behind a provider prefix) is no longer ranked below a scattered match.
