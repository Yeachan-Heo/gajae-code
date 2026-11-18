### Added

- Native embedded owners can restore an exact saved conversation view with `runtime.session.restoreSessionView(view)`, including the empty root, through the existing session admission and identity guards. Restoration preserves the logical resume operation and historical proofs without appending an execution cursor or issuing a provider request; raw session restoration remains fenced.
