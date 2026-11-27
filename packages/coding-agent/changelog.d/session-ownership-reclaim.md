### Fixed

- One session ownership lock timeout (for example on a stalled network filesystem) no longer turns claims off for the rest of the process. It skips that one claim, and the next claim tries again. Before, a terminal or session host whose claim timed out once kept writing its session unclaimed for its whole life, so other processes could not see it as the session's writer.
