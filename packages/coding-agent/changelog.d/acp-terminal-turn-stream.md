### Fixed

- Fixed ACP clients attached to a session hosted by an interactive terminal receiving nothing from a turn typed in that terminal: no tool calls, no `ask`, no assistant text, only the running/idle status. Turn content now reaches any SDK connection that negotiates `turn_stream`; `session_host_observer_v1` keeps only its meaning of not keeping a detached host alive, so an ACP client still keeps a broker-launched host from being reaped.
