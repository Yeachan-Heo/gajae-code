### Fixed

- Endpoint-manager ownership is now released only after disposal and retained async authority actually settle, so a replacement endpoint can no longer be admitted while the outgoing one is still tearing down. Disposal is idempotent, rekey applies the same guard, and SDK startup rollback no longer eagerly unregisters an endpoint that has not finished disposing (#5603).
