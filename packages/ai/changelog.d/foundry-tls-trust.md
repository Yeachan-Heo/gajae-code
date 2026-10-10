### Fixed

- A project `.env` can no longer choose the Foundry CA or mTLS client certificate, including when the declaration uses `$` or backticks, and later deleting that file or changing directory does not turn the loaded value into an operator setting.
