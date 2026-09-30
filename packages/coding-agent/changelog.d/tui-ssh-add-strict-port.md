### Fixed

- Interactive `/ssh add ... --port` rejects a port with trailing or non-digit characters (for example `22oops` or `2222.5`) instead of saving the digits before them, matching the ACP `/ssh add` parser.
