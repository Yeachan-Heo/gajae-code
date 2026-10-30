### Fixed
- Render assistant responses and reasoning as safe Markdown with fenced-code copy actions, without executing HTML or fetching Markdown images.
- Generate new-session names through the SDK instead of persisting the placeholder as a manual title; preserve manual names and reject stale generation.
- Compact the composer with an inline attachment icon, one-line auto-growing input and IME-safe Enter/Shift+Enter behavior; remove redundant helper copy and duplicate command navigation.
- Keep page scrolling inside owned panes, modal headers fixed and close actions icon-only, with consistent compact controls.
- Keep normal accepted/queued delivery bookkeeping out of recovery warnings, including bootstrap reconciliation; distinguish unknown outcomes, failed turns and actual local storage repair without blocking sends on acknowledgment failure.
- Omit empty tool-call-only assistant rows instead of inventing repeated waiting messages. Render actual ordered text, display thinking and safe bounded image previews, with explicit unavailable-image feedback and retained tool/error/truncation states.
- Persist submitted text and ready attachments atomically before clearing the composer, and restore the exact payload on definitive refusal without overwriting a newer draft. Durable handoff is not proof of model execution.
- Retain uncertain deliveries across reloads for explicit recovery without automatic replay; keep acknowledgment failures from blocking later draft edits and sends.
- Scope known-unsent repair and disposal to the exact delivery, so one failed local write cannot re-arm an already accepted message or permanently block the session.
- Preserve definitive queued SDK refusals and causal error ownership instead of treating all removed queue items as delivered or duplicating unrelated errors.
- Register owned SDK teardown and final protocol flushing with the shared bounded signal-exit policy; drain intentional QA shutdown and redact fixture tokens from failure diagnostics. Write native host frames through the captured stdout stream to prevent pipe-pressure corruption.
- Find slash commands by the form users type: the command search now accepts `/model`, not only `model`.
- Report a completed conversation export as a message with its HTML path instead of the raw protocol object.
- Render boolean settings as checkboxes and numeric settings as decimal inputs instead of free-text fields.
- Keep a refused operation from marking the conversation as failed: only a failed prompt turn sets the session error, so `/compact`, `/retry` or a profile switch that the host declines leaves the row idle and shows one banner.

### Added
- Show every available model, browser-local favorites and ordered role tags; choose Default, Executor, Planner, Critic or Architect before applying. Default remains shared/durable; task-role choices apply only to the current live session and clearing reveals inherited configuration.
- Integrate trusted extension startup questions and handled/transformed input for direct, queued and forwarded prompts without replaying startup on UI refresh.
- Exercise real owned MCP effects and transport termination, real LSP diagnostics and subprocess exit, and the QA wrapper's final HTTP/SSE shutdown frame.
- Add `app-flow-qa`, a manual sixteen-journey suite that drives the real App, Host and SDK against the zero-provider fixture (needs a local Chrome and a free port 1420).
