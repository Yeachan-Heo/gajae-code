### Fixed

- Workflow recovery prompts clip repo goal ids and cohort source hashes to 240 characters, escape those characters, and then fence the result. A character that fits the raw cap is escaped in full, so the fenced body can be longer than 240.
