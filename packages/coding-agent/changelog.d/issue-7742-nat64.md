### Fixed

- Fix `read`/web-fetch blocking IPv4-only sites on IPv6-only DNS64/NAT64 networks. The guard now handles NAT64 well-known prefix (`64:ff9b::/96`) by extracting the embedded IPv4 and evaluating its privacy status. NAT64 synthesized addresses with public IPv4 are now allowed; those with private/loopback/link-local IPv4 remain blocked. The local-use prefix (`64:ff9b:1::/48`) remains blocked by the public-URL guard; RFC 8215 designates this as a local-use prefix not globally reachable.
