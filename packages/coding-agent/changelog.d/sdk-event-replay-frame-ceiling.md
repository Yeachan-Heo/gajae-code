### Fixed

- ACP `session/load` no longer fails with `cursor_expired` on a session whose recent turns ended with long final answers. The host answered `event_replay` with every retained event in one frame, and once those events passed the 1 MiB directed-frame ceiling the native writer rejected the reply as `oversized_frame`; the session router then failed its replay barrier and rebuilt the attachment, so the ACP transcript cursor expired. The host now keeps the reply under the native ceiling by conceding the oldest events as a `sequence_gap`, the same way it reports events that fell out of retention, and the router continues past the gap. The Telegram daemon still refuses any replay with a gap, so such a session stays unavailable to it, as it already was when the oversized reply was rejected.

### Changed

- `SessionSdkTransport` and `HostEndpointAdapters` accept `directedFrameCeilingBytes`, the largest directed frame the transport delivers. Omitted means the native server's 1 MiB ceiling; `null` means none, which the SDK-only JS WebSocket transport declares so it keeps sending the whole retained replay.
