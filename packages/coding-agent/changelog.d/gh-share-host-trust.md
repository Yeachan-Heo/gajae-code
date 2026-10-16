### Fixed

- The default `/share` gist upload no longer forwards project `.env` routing, config, proxy, CA, executable-search, or native-loader values to `gh`; it resolves the CLI and child search path only through absolute operator PATH directories and executables whose resolved paths stay outside actual Git checkout roots discovered from the launch and active working directories, while keeping undeclared operator values. PATH entries beneath a non-checkout launch directory remain usable, and launching from the filesystem root does not mark every PATH entry as checkout-owned.
