### Fixed

- A project `.env` declaration of `NODE_TLS_REJECT_UNAUTHORIZED` no longer disables TLS certificate verification for the process; combined with a project `HTTPS_PROXY`, it previously let the proxy read provider API keys. A value exported by the launching shell is still honored.
