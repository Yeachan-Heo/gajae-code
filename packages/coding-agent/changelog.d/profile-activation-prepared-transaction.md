### Changed

- Model-profile activation is now expressed as a prepared transaction (prepare → commit → finish) fenced on the session identity generation: an activation superseded mid-flight rolls back only its own writes instead of publishing a half-applied projection. The new transaction ships alongside the existing activation path; the session control surface switches to it in the next layer.
