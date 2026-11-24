### Fixed

- An SDK session host no longer shuts itself down 10 minutes after the broker that launched it dies while a replacement broker is running. Brokers route through the agent directory's shared session index, so the replacement reaches the host, and any live broker publication now resets the host's broker-absence window. The host also no longer exits on broker absence while a turn is in flight; once the turn ends, the remaining absence window still applies ([#7998](https://github.com/Yeachan-Heo/gajae-code/issues/7998)).
