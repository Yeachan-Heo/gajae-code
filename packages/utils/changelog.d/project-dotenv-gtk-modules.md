### Fixed

- A project `.env` can no longer set `GTK_MODULES`, `GTK3_MODULES`, or `GTK_PATH` for processes GJC starts with the filtered spawn environment. GTK loads the modules these name into every GTK program it initializes, so a repository could otherwise load its own module into a Linux Chrome/Chromium started by the browser tool, or into a GTK program run from the bash tool. Values exported by the launching shell are still honored.
