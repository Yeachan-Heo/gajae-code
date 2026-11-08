### Fixes

- Fix CI regression in event handler subscription: ensure canonical event processor returns the full handler promise instead of just the canonical admission completion, allowing the agent loop to properly wait for all event processing to complete.
