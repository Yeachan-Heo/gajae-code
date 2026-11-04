### Added

- The default Anthropic transport accepts a synchronous `onProviderDispatch` hook that observes or vetoes the final request. The hook receives an independent copy taken after payload transforms and compression; if it throws, the request is rejected before network I/O and is not retried. Custom clients are not observed, and transforms inside a custom `fetch` are not covered.
