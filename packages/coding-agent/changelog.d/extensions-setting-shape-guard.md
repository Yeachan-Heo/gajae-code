### Fixed

- A schema-invalid `extensions` setting (for example an object left in `config.yml` by a hand edit) no longer aborts extension discovery at session startup with `Failed to discover extension modules`: discovery now degrades to no extra extension paths while the canonical `<agentDir>/extensions` modules keep loading.
