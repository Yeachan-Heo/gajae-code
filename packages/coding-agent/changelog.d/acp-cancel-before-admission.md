### Fixed

- ACP cancels received before SDK prompt admission now stay attached to the waiter: the prompt is not dispatched, or a real terminal abort is retried after admission, rather than letting the turn continue.
