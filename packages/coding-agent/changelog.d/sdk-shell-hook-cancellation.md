### Fixed

- User Bash executions now own cancellation before asynchronous `user_bash` hooks. Aborted or retired sessions cannot start fallback shell work or publish a later successful hook replacement; hook failures still propagate and running ownership remains until actual settlement.
