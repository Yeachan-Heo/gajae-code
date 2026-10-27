### Fixed

- Aborted promise waits observe rejections from already-started work instead of letting them reach the process-wide unhandled-rejection handler.
