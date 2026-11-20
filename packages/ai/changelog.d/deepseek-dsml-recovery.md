### Fixed

- DeepSeek tool calls leaked into message text as DSML markup are now recovered as tool calls, and the markup is stripped from visible output.
- Each structured tool call suppresses at most one otherwise-eligible recovered call with identical name and arguments.
- Recovered DSML calls respect the request's tool choice: none are kept for `none`, and only the named tool is kept for a named choice. This also applies when the host cannot express `tool_choice` and the field is omitted from the request.
- Recovered DSML calls are limited to tools both registered locally and present in the final submitted payload, including after payload hooks.
- A distinct recovered DSML call is published before structured calls first seen after it completed, rather than being marked incomplete just because both forms appeared in the same response.
- Incomplete recovered DSML invocations are discarded before publishing call events or final content, so response encoders cannot expose their partial arguments as executable calls.
- An unterminated DSML tag no longer hides the rest of the response: text outside a tool call is released after a bounded hold.
- Venice DeepSeek malformed wrapperless calls are rejected when tools are enabled and no executable call remains. Tool-disabled turns keep wrapperless text unchanged. The agent retries the rejected completion at most once only in unmanaged sessions before publication. Managed fallback sessions surface this error without a same-model retry; it is not a transport failure.
