### Fixed

- Streaming a turn that several SDK clients observe blocks the terminal less on the SDK session host, the host of a session that runs without the notifications bus. Each `message_update` frame carries the message so far and was serialized again for every observing connection on every provider delta; it is now serialized once per frame, as replayable events already were. The notifications bus host still serializes a stream frame once per observing connection.

### Changed

- `SessionSdkTransport` accepts an optional `sendSerializedFrame(connectionId, serialized)`. A transport that implements it receives a stream frame fanned out to several observing connections already serialized; one that does not keeps receiving the frame object per connection through `sendFrame`.
