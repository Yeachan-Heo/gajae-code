### Fixed

- Reject unsupported shared-session model, thinking, service-tier, tool-selection and history controls before guarded runtime effects. Short-lived process-local admission prevents durable thinking settings commits and same-logical-session shared publication from overlapping in either order, without rollback or cross-process exclusion claims. Other caller families and production activation remain separate work.
