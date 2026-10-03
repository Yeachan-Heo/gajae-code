### Fixed

- Recover rejected OAuth access tokens before expiry by retrying authentication failures once through the existing refresh lease, instead of treating HTTP 401 as missing data and only renewing expired credentials.
