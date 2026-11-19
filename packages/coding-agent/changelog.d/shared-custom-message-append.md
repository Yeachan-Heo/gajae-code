### Fixed

- Interactive runs no longer abort with `shared_session_mutation_unsupported` ("Agent run failed.") when an extension, hook or system reminder adds a custom message after the first message was saved. Custom messages are now saved through the shared session path, like other messages.
