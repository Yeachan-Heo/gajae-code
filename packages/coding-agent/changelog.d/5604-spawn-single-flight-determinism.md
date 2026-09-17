### Fixed

- The detached SDK broker's discovery budget is now published as a composition (`BROKER_DISCOVERY_BUDGET`) instead of three module-private constants and a restated sum, and every deadline and poll on that path runs on an injectable clock. The spawn single-flight regression now spends that budget one leg at a time on a virtual clock, so each leg's cost is measured exactly and a change to any single constant fails an assertion in milliseconds instead of silently re-tuning a wall-clock race (#5604).
