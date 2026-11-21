### Fixed

- Create macOS disk images from the finalized signed app instead of an earlier unsigned bundle, preserving sealed resources and relative framework symlinks. Verify the staged signature before publishing the image and retain the previous image when packaging fails.
- Include Host shutdown diagnostics in standalone runtime verification and reject exposed cleanup failures even when the process exits successfully.
- Preserve hash-bound ad-hoc signatures instead of trusting a freely chosen identifier, while retaining configured release signing.
- Attempt every owned build-fixture restoration and preserve both build and cleanup failures.
- Apply the HTTPS updater deadline to artifact downloads as well as update checks.
