### Fixed

- Model profile activation now diagnoses a required provider this build does not know (neither a built-in provider id nor declared in `models.yml`) as a build/config mismatch with the exact provider names, instead of telling the user to run `/login` for a provider the running binary cannot serve — for example a profile authored on a newer or custom build.
