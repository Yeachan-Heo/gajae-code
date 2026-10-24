### Fixed

- The agent settings pending-retirement marker is rewritten on its own descriptor at mode 0600 and is not created through a final-component symlink. A refused marker write leaves settings.json active.
