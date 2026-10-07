### Reverted

- The verified SDK recovery and session cleanup contracts from #6388 have been reverted in this PR to address terminal publication edge flakes. The following aspects of #6388 were reverted:
  - SDK terminal publication and submission completion ownership changes
  - Verified session cleanup and owner-free deletion handling
  - Durable terminal recovery coordination
  - Historical sibling session authentication

Cleanup and task-owner features that newer dev commits depend on were preserved.
