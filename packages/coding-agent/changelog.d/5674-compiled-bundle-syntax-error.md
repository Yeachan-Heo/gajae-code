### Fixed

- Compiled binaries no longer abort at startup with `SyntaxError: Unexpected identifier 'init_model_registry'`. Resolving MuPDF's embedded WASM no longer makes its module asynchronous, so the bundler keeps emitting a valid module initializer for the `model-registry`/`model-resolver` import cycle.
