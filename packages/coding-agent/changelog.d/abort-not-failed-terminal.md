### Fixed

- User-cancelled turns (ACP session/cancel, SDK turn.abort) settle as `cancelled` again instead of a failed terminal (regression from 0.18.0).
