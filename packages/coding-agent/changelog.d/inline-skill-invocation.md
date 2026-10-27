### Added

- Recognized inline `/skill:<name>` tokens now load through the existing skill invocation path in prompts and ACP. Unknown inline skill names remain part of the submitted text.
- Inline skill invocations honor cancellation during ACP catalog discovery and preserve the caller's queued delivery policy when routed through the session.
