//! Loopback control server for session lifecycle (create/close/resume).
//!
//! This is the session-independent, daemon-owned ingress required because a
//! `session_create` has no per-session endpoint to target before the session
//! exists. It is deliberately **minimal**: it authenticates (handshake + per
//! frame), forwards valid [`LifecycleClientMessage`] frames to the host, and
//! routes host [`LifecycleServerMessage`] responses back by `requestId`. It
//! owns no Telegram policy, spawning, idempotency, rate limiting, or audit —
//! those live in the TypeScript daemon that drains the forwarded frames.
//!
//! Lifecycle mirrors [`crate::server`]:
//! - [`start_control`] binds the loopback socket and returns once bound.
//! - [`ControlServerHandle::stop`] is idempotent.

use std::{
	collections::HashSet,
	net::{IpAddr, Ipv4Addr, SocketAddr},
	path::PathBuf,
	sync::Arc,
};

use futures_util::{SinkExt, StreamExt};
use parking_lot::Mutex;
use tokio::{
	net::{TcpListener, TcpStream},
	sync::broadcast,
};
use tokio_tungstenite::tungstenite::{
	Message,
	handshake::server::{ErrorResponse, Request, Response},
	http::StatusCode,
};
use tokio_util::sync::CancellationToken;

use crate::{
	discovery::ControlEndpointRecord,
	lifecycle::{
		LifecycleClientMessage, LifecycleErrorReason, LifecycleServerMessage, LifecycleStatus,
		SessionLifecycleError,
	},
	server::{token_from_query, tokens_match},
};

/// Configuration for the daemon-owned lifecycle control server.
#[derive(Debug, Clone)]
pub struct ControlServerConfig {
	/// The control token clients must present (`?token=` + per-frame `token`).
	pub token:     String,
	/// Bind host. Defaults to loopback via [`ControlServerConfig::new`].
	pub host:      IpAddr,
	/// Bind port. `0` selects an ephemeral port; the bound port is read back.
	pub port:      u16,
	/// Daemon agent dir; when set, the control discovery file is written here.
	pub agent_dir: Option<PathBuf>,
	/// Identifier of the daemon that owns this endpoint.
	pub owner_id:  String,
}

impl ControlServerConfig {
	/// Loopback config with an ephemeral port.
	#[must_use]
	pub fn new(token: impl Into<String>, owner_id: impl Into<String>) -> Self {
		Self {
			token:     token.into(),
			host:      IpAddr::V4(Ipv4Addr::LOCALHOST),
			port:      0,
			agent_dir: None,
			owner_id:  owner_id.into(),
		}
	}
}

#[derive(Debug)]
struct ControlState {
	token:        String,
	/// Valid, authorized lifecycle requests forwarded to the host daemon.
	lifecycle_tx: tokio::sync::mpsc::UnboundedSender<LifecycleClientMessage>,
	/// Host responses, broadcast to connection tasks for request-id routing.
	resp_tx:      broadcast::Sender<LifecycleServerMessage>,
}

/// Handle to a running control server.
#[derive(Debug)]
pub struct ControlServerHandle {
	addr:         SocketAddr,
	state:        Arc<ControlState>,
	cancel:       CancellationToken,
	accept_task:  tokio::task::JoinHandle<()>,
	agent_dir:    Option<PathBuf>,
	lifecycle_rx: Mutex<Option<tokio::sync::mpsc::UnboundedReceiver<LifecycleClientMessage>>>,
}

impl ControlServerHandle {
	/// The bound socket address (with the real port when `0` was requested).
	#[must_use]
	pub const fn addr(&self) -> SocketAddr {
		self.addr
	}

	/// The `ws://host:port` URL clients connect to (token passed as `?token=`).
	#[must_use]
	pub fn url(&self) -> String {
		format!("ws://{}", self.addr)
	}

	/// Take the receiver of forwarded, authorized lifecycle requests. Returns
	/// the receiver exactly once; subsequent calls return `None`. The host
	/// daemon drains it, performs all policy/spawn/idempotency work, then calls
	/// [`ControlServerHandle::respond`] with a terminal response.
	#[must_use]
	pub fn take_lifecycle_receiver(
		&self,
	) -> Option<tokio::sync::mpsc::UnboundedReceiver<LifecycleClientMessage>> {
		self.lifecycle_rx.lock().take()
	}

	/// Send a host-produced lifecycle response. It is routed back to the
	/// connection that originated the matching `requestId`.
	pub fn respond(&self, msg: LifecycleServerMessage) {
		let _ = self.state.resp_tx.send(msg);
	}

	/// Number of connections currently subscribed.
	#[must_use]
	pub fn client_count(&self) -> usize {
		self.state.resp_tx.receiver_count()
	}

	/// Stop the server. Idempotent: cancels the accept loop and all connection
	/// tasks and removes the control discovery file.
	pub fn stop(&self) {
		self.cancel.cancel();
		self.accept_task.abort();
		if let Some(dir) = self.agent_dir.as_deref() {
			let _ = crate::discovery::remove_control_endpoint(dir);
		}
	}
}

impl Drop for ControlServerHandle {
	fn drop(&mut self) {
		self.cancel.cancel();
	}
}

/// Bind the loopback control endpoint and spawn the accept loop.
///
/// Resolves only after the socket is bound; the returned
/// [`ControlServerHandle::addr`] reflects the real (possibly ephemeral) port.
///
/// # Errors
/// Returns [`std::io::ErrorKind::InvalidInput`] if a non-loopback bind host is
/// requested (the privileged control endpoint is loopback-only), the bind error
/// if the loopback socket cannot be acquired, or a filesystem error if the
/// control discovery file cannot be written.
pub async fn start_control(config: ControlServerConfig) -> std::io::Result<ControlServerHandle> {
	// The control endpoint is privileged (it spawns/kills sessions). It must
	// never be reachable off-host: refuse any non-loopback bind request.
	if !config.host.is_loopback() {
		return Err(std::io::Error::new(
			std::io::ErrorKind::InvalidInput,
			"control endpoint must bind a loopback address",
		));
	}
	let listener = TcpListener::bind(SocketAddr::new(config.host, config.port)).await?;
	let addr = listener.local_addr()?;

	if let Some(agent_dir) = config.agent_dir.as_deref() {
		let record =
			ControlEndpointRecord::new(&addr.ip().to_string(), addr.port(), config.owner_id.as_str());
		crate::discovery::write_control_endpoint(agent_dir, &record)?;
	}

	let (lifecycle_tx, lifecycle_rx) = tokio::sync::mpsc::unbounded_channel();
	let (resp_tx, _resp_rx) = broadcast::channel(256);
	let state = Arc::new(ControlState { token: config.token, lifecycle_tx, resp_tx });
	let cancel = CancellationToken::new();
	let accept_task = tokio::spawn(accept_loop(listener, Arc::clone(&state), cancel.clone()));

	Ok(ControlServerHandle {
		addr,
		state,
		cancel,
		accept_task,
		agent_dir: config.agent_dir,
		lifecycle_rx: Mutex::new(Some(lifecycle_rx)),
	})
}

async fn accept_loop(listener: TcpListener, state: Arc<ControlState>, cancel: CancellationToken) {
	loop {
		tokio::select! {
			() = cancel.cancelled() => break,
			accepted = listener.accept() => {
				let Ok((stream, _peer)) = accepted else { continue };
				tokio::spawn(handle_conn(stream, Arc::clone(&state), cancel.clone()));
			}
		}
	}
}

#[allow(
	clippy::result_large_err,
	reason = "ErrorResponse is the type mandated by tokio-tungstenite's accept_hdr_async callback"
)]
async fn handle_conn(stream: TcpStream, state: Arc<ControlState>, cancel: CancellationToken) {
	let expected = state.token.clone();
	let auth = move |req: &Request, resp: Response| -> Result<Response, ErrorResponse> {
		if token_from_query(req.uri().query()).is_some_and(|t| tokens_match(&t, &expected)) {
			Ok(resp)
		} else {
			let body = ErrorResponse::new(Some("unauthorized".to_owned()));
			let (mut parts, body) = body.into_parts();
			parts.status = StatusCode::UNAUTHORIZED;
			Err(ErrorResponse::from_parts(parts, body))
		}
	};

	let Ok(ws) = tokio_tungstenite::accept_hdr_async(stream, auth).await else {
		return;
	};

	let mut resp_rx = state.resp_tx.subscribe();
	let (mut write, mut read) = ws.split();
	// Request ids this connection originated, so it only forwards matching
	// responses (plus pre-parse errors, which carry no request id).
	let mut owned: HashSet<String> = HashSet::new();

	loop {
		tokio::select! {
			() = cancel.cancelled() => break,
			incoming = read.next() => {
				match incoming {
					Some(Ok(Message::Text(text))) => {
						if !handle_text(text.as_str(), &state, &mut owned, &mut write).await {
							break;
						}
					}
					Some(Ok(Message::Ping(payload))) => {
						if write.send(Message::Pong(payload)).await.is_err() {
							break;
						}
					}
					Some(Ok(Message::Close(_))) | None => break,
					Some(Ok(_)) => {}
					Some(Err(_)) => break,
				}
			}
			broadcasted = resp_rx.recv() => {
				match broadcasted {
					Ok(msg) => {
						if should_route(&msg, &owned)
							&& send_lifecycle(&mut write, &msg).await.is_err()
						{
							break;
						}
					}
					Err(broadcast::error::RecvError::Lagged(_)) => {}
					Err(broadcast::error::RecvError::Closed) => break,
				}
			}
		}
	}
}

/// Whether a host response should be written to this connection: responses for
/// request ids this connection originated, plus pre-parse errors (empty id).
fn should_route(msg: &LifecycleServerMessage, owned: &HashSet<String>) -> bool {
	match response_request_id(msg) {
		Some("") => true,
		Some(id) => owned.contains(id),
		None => false,
	}
}

fn response_request_id(msg: &LifecycleServerMessage) -> Option<&str> {
	match msg {
		LifecycleServerMessage::SessionCreateResponse(r) => Some(&r.request_id),
		LifecycleServerMessage::SessionCloseResponse(r) => Some(&r.request_id),
		LifecycleServerMessage::SessionResumeResponse(r) => Some(&r.request_id),
		LifecycleServerMessage::SessionLifecycleError(r) => Some(&r.request_id),
		LifecycleServerMessage::Unknown => None,
	}
}

/// Returns `false` when the connection should close.
async fn handle_text<S>(
	text: &str,
	state: &Arc<ControlState>,
	owned: &mut HashSet<String>,
	write: &mut S,
) -> bool
where
	S: SinkExt<Message> + Unpin,
{
	let Ok(msg) = serde_json::from_str::<LifecycleClientMessage>(text) else {
		// Ignore malformed frames without tearing down the connection.
		return true;
	};

	// Defense-in-depth: re-check the per-frame token even though the handshake
	// already validated `?token=`. A forwarded/replayed frame without the right
	// token is rejected as unauthorized and never reaches the host.
	if !msg.is_authorized(&state.token) {
		let request_id = msg.request_id().unwrap_or("").to_owned();
		let err = LifecycleServerMessage::SessionLifecycleError(SessionLifecycleError {
			request_id,
			status: LifecycleStatus::Error,
			reason: LifecycleErrorReason::Unauthorized,
			message: "unauthorized lifecycle frame".to_owned(),
			candidates: Vec::new(),
		});
		return send_lifecycle(write, &err).await.is_ok();
	}

	if let Some(id) = msg.request_id() {
		owned.insert(id.to_owned());
	}
	state.lifecycle_tx.send(msg).is_ok()
}

async fn send_lifecycle<S>(write: &mut S, msg: &LifecycleServerMessage) -> Result<(), ()>
where
	S: SinkExt<Message> + Unpin,
{
	let json = serde_json::to_string(msg).map_err(|_| ())?;
	write.send(Message::Text(json)).await.map_err(|_| ())
}

#[cfg(test)]
mod tests {
	use tokio_tungstenite::connect_async;

	use super::*;
	use crate::lifecycle::{SessionClose, SessionCloseTarget};

	fn close_frame(request_id: &str, token: &str) -> String {
		let msg = LifecycleClientMessage::SessionClose(SessionClose {
			request_id: request_id.into(),
			update_id:  1,
			chat_id:    "42".into(),
			token:      token.into(),
			target:     SessionCloseTarget {
				session_id:         "sess-1".into(),
				tmux_session:       None,
				session_state_file: None,
			},
			force:      true,
		});
		serde_json::to_string(&msg).expect("serialize")
	}

	async fn next_lifecycle<S>(read: &mut S) -> LifecycleServerMessage
	where
		S: StreamExt<Item = Result<Message, tokio_tungstenite::tungstenite::Error>> + Unpin,
	{
		loop {
			let msg = tokio::time::timeout(std::time::Duration::from_secs(2), read.next())
				.await
				.expect("timed out")
				.expect("stream closed")
				.expect("ws error");
			if let Message::Text(t) = msg {
				return serde_json::from_str(t.as_str()).expect("valid lifecycle message");
			}
		}
	}

	#[tokio::test]
	async fn handshake_rejects_wrong_token() {
		let handle = start_control(ControlServerConfig::new("control-token", "daemon-1"))
			.await
			.expect("start");
		let url = format!("ws://{}/?token=wrong", handle.addr());
		let result = connect_async(url).await;
		assert!(result.is_err(), "wrong token must be rejected at handshake");
		handle.stop();
	}

	#[tokio::test]
	async fn valid_frame_is_forwarded_and_response_routed_back() {
		let handle = start_control(ControlServerConfig::new("control-token", "daemon-1"))
			.await
			.expect("start");
		let mut rx = handle.take_lifecycle_receiver().expect("receiver");

		let url = format!("ws://{}/?token=control-token", handle.addr());
		let (mut ws, _resp) = connect_async(url).await.expect("connect");
		ws.send(Message::Text(close_frame("lc_04", "control-token")))
			.await
			.expect("send");

		// Host receives the forwarded, authorized request.
		let forwarded = tokio::time::timeout(std::time::Duration::from_secs(2), rx.recv())
			.await
			.expect("timed out")
			.expect("closed");
		assert_eq!(forwarded.request_id(), Some("lc_04"));

		// Host produces a terminal response; it is routed back by request id.
		handle.respond(LifecycleServerMessage::SessionCloseResponse(
			crate::lifecycle::SessionCloseResponse {
				request_id:        "lc_04".into(),
				status:            LifecycleStatus::Ok,
				session_id:        "sess-1".into(),
				process_gone:      true,
				history_preserved: true,
				endpoint_stale:    true,
			},
		));
		let got = next_lifecycle(&mut ws).await;
		match got {
			LifecycleServerMessage::SessionCloseResponse(r) => {
				assert_eq!(r.request_id, "lc_04");
				assert!(r.process_gone);
			},
			other => panic!("expected close response, got {other:?}"),
		}
		handle.stop();
	}

	#[tokio::test]
	async fn per_frame_token_mismatch_is_rejected_without_forwarding() {
		let handle = start_control(ControlServerConfig::new("control-token", "daemon-1"))
			.await
			.expect("start");
		let mut rx = handle.take_lifecycle_receiver().expect("receiver");

		let url = format!("ws://{}/?token=control-token", handle.addr());
		let (mut ws, _resp) = connect_async(url).await.expect("connect");
		// Right handshake token, wrong per-frame token.
		ws.send(Message::Text(close_frame("lc_09", "forged-token")))
			.await
			.expect("send");

		let got = next_lifecycle(&mut ws).await;
		match got {
			LifecycleServerMessage::SessionLifecycleError(e) => {
				assert_eq!(e.reason, LifecycleErrorReason::Unauthorized);
				assert_eq!(e.request_id, "lc_09");
			},
			other => panic!("expected unauthorized error, got {other:?}"),
		}
		// And nothing was forwarded to the host.
		assert!(rx.try_recv().is_err(), "unauthorized frame must not be forwarded to the host");
		handle.stop();
	}

	#[tokio::test]
	async fn non_loopback_bind_is_refused() {
		let mut config = ControlServerConfig::new("control-token", "daemon-1");
		config.host = IpAddr::V4(Ipv4Addr::UNSPECIFIED);
		let err = start_control(config)
			.await
			.expect_err("must refuse non-loopback");
		assert_eq!(err.kind(), std::io::ErrorKind::InvalidInput);
	}
}
