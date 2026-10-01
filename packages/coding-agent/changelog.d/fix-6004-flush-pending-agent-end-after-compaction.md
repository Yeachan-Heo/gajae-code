### Tests

- Add regression test for issue #6004: Verify that after overflow auto-compaction without a continuation scheduled, the session remains usable for subsequent prompts. The test exercises the overflow path to ensure pending agent_end events do not block future prompt submissions (related to #6004).
