### Fixed

- Managed ACP sessions now apply the existing retry/fallback policy when a provider reports a statusless typed capacity-overload transport failure, instead of terminalizing as exhausted before retrying.
