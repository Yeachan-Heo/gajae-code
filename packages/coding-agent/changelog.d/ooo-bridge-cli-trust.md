### Fixed

- The `ooo` bridge no longer adopts a project `.env` `OUROBOROS_CLI` as the executable. Only a trusted operator setting replaces the default `ouroboros` command, and a rejected project value is removed before the bridge spawns a child.
