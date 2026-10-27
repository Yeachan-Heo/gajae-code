### Fixed

- The bisect predicate now refuses a tmux input verb aimed at this agent pane before each shell starts, including a script that changes at a checked-out commit. The same check refuses a shell runner whose PATH override is still an unresolved expansion; a static PATH is unchanged.
