### Bug fixes

- fix(env): Preserve inherited NODE_TLS_REJECT_UNAUTHORIZED when project declares the same value
  - Previously, inherited shell values matching project declarations were deleted due to overly broad equality check
  - Now only deletes values explicitly marked as coming from the project's dynamic environment
  - Ensures that shell-exported TLS verification settings are not lost when the project also declares the same value
