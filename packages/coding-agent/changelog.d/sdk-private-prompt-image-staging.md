### Added

- Stage lossless prompt images through bounded, authenticated GJC-private SDK uploads on both session hosts without increasing transport frame limits. Uploads expire and remain connection-owned; unadopted submissions retain image capacity until their producer settles, and adopted executions require exact execution-settlement proof even after cancellation or transport teardown. Quarantined or unidentifiable executions remain charged rather than freeing capacity for still-unfenced work. Standard ACP image schemas and oversized-prompt handling are unchanged.
