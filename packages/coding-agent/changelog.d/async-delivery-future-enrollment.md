### Fixed

- Enroll async-job delivery and loop completion futures before callbacks and change notifications so drains and bounded disposal cannot mistake in-flight work for settled delivery.
