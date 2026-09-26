### Fixed

- SDK prompt deadline expiry fences the exact accepted run and dispatched tools before publishing `prompt_deadline_exceeded`; when settlement is unproven, the prompt remains recoverable in flight with its pending outcome hidden (#5869).
