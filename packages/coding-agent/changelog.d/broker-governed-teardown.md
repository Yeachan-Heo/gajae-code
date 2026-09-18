### Fixed

- SDK broker signal shutdown now drains every governed disposer before preserving the signal exit status, instead of a module-imported LSP handler exiting after LSP-only cleanup and leaving `sdk/broker.lock` plus `sdk/broker.json` behind. Broker owner locks now bind their PID to the published process incarnation, so a recycled PID is reclaimed rather than treated as a live owner; stale-lock retirement uses identity-bound no-replace native detach, preventing a delayed contender from moving a successor lock. Incarnation-less live legacy records remain fail-closed.
