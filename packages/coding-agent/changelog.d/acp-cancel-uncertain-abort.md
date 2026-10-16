### Fixed

- ACP cancellation now preserves pre-admission intent when the host reports an uncertain abort and retries once the prompt is admitted, so a follow-up turn cannot misclassify the cancelled prompt as `end_turn`.
