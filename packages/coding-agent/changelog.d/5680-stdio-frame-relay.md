### Fixed

- `gjc sdk serve --stdio` now negotiates the upstream v3 event capabilities it advertises, so capability-gated `tool_activity` frames and live turn content are relayed instead of stopping at the final lifecycle result. A negotiated observer receives mid-turn tool and assistant frames even when another SDK connection submitted the turn, matching direct socket delivery.
