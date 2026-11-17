### Fixed

- DeepSeek tool calls leaked into message text as DSML markup are now recovered as tool calls, and the markup is stripped from visible output.
- A recovered DSML call is dropped only when a structured tool call in the same response has the same name and arguments. Each structured call cancels at most one recovered call.
- Recovered DSML calls respect the request's tool choice: none are kept for `none`, and only the named tool is kept for a named choice. This also applies when the host cannot express `tool_choice` and the field is omitted from the request.
- Recovered DSML calls are kept only for tools the request offered; a request with no tools keeps none.
- A recovered DSML call that the model issued before a distinct structured call is marked incomplete instead of being emitted after it, so tool execution order never inverts (for example a read running before the write that preceded it).
- Malformed DSML invocations are marked incomplete and are not executed. This covers an invocation closed with a parameter still open, a nested parameter, a JSON-typed value that does not parse, unknown DSML markup inside an argument, payload text outside any parameter, a parameter close with no parameter open, and a DSML tag that never terminates.
- An unterminated DSML tag no longer hides the rest of the response: text outside a tool call is released after a bounded hold.
