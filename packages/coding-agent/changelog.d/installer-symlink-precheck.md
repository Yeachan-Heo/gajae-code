### Fixed

- The binary installer now refuses a symlinked destination before downloading instead of after. `scripts/install.sh` tested `[ -h "$DEST_PATH" ]` only after fetching and checksumming the full release binary, so a checkout linked by `bun run dev:link` waited out the entire download to be told no. The check runs as soon as the destination path is resolved, remains at its original position as the pre-replace TOCTOU guard, and names the development-link case alongside `GJC_INSTALL_DIR`.
