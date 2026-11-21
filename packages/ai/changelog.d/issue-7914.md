### Fixed

- Preserved broker-unserved provider credentials in local agent.db. Added `HybridAuthCredentialStore` to wrap the broker store and keep logins for providers the broker stores but does not serve in the local `agent.db`, recorded in a new `auth_broker_local_providers` table. Made `RemoteAuthCredentialStore` re-read the snapshot after each upload and throw `AuthBrokerUnservedProviderError` when none of the uploaded rows come back. (#7914)
