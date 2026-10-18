### Fixed

- A patch rename checks generated destinations before writing, again under the mutation lock immediately before a move commits, after an earlier edit marks one generated, and for a Windows path whose file name is generated.
