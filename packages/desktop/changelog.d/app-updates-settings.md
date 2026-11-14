### Added

- Updates settings show the app and bundled gjc versions, check for a new release, and install a verified whole-app update. Automatic checks display a dismissible update notification; installation requires an explicit action and a manual restart afterward.
- Builds accept `GJC_DESKTOP_UPDATE_ENDPOINT` and `GJC_DESKTOP_UPDATE_PUBLIC_KEY` at compile time. Unconfigured builds explain why updates are unavailable rather than reporting that they are up to date. Release feed publication and signing-key provisioning are still required before deployment.

### Security

- Updates accept only native-owned, short-lived checked candidates over HTTPS with required artifact and version signature verification. Updating never replaces the bundled gjc executable independently of the app.
