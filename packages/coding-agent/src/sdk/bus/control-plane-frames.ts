/**
 * Typed control-plane discriminants that must never reach chat presentation.
 *
 * A chat daemon observes one session socket for user-visible events, but that
 * socket also carries the SDK's own request/response traffic: `SdkClient`
 * settles a pending request from an inbound frame and still forwards the very
 * same frame to every `onFrame` observer. A runtime that projects unknown frame
 * types into a generic notification therefore renders protocol answers — most
 * visibly `GJC event replay result` — as chat content, and a chat transport
 * with no mapping for that session publishes it as a brand-new root.
 *
 * Membership is exact, typed, and closed. It is never inferred from a `_result`
 * or `_response` suffix: ordinary public frames are free to be named anything,
 * and a fuzzy rule would silently swallow real user content. Every entry below
 * names the source authority that emits it and the code path that proves it can
 * be delivered to a chat daemon's frame observer.
 *
 * In scope (proven reachable at the chat-daemon session-client seam):
 * - `event_replay_result` — `SessionSdkHost` (`sdk/host/host.ts`) answers the
 *   `event_replay` request that `ChatDaemonRuntime.attach()` issues on every
 *   attachment, so every attached session receives exactly this frame.
 * - `control_response` — the same host's answer to the `control_request` that
 *   `ChatDaemonRuntime` sends for an authorized `/sdk control …` command, and
 *   the endpoint-stale refusal the session runtime writes for a fenced
 *   connection.
 * - `query_response` — the host's answer to the matching `query_request`, and
 *   the same endpoint-stale refusal path.
 * - `hello` — `ServerMessage::Hello` from the native session server
 *   (`crates/gjc-sdk/src/protocol.rs`), sent to every connection at accept time
 *   and re-observed by frame handlers whenever the client reconnects and
 *   adopts a new connection id.
 *
 * Deliberately out of scope — typed server→client frames that exist but are
 * unicast only to a connection that issued a request a chat daemon never
 * sends, so no source path delivers them here: `session_activate_result`,
 * `register_provider_result`, `lease_state`, `reverse_response`,
 * `reverse_request`, `reverse_cancel`, `global_response`, `pong`, and
 * `transport_error`. Add one only together with the source path that proves it
 * reaches this seam.
 */
export const CONTROL_PLANE_FRAME_TYPES: ReadonlySet<string> = new Set([
	"event_replay_result",
	"control_response",
	"query_response",
	"hello",
]);

/** Whether an exact frame/event discriminant is protocol-only control plane. */
export function isControlPlaneFrameType(name: string | undefined): boolean {
	return name !== undefined && CONTROL_PLANE_FRAME_TYPES.has(name);
}
