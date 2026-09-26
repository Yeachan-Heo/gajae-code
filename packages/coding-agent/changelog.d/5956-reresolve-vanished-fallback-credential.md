### Fixed

- Managed fallback no longer fails the run when the credential row it preselected for the next request is removed or becomes unavailable before the API-key lookup; it re-resolves another untried same-kind credential or falls back to normal resolution, and never dispatches the vanished row (#5956).
