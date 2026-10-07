Parallel task batches now pass a shared cancellation signal to active workers and wait for sibling cleanup to settle before surfacing a worker failure or returning from external cancellation.
