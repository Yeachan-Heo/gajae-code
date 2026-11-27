### Fixed

- A background job result that arrives while the agent is working is now added to the running turn at its next tool step, instead of waiting until the turn is about to end. Previously the result was held until the final answer and then forced an extra iteration, which showed up as a separate trailing reply after the turn looked finished (#7993). Owned completions of a terminal-aborted turn and folded job receipts keep the previous end-of-turn and idle delivery, and an aborted, folding, or transitioning turn never receives a result at a tool step.
