### Fixed

- Under `session.ownership.mode: enforce`, `gjc --resume`, the session picker and `/resume` now offer Continue here when a remote client's resume reached the broker first and the launched session host has claimed the session but not yet published its endpoint. This happens, for example, when Gajae Mobile opens `gjc --resume <id>` in a new tmux window and sends `session/load` at the same time. Before, the warning offered only Fork and Cancel.
  - **The wait:** the warning waits up to 8 seconds for that host to publish, and says "Waiting for the session host…" meanwhile: a line before the warning at launch, in the picker under the list, and in the status line for `/resume`. It shows as soon as the host publishes an endpoint.
  - **Cancelling:** Escape or Ctrl+C in the picker, and quitting during `/resume`, stop the wait.
  - **When the host lets go first:** a session nobody holds any more opens as an unheld one would. A session another process took meanwhile gets the warning for that process.
  - **Unchanged:** a session held by a terminal, the app or an embedding shows the warning at once.
