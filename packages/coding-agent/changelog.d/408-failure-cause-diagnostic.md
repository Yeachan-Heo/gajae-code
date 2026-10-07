### SDK

- Add `failureCauseDiagnostic` field to `SdkPromptTerminalOutcome` to expose the real failure cause in operator logs (error class name, first line of message, and exit code/signal if available). This field is bounded to 200 characters, secrets-redacted, and carries the real diagnostic from the SDK child error through to the gateway's terminal_failure log, making opaque post_start failures traceable (refs #408).
