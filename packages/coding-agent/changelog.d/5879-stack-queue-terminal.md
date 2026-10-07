### Fixed

- Keep queued SDK prompts cancellable by their own authenticated requester without borrowing another active run's abort authority, and retire that capability after completion.
- Cancel the SDK-only ordinary abort requester's admitted preflight snapshot through durable acceptance and before execution starts, without cancelling foreign or later admissions or inventing a durable terminal.
- Suspend queued prompt deadlines until exact consumption or promotion, attribute joined progress and terminals to the immutable consuming run and cancellation domain, and retire joined attribution on session teardown.
- Wait for the queued submission's durable terminal before returning deterministic cancellation; preserve uncertainty when persistence or exact execution settlement cannot be proved.
