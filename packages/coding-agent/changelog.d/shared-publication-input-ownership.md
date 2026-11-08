### Fixed
- Shared message publication now snapshots caller-owned payloads before asynchronous admission, preserving invocation-time content and message identity without rolling back later caller metadata changes. Attempted entry IDs remain available on uncertain outcomes. This does not activate production shared publication or change execution-receipt lifecycle policy.
