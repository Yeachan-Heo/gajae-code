### Fixed

- `gjc plugin link` now updates the plugins package.json to register the linked plugin, making it discoverable by the plugin loader. Previously, the link command would succeed but the loader would never see the linked plugin because the dependency was not added to package.json.
