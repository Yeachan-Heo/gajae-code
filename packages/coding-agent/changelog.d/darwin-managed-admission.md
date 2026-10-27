### Fixed

- Managed tmux children on macOS pass pre-CLI admission instead of always exiting 75 with `exact_child_binding_unavailable`: the CLI now reads its private child binding through the bounded native owner-only reader, and Broker-redacted launches publish an opaque (command-free) binding instead of none.
- Managed-owner admission handoffs and supervisor bindings are only published through retained private authority; unsafe or missing lifecycle storage blocks the child with a bounded `handoff_not_persisted` diagnostic instead of a pathname write.
- Supervised managed tmux launches from a workspace reached through a symlink (including a symlinked `.gjc`) no longer fail lifecycle verification with `gjc_tmux_managed_storage_unsafe` or `managed_owner_storage_unsafe`: the derived state path names the workspace canonically.
