### Fixed

- The SDK session host keeps publishing turn, tool and stream events after a committed session move (`/move`, `move_session`, `session.cwd.move`). Before, a moved session published only `agent_start`/`agent_end` for prompted turns until it was restarted.
