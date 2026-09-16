### Performance

- Reuse unchanged transcript layout for all model-selector-originated render requests when the selector is mounted in the composer, including catalog/auth refreshes, view changes, smart-routing updates, and redraws when the selector remains open after an assignment. Keyboard input through TUI input handling, opening/closing, and controller actions retain their existing full-render behavior.
