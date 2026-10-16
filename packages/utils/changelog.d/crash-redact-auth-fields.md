### Fixed

- Generic `auth=` fields no longer cause crash redaction to consume the rest of the log line; later fields are independently scrubbed and diagnostic context remains readable while nonstandard `Authorization:` header values stay redacted only through physical or escaped newline boundaries, without swallowing fields after escaped-quote values in serialized JSON.
