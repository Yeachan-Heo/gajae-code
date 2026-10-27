### Fixed

- Fixed ACP and SDK clients receiving no message or tool content for a turn they submitted to a session hosted by an interactive terminal; the turn ran and settled, but the client only saw its start and the prompt watchdog later expired. Folded background bash jobs are now published to those clients as well.
