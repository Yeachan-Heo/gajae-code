### Fixed

- Retain generation- and owner-bound delivery promises before callback execution, so cancellation, job eviction and disposal do not masquerade as physical settlement.
- Bound parked-delivery and retained-receipt drains by their real deadline, waiting for owner changes rather than spinning or treating an empty transport queue as settlement.
- Delete only the exact owned cron generation, stop future timer firings and join an already-running delivery without duplicating or rearming it.
