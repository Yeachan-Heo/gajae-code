### Fixed

- A project file or runtime override that sets the parent of a protected setting to `null`, a scalar or an array (for example `plan: null` or `hindsight: null`) no longer resets the user's value for that setting. This covers global-only settings such as `plan.enabled` and `hindsight.apiUrl`, and, for project files, project-denied settings such as `task.agentModelOverrides`. `get`, `gjc config list` and the resolution snapshot now report the user value. Other keys under that parent are still replaced as before.
