### Fixed

- Typing the first character on the `/model` preset list no longer stalls when `models.yml` declares `equivalence` overrides or exclusions. Each catalog refresh reloads that config as a new object, which was compiled anew and discarded the per-model canonical resolution reuse added in #7709, so every rebuild re-ran the full canonical heuristics. A reloaded config with the same content now reuses the compiled config and its resolutions. Measured on a 5,138-model catalog with 19 exclusions: about 240 ms per canonical index rebuild before, about 10 ms after.
