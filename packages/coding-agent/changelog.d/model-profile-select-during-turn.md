### Fixed

- `/model` profile selection while the agent is busy now closes the selector immediately and shows that the change is queued, instead of leaving the menu open until Esc while the activation waits for the agent to go idle. The notice also covers post-prompt work such as a pending background delivery, not only a streaming turn.
