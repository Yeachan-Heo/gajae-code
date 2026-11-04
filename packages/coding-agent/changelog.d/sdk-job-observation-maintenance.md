### Fixed

- Reading factory-owned job observation during temporary maintenance no longer permanently disables observation for an unchanged owner. Settled reads can return a fresh facade after ownership revalidation, while retired handles, explicit host disposal, and actual ownership mismatches remain fenced.
