### Added

- `CommandEntry` accepts an optional `dispatch(argv, context)` hook, so a registered command family can own its own inert parsing, help, lazy loading and failure rendering before the generic help and command-load path runs. `gjc sdk` and `gjc daemon` use it to intercept their family argv and keep private worker grammar out of public discovery.
