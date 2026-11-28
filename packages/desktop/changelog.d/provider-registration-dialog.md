### Added

- A Providers dialog for connecting model providers. It lists every provider the app can set up, with what is connected and how many models each one brings, and opens a provider to sign in or save an API key. Sign-in walks through each step in the dialog: opening the provider's page, a device code, a code to paste back, a provider warning to confirm, and the result. Closing the dialog does not cancel a sign-in, and reopening it picks the sign-in back up. Open it from Settings → Account (`Manage providers`) or the model picker's `Add or connect providers`.
- When no model is available yet, a notice at the bottom of the window (above the composer, or below the start screen) explains that a provider is needed and opens the Providers dialog. It goes away by itself as soon as a model is available.

### Changed

- Settings → Account now shows how many models are available and a `Manage providers` button. The provider sign-in and API-key form moved into the Providers dialog, which lists providers by name instead of asking you to type a provider ID.
- When a conversation has no usable model, the composer now says either "Choose a model to start." or "No models are available for this conversation." with a `Manage providers` button, instead of one generic message.
- Disconnecting a provider and adding custom OpenAI-compatible endpoints are listed as unavailable in Settings → Capabilities; the app cannot do either yet.
