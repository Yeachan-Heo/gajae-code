### Fixed

- Reconcile macOS SDK child-spawn registration failures durably, retaining launch proof until cleanup state is persisted so retries can close or report an uncertain substrate instead of leaking it.
