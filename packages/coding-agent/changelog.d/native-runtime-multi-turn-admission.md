### Fixed

- Keep a published native runtime usable across turns: a dispatch whose own appended suffix is merely unproven now performs one cause-directed durability repair before admission instead of refusing `not_ready` indefinitely. Unknown or foreign cursors still refuse `uncertain_cursor` and are never repaired, so the admission guard keeps its meaning.
- Admit in-flight reads, steering and abort while a native turn is still streaming, so a long turn can be inspected and stopped without waiting for it to settle.
