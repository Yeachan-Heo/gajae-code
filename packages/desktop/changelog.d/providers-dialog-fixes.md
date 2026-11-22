### Fixed
- In the Providers dialog, a long provider name no longer runs under its status and sign-in method tags; the name wraps, and the status and tags move below it when space is short.
- Error text in the Providers dialog (a failed sign-in, a refused API key) and text on its amber notices are readable in every theme, including Gruvbox Dark and Codex. A refused API key also marks the key field itself in red.
- Opening the Providers dialog while a sign-in waits for an answer puts the cursor in the answer field instead of on the Close button.
- A sign-in device code stays on one line and is shown whole in narrow windows at the largest text size.
- The dialog no longer repeats "No models from this provider yet." or "Sign-in cancelled", and the line shown while another provider is signing in reads correctly for every provider name.
- A provider list that could not load shows its error across the whole dialog, and in a short window or at large text sizes only the provider list scrolls, so search and the note below the list stay in view.
