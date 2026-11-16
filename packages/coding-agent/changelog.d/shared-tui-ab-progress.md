### Fixed
- Admit trusted root interactive CLI sessions to shared append, preserving independent branches and tool progress after a peer exits; SDK callers and canonical children remain excluded.
- Publish discovered-tool selection before live activation and use append-only compaction instead of rewriting shared tool outputs. Persistent model/DEFAULT selection controls remain unsupported after shared admission.
