### Fixed
- When the terminal wins a race to write a conversation the app has open, the message now says what actually happened: that the conversation was reloaded, that it will be reloaded once work still running in it finishes, or that it could not be reloaded and selecting it again retries. Messages queued behind the refused turn are returned to the composer instead of waiting forever.
