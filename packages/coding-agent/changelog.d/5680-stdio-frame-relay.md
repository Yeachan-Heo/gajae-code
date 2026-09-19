### Fixed

- `gjc sdk serve --stdio` now waits for the upstream hello before forwarding downstream frames and preserves the downstream client's exact v3 capability selection, so capability-gated `tool_activity` frames and live turn content are relayed instead of stopping at the final lifecycle result. A client that explicitly opts into both `turn_stream` and the observer role receives mid-turn tool and assistant frames even when another SDK connection submitted the turn, matching direct socket delivery.
