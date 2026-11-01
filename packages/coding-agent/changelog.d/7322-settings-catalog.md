### Fixed

- Keep descriptive layer-resolution metadata solely under `resolution`; the query-only settings catalog no longer repeats `allowedLayers` under `mutation`, where it could be mistaken for write authorization.
