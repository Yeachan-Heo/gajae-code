### Fixed

- Verify retained Linux recovery namespaces and files through read-only, no-follow descriptors and the supported descriptor-bound ACL verifier. Preserve identity, payload and permission checks; unsupported or malformed security evidence remains a failure without repair or mutation.
