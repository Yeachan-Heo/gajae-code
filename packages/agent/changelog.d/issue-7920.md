### Fixes

- Emit queue change notifications AFTER steering and follow-up message removal, not before. When messages are dequeued via `popLastSteer`, `removeSteerAt`, `moveSteer`, `popLastFollowUp`, `removeFollowUpAt`, `moveFollowUp`, or `removeQueuedMessages`, queue change listeners are now notified that the queue state has changed. This ensures that observers see the final state of the queue after claim and delivery transitions are complete, preventing exposure of stale message snapshots. (#7920)
