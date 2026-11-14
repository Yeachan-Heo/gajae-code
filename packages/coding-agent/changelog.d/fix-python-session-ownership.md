### Fixed

- Restored error signaling for Python execution disposal (#7782): Session disposal now properly rejects pending Python executions with "Python execution is unavailable while session disposal is in progress" instead of silently returning a cancelled result. Also fixed ownership checking to allow executions to proceed with their captured context even if the session manager's state changes during extension hooks, while still preventing late results from a successor session.
