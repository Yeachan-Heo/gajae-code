### Fixed

- Session recovery no longer silently switches providers when a saved model cannot be restored. Instead of falling back to any credentialed provider in automatic order (which could surprise-bill users on subscription providers), the fallback now limits candidates to that model's provider, with the curated default tried first. If the provider is unknown or has no callable models, the model stays unset and the user is prompted to run `/model` to select one.

### Changed

- Interactive mode now opens the model selector automatically on startup when no model is selected and a fallback message is present, allowing users to immediately choose a model without needing to run `/model`. Non-interactive, print, and RPC modes remain unchanged.
