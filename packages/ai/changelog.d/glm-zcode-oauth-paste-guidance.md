### Changed

- The `glm-zcode` OAuth login guidance now names the exact `zcode://oauth/callback?code=…&state=…` redirect shape and tells users to copy it from the browser DevTools Network tab, because a custom-protocol redirect never appears in the address bar; the manual-code prompt is now `glm-zcode`-specific instead of the generic authorization-code wording, which previously led users to paste the address-bar URL and stall the login.
