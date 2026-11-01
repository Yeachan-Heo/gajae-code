### Changed
- Put the model selector, the reasoning level and the send control on one row of the composer, so the action sits at the same height as the model button instead of below it.
- Remove the queue-versus-steer selector. A message typed while a turn runs is queued and steered into that run, and the request always carries `deliverAs: "steer"`; unlike the TUI the desktop does not read the `busyPromptMode` setting, so a queued desktop message is never delivered as a separate follow-up turn.
- Reduce the composer action to a single icon: the send arrow, which becomes the stop square whenever a running turn's draft cannot be sent (including an empty draft). The button carries only an icon, with an accessible label and tooltip naming send, steer or stop.
