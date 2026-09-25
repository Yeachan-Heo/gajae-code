### Fixed

- Anthropic-compatible endpoints that leave `compat.supportsLongCacheRetention` unset no longer downgrade the default `long` prompt-cache retention to the ~5m TTL silently: GJC now logs one warning per provider session naming the provider and model and pointing at the flag. Set it to `true` for gateways that forward `ttl: "1h"`, or to `false` to accept the ~5m lifetime and silence the warning. (#5944)
