### Fixed

- Non-interactive runs (`gjc -p`, `--mode text|json`, auto-print) no longer fetch provider usage they never display: credential selection ranks from reports that long-lived hosts already cached in `agent.db` and makes no usage-endpoint requests of its own ([#5939](https://github.com/Yeachan-Heo/gajae-code/issues/5939)).
