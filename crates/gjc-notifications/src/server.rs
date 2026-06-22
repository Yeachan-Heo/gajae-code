//! Loopback WebSocket server for the notifications SDK.
//!
//! Owns the network surface: a per-session `ws://127.0.0.1:<port>` endpoint
//! with token auth, a connection registry, fan-out broadcast, replay of the
//! buffered ask to late clients, and reply routing into the [`ActionRegistry`].
//!
//! Lifecycle matches the planned N-API contract:
//! - [`start`] binds the loopback socket and returns the **bound** address
//!   before resolving; the accept loop runs in the background and is never
//!   awaited by the caller.
//! - [`ServerHandle::stop`] is idempotent: it cancels the accept loop and all
//!   per-connection tasks and may be called any number of times.

use std::{
	net::{IpAddr, Ipv4Addr, SocketAddr},
	path::PathBuf,
	sync::{
		Arc,
		atomic::{AtomicBool, Ordering},
	},
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
	actions::{ActionRegistry, ReplyClassification, ReplyOutcome},
	discovery::EndpointRecord,
	protocol::{
		ActionNeeded, ClientMessage, PROTOCOL_VERSION, Pong, RejectReason, Reply, ReplyAnswer,
		ReplyRejected, ServerHello, ServerMessage, capabilities,
	},
};

/// Configuration for a per-session notification server.
#[derive(Debug, Clone)]
pub struct ServerConfig {
	/// The session this endpoint belongs to.
	pub session_id:         String,
	/// The per-session token clients must present (as `?token=` on connect).
	pub token:              String,
	/// Bind host. Defaults to loopback via [`ServerConfig::new`].
	pub host:               IpAddr,
	/// Bind port. `0` selects an ephemeral port; the bound port is read back.
	pub port:               u16,
	/// Whether an unattended/RPC gate resolver is available for ask round-trips.
	/// When `false`, asks are notify-only and replies are rejected.
	pub resolver_available: bool,
	/// Optional GJC state root. When set, the server writes/removes the endpoint
	/// discovery file at `<state_root>/notifications/<session_id>.json`.
	pub state_root:         Option<PathBuf>,
	/// When `true`, accepted client replies are forwarded to the host (via
	/// [`ServerHandle::take_reply_receiver`]) instead of resolving internally,
	/// so the host resolves the real gate then calls
	/// [`ServerHandle::resolve_client`].
	pub forward_replies:    bool,
}

impl ServerConfig {
	/// Loopback config with an ephemeral port.
	#[must_use]
	pub fn new(session_id: impl Into<String>, token: impl Into<String>) -> Self {
		Self {
			session_id:         session_id.into(),
			token:              token.into(),
			host:               IpAddr::V4(Ipv4Addr::LOCALHOST),
			port:               0,
			resolver_available: true,
			state_root:         None,
			forward_replies:    false,
		}
	}
}

/// Shared server state behind the handle and every connection task.
#[derive(Debug)]
struct ServerState {
	token:              String,
	registry:           Mutex<ActionRegistry>,
	tx:                 broadcast::Sender<ServerMessage>,
	resolver_available: AtomicBool,
	/// Present in forward mode: accepted replies are sent here for the host.
	reply_tx:           Option<tokio::sync::mpsc::UnboundedSender<Reply>>,
	/// Always present: inbound free-text injections / in-thread config commands
	/// forwarded to the host (token-authorized).
	inbound_tx:         tokio::sync::mpsc::UnboundedSender<ClientMessage>,
}

/// Handle to a running server. Dropping it does not stop the server; call
/// [`ServerHandle::stop`] (idempotent) for deterministic shutdown.
#[derive(Debug)]
pub struct ServerHandle {
	addr:        SocketAddr,
	state:       Arc<ServerState>,
	cancel:      CancellationToken,
	accept_task: tokio::task::JoinHandle<()>,
	session_id:  String,
	state_root:  Option<PathBuf>,
	reply_rx:    Mutex<Option<tokio::sync::mpsc::UnboundedReceiver<Reply>>>,
	inbound_rx:  Mutex<Option<tokio::sync::mpsc::UnboundedReceiver<ClientMessage>>>,
}

impl ServerHandle {
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

	/// Register an `ask` action and broadcast it to connected clients.
	///
	/// `repliable` should be `true` only in unattended/RPC mode where the gate
	/// resolver can actually answer the ask.
	pub fn register_ask(&self, needed: ActionNeeded, repliable: bool) {
		self
			.state
			.registry
			.lock()
			.register_ask(needed.clone(), repliable);
		let _ = self.state.tx.send(ServerMessage::ActionNeeded(needed));
	}

	/// Broadcast an ephemeral idle ping (not buffered, not repliable).
	pub fn note_idle(&self, needed: ActionNeeded) {
		let msg = self.state.registry.lock().note_idle(needed);
		let _ = self.state.tx.send(ServerMessage::ActionNeeded(msg));
	}

	/// Broadcast an ephemeral threaded-session frame to connected clients.
	///
	/// Used for the additive identity/context/turn/image/config/hello frames.
	/// Like [`ServerHandle::note_idle`] these are not buffered for replay (the
	/// host re-emits the identity header on reconnect); existing buffered-ask
	/// replay (see [`ServerHandle::register_ask`]) is unaffected.
	pub fn push_frame(&self, msg: ServerMessage) {
		let _ = self.state.tx.send(msg);
	}

	/// Resolve a pending action locally (e.g. the CLI/TUI answered it).
	///
	/// Broadcasts `action_resolved` so clients mark it non-repliable. A no-op if
	/// the action was already resolved.
	pub fn resolve_local(&self, id: &str, answer: Option<ReplyAnswer>) {
		let resolved = self.state.registry.lock().resolve_local(id, answer);
		if let Some(resolved) = resolved {
			let _ = self.state.tx.send(ServerMessage::ActionResolved(resolved));
		}
	}

	/// Take the receiver of accepted client replies (forward mode only).
	///
	/// Returns the receiver exactly once; subsequent calls return `None`. The
	/// host drains it, resolves the real gate per reply, then calls
	/// [`ServerHandle::resolve_client`] (or [`ServerHandle::reject`] on
	/// failure).
	#[must_use]
	pub fn take_reply_receiver(&self) -> Option<tokio::sync::mpsc::UnboundedReceiver<Reply>> {
		self.reply_rx.lock().take()
	}

	/// Take the receiver of forwarded inbound messages (free-text injections and
	/// in-thread config commands). Returns the receiver exactly once; subsequent
	/// calls return `None`.
	#[must_use]
	pub fn take_inbound_receiver(
		&self,
	) -> Option<tokio::sync::mpsc::UnboundedReceiver<ClientMessage>> {
		self.inbound_rx.lock().take()
	}

	/// Resolve a pending action as answered by a remote client, after the host
	/// has resolved the real gate. Broadcasts `action_resolved`; no-op if
	/// already terminal.
	pub fn resolve_client(
		&self,
		id: &str,
		answer: Option<ReplyAnswer>,
		idempotency_key: Option<String>,
	) {
		let resolved = self
			.state
			.registry
			.lock()
			.resolve_client(id, answer, idempotency_key);
		if let Some(resolved) = resolved {
			let _ = self.state.tx.send(ServerMessage::ActionResolved(resolved));
		}
	}

	/// Reject a forwarded reply after the host failed to resolve its gate.
	/// Broadcasts `reply_rejected` for the action id; the action stays pending.
	pub fn reject(&self, id: &str, reason: RejectReason) {
		let _ = self
			.state
			.tx
			.send(ServerMessage::ReplyRejected(ReplyRejected { id: id.to_owned(), reason }));
	}

	/// Update whether the unattended gate resolver is currently available.
	pub fn set_resolver_available(&self, available: bool) {
		self
			.state
			.resolver_available
			.store(available, Ordering::SeqCst);
	}

	/// Number of clients currently subscribed to the broadcast channel.
	#[must_use]
	pub fn client_count(&self) -> usize {
		self.state.tx.receiver_count()
	}

	/// Stop the server. Idempotent: cancels the accept loop and all connection
	/// tasks; safe to call multiple times.
	pub fn stop(&self) {
		self.cancel.cancel();
		self.accept_task.abort();
		if let Some(root) = self.state_root.as_deref() {
			let _ = crate::discovery::remove_endpoint(root, &self.session_id);
		}
	}
}

impl Drop for ServerHandle {
	fn drop(&mut self) {
		// Best-effort: ensure the accept loop does not outlive the handle's intent
		// when the caller forgot to stop. Connection tasks observe the same token.
		self.cancel.cancel();
	}
}

/// Bind the loopback endpoint and spawn the accept loop in the background.
///
/// Resolves only after the socket is bound; the returned [`ServerHandle::addr`]
/// reflects the real (possibly ephemeral) port.
///
/// # Errors
/// Returns the bind error if the loopback socket cannot be acquired.
pub async fn start(config: ServerConfig) -> std::io::Result<ServerHandle> {
	let listener = TcpListener::bind(SocketAddr::new(config.host, config.port)).await?;
	let addr = listener.local_addr()?;
	let (tx, _rx) = broadcast::channel(256);

	if let Some(state_root) = config.state_root.as_deref() {
		let record = EndpointRecord::new(
			config.session_id.as_str(),
			&addr.ip().to_string(),
			addr.port(),
			config.token.as_str(),
		);
		crate::discovery::write_endpoint(state_root, &record)?;
	}

	let (reply_tx, reply_rx) = if config.forward_replies {
		let (tx, rx) = tokio::sync::mpsc::unbounded_channel();
		(Some(tx), Some(rx))
	} else {
		(None, None)
	};
	let (inbound_tx, inbound_rx) = tokio::sync::mpsc::unbounded_channel::<ClientMessage>();

	let state = Arc::new(ServerState {
		token: config.token,
		registry: Mutex::new(ActionRegistry::new()),
		tx,
		resolver_available: AtomicBool::new(config.resolver_available),
		reply_tx,
		inbound_tx,
	});
	let cancel = CancellationToken::new();
	let accept_task = tokio::spawn(accept_loop(listener, Arc::clone(&state), cancel.clone()));
	Ok(ServerHandle {
		addr,
		state,
		cancel,
		accept_task,
		session_id: config.session_id,
		state_root: config.state_root,
		reply_rx: Mutex::new(reply_rx),
		inbound_rx: Mutex::new(Some(inbound_rx)),
	})
}

async fn accept_loop(listener: TcpListener, state: Arc<ServerState>, cancel: CancellationToken) {
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
async fn handle_conn(stream: TcpStream, state: Arc<ServerState>, cancel: CancellationToken) {
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

	let mut rx = state.tx.subscribe();
	let (mut write, mut read) = ws.split();
	let hello = ServerMessage::Hello(ServerHello {
		protocol_version: PROTOCOL_VERSION,
		capabilities:     vec![
			capabilities::THREADED.into(),
			capabilities::CONTEXT.into(),
			capabilities::TURN_STREAM.into(),
			capabilities::IMAGES.into(),
			capabilities::CONFIG.into(),
			capabilities::CLIENT_PING_PONG.into(),
		],
	});
	if send_msg(&mut write, &hello).await.is_err() {
		return;
	}

	// Replay the buffered ask (if any) to this freshly-connected client.
	let replay = state.registry.lock().replay_for_new_client().cloned();
	if let Some(replay) = replay
		&& send_msg(&mut write, &ServerMessage::ActionNeeded(replay))
			.await
			.is_err()
	{
		return;
	}

	loop {
		tokio::select! {
			 () = cancel.cancelled() => break,
			 incoming = read.next() => {
				  match incoming {
						Some(Ok(Message::Text(text))) => {
							 if !handle_text(text.as_str(), &state, &mut write).await {
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
			 broadcasted = rx.recv() => {
				  match broadcasted {
						Ok(msg) => {
							 if send_msg(&mut write, &msg).await.is_err() {
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

/// Returns `false` when the connection should close.
async fn handle_text<S>(text: &str, state: &Arc<ServerState>, write: &mut S) -> bool
where
	S: SinkExt<Message> + Unpin,
{
	let Ok(msg) = serde_json::from_str::<ClientMessage>(text) else {
		// Ignore malformed frames without tearing down the connection.
		return true;
	};
	let reply = match msg {
		ClientMessage::Reply(reply) => reply,
		// Inbound free-text injection / in-thread config command: forward to the
		// host (token-authorized) and stop. These are not action replies.
		ClientMessage::UserMessage(u) => {
			if tokens_match(&u.token, &state.token) {
				let _ = state.inbound_tx.send(ClientMessage::UserMessage(u));
			}
			return true;
		},
		ClientMessage::ConfigCommand(c) => {
			if tokens_match(&c.token, &state.token) {
				let _ = state.inbound_tx.send(ClientMessage::ConfigCommand(c));
			}
			return true;
		},
		ClientMessage::Ping(p) => {
			return send_msg(write, &ServerMessage::Pong(Pong { nonce: p.nonce }))
				.await
				.is_ok();
		},
		// Capability handshake / forward-compat: nothing to do server-side yet.
		ClientMessage::Hello(_) | ClientMessage::Unknown => return true,
	};

	let authorized = tokens_match(&reply.token, &state.token);
	let resolver = state.resolver_available.load(Ordering::SeqCst);

	// Forward mode: accepted replies go to the host (which resolves the real gate
	// and calls resolve_client); only immediate rejections are answered here.
	if let Some(reply_tx) = &state.reply_tx {
		let classification = state
			.registry
			.lock()
			.classify_reply(&reply, authorized, resolver);
		return match classification {
			ReplyClassification::Forward => reply_tx.send(reply).is_ok(),
			ReplyClassification::Duplicate => true,
			ReplyClassification::Reject(reason) => {
				send_msg(write, &ServerMessage::ReplyRejected(ReplyRejected { id: reply.id, reason }))
					.await
					.is_ok()
			},
		};
	}

	let outcome = state
		.registry
		.lock()
		.apply_reply(&reply, authorized, resolver);

	match outcome {
		ReplyOutcome::Resolved(resolved) => {
			// Broadcast so every client (including this one) marks it non-repliable.
			let _ = state.tx.send(ServerMessage::ActionResolved(resolved));
			true
		},
		ReplyOutcome::DuplicateAccepted => true,
		ReplyOutcome::Rejected(reason) => {
			// Reply rejections go only to the offending client.
			send_msg(write, &ServerMessage::ReplyRejected(ReplyRejected { id: reply.id, reason }))
				.await
				.is_ok()
		},
	}
}

async fn send_msg<S>(write: &mut S, msg: &ServerMessage) -> Result<(), ()>
where
	S: SinkExt<Message> + Unpin,
{
	let json = serde_json::to_string(msg).map_err(|_| ())?;
	write.send(Message::Text(json)).await.map_err(|_| ())
}

/// Extract the `token` query parameter value (no percent-decoding; tokens are
/// generated URL-safe).
fn token_from_query(query: Option<&str>) -> Option<String> {
	let query = query?;
	query.split('&').find_map(|pair| {
		let mut it = pair.splitn(2, '=');
		(it.next() == Some("token")).then(|| it.next().unwrap_or("").to_owned())
	})
}

/// Constant-time-ish token comparison (length is allowed to leak).
fn tokens_match(a: &str, b: &str) -> bool {
	let (a, b) = (a.as_bytes(), b.as_bytes());
	if a.len() != b.len() {
		return false;
	}
	let mut diff = 0u8;
	for (x, y) in a.iter().zip(b) {
		diff |= x ^ y;
	}
	diff == 0
}

#[cfg(test)]
mod tests {
	use futures_util::SinkExt;
	use tokio_tungstenite::connect_async;

	use super::*;
	use crate::protocol::{ActionKind, Ping, Reply};

	fn ask(id: &str) -> ActionNeeded {
		ActionNeeded {
			id:         id.into(),
			kind:       ActionKind::Ask,
			session_id: "s".into(),
			question:   Some("Proceed?".into()),
			options:    Some(vec!["Yes".into(), "No".into()]),
			summary:    None,
		}
	}

	async fn next_server_msg<S>(read: &mut S) -> ServerMessage
	where
		S: StreamExt<Item = Result<Message, tokio_tungstenite::tungstenite::Error>> + Unpin,
	{
		loop {
			let msg = tokio::time::timeout(std::time::Duration::from_secs(2), read.next())
				.await
				.expect("timed out waiting for server message")
				.expect("stream closed")
				.expect("ws error");
			if let Message::Text(t) = msg {
				return serde_json::from_str(t.as_str()).expect("valid server message");
			}
		}
	}

	async fn next_server_hello<S>(read: &mut S) -> ServerHello
	where
		S: StreamExt<Item = Result<Message, tokio_tungstenite::tungstenite::Error>> + Unpin,
	{
		match next_server_msg(read).await {
			ServerMessage::Hello(hello) => {
				assert_eq!(hello.protocol_version, PROTOCOL_VERSION);
				assert!(
					hello
						.capabilities
						.contains(&capabilities::CLIENT_PING_PONG.into())
				);
				hello
			},
			other => panic!("expected hello, got {other:?}"),
		}
	}

	async fn connect(
		handle: &ServerHandle,
		token: &str,
	) -> tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<TcpStream>> {
		let url = format!("ws://{}/?token={}", handle.addr(), token);
		let (ws, _resp) = connect_async(url).await.expect("connect");
		ws
	}

	#[tokio::test]
	async fn start_binds_ephemeral_port() {
		let handle = start(ServerConfig::new("s", "secret")).await.unwrap();
		assert_ne!(handle.addr().port(), 0);
		assert!(handle.addr().ip().is_loopback());
		handle.stop();
	}

	#[tokio::test]
	async fn wrong_token_is_rejected() {
		let handle = start(ServerConfig::new("s", "secret")).await.unwrap();
		let url = format!("ws://{}/?token=wrong", handle.addr());
		assert!(connect_async(url).await.is_err());
		handle.stop();
	}

	#[tokio::test]
	async fn ask_broadcast_then_reply_resolves() {
		let handle = start(ServerConfig::new("s", "secret")).await.unwrap();
		let mut ws = connect(&handle, "secret").await;
		next_server_hello(&mut ws).await;
		// wait for the client to be subscribed before broadcasting
		wait_for_clients(&handle, 1).await;

		handle.register_ask(ask("a1"), true);
		let got = next_server_msg(&mut ws).await;
		assert!(
			matches!(got, ServerMessage::ActionNeeded(a) if a.id == "a1" && a.kind == ActionKind::Ask)
		);

		let reply = Reply {
			id:              "a1".into(),
			answer:          ReplyAnswer::Index(0),
			token:           "secret".into(),
			idempotency_key: None,
		};
		ws.send(Message::Text(serde_json::to_string(&ClientMessage::Reply(reply)).unwrap()))
			.await
			.unwrap();

		let resolved = next_server_msg(&mut ws).await;
		match resolved {
			ServerMessage::ActionResolved(r) => {
				assert_eq!(r.id, "a1");
				assert_eq!(r.resolved_by, crate::protocol::ResolvedBy::Client);
			},
			other => panic!("expected action_resolved, got {other:?}"),
		}
		handle.stop();
	}

	#[tokio::test]
	async fn push_frame_broadcasts_threaded_frames_and_preserves_ask() {
		use crate::protocol::{IdentityHeader, TurnPhase, TurnStream};
		let handle = start(ServerConfig::new("s", "secret")).await.unwrap();
		let mut ws = connect(&handle, "secret").await;
		next_server_hello(&mut ws).await;
		wait_for_clients(&handle, 1).await;

		handle.push_frame(ServerMessage::IdentityHeader(IdentityHeader {
			session_id: "s".into(),
			repo:       "gajae-code".into(),
			branch:     "feat/notification-surface".into(),
			machine:    "m1".into(),
			title:      Some("Session".into()),
		}));
		match next_server_msg(&mut ws).await {
			ServerMessage::IdentityHeader(h) => assert_eq!(h.repo, "gajae-code"),
			other => panic!("expected identity_header, got {other:?}"),
		}

		handle.push_frame(ServerMessage::TurnStream(TurnStream {
			session_id:  "s".into(),
			phase:       TurnPhase::Finalized,
			text:        "done".into(),
			message_ref: None,
		}));
		match next_server_msg(&mut ws).await {
			ServerMessage::TurnStream(t) => {
				assert_eq!(t.phase, TurnPhase::Finalized);
				assert_eq!(t.text, "done");
			},
			other => panic!("expected turn_stream, got {other:?}"),
		}

		// Buffered-ask broadcast still works alongside the new streaming frames.
		handle.register_ask(ask("a1"), true);
		match next_server_msg(&mut ws).await {
			ServerMessage::ActionNeeded(a) => assert_eq!(a.id, "a1"),
			other => panic!("expected action_needed, got {other:?}"),
		}
		handle.stop();
	}

	#[tokio::test]
	async fn unknown_action_reply_is_rejected_to_sender() {
		let handle = start(ServerConfig::new("s", "secret")).await.unwrap();
		let mut ws = connect(&handle, "secret").await;
		next_server_hello(&mut ws).await;
		wait_for_clients(&handle, 1).await;

		let reply = Reply {
			id:              "ghost".into(),
			answer:          ReplyAnswer::Index(0),
			token:           "secret".into(),
			idempotency_key: None,
		};
		ws.send(Message::Text(serde_json::to_string(&ClientMessage::Reply(reply)).unwrap()))
			.await
			.unwrap();

		let rejected = next_server_msg(&mut ws).await;
		match rejected {
			ServerMessage::ReplyRejected(r) => {
				assert_eq!(r.id, "ghost");
				assert_eq!(r.reason, crate::protocol::RejectReason::UnknownAction);
			},
			other => panic!("expected reply_rejected, got {other:?}"),
		}
		handle.stop();
	}

	#[tokio::test]
	async fn late_client_gets_buffered_ask_replay() {
		let handle = start(ServerConfig::new("s", "secret")).await.unwrap();
		// register before any client connects
		handle.register_ask(ask("a1"), true);
		// connect afterwards: should receive the buffered ask on connect
		let mut ws = connect(&handle, "secret").await;
		next_server_hello(&mut ws).await;
		let got = next_server_msg(&mut ws).await;
		assert!(matches!(got, ServerMessage::ActionNeeded(a) if a.id == "a1"));
		handle.stop();
	}

	#[tokio::test]
	async fn hello_before_replay() {
		let handle = start(ServerConfig::new("s", "secret")).await.unwrap();
		handle.register_ask(ask("a1"), true);

		let mut ws = connect(&handle, "secret").await;
		let hello = next_server_hello(&mut ws).await;
		assert_eq!(hello.capabilities, vec![
			capabilities::THREADED,
			capabilities::CONTEXT,
			capabilities::TURN_STREAM,
			capabilities::IMAGES,
			capabilities::CONFIG,
			capabilities::CLIENT_PING_PONG,
		]);

		match next_server_msg(&mut ws).await {
			ServerMessage::ActionNeeded(a) => assert_eq!(a.id, "a1"),
			other => panic!("expected replayed action_needed, got {other:?}"),
		}
		handle.stop();
	}

	#[tokio::test]
	async fn ping_gets_pong() {
		let handle = start(ServerConfig::new("s", "secret")).await.unwrap();
		let mut sender = connect(&handle, "secret").await;
		next_server_hello(&mut sender).await;
		let mut other = connect(&handle, "secret").await;
		next_server_hello(&mut other).await;
		wait_for_clients(&handle, 2).await;

		sender
			.send(Message::Text(
				serde_json::to_string(&ClientMessage::Ping(Ping { nonce: "n1".into() })).unwrap(),
			))
			.await
			.unwrap();

		match next_server_msg(&mut sender).await {
			ServerMessage::Pong(p) => assert_eq!(p.nonce, "n1"),
			other => panic!("expected pong, got {other:?}"),
		}
		let broadcast =
			tokio::time::timeout(std::time::Duration::from_millis(300), next_server_msg(&mut other))
				.await;
		assert!(broadcast.is_err(), "pong must not be broadcast");
		handle.stop();
	}

	#[tokio::test]
	async fn resolve_local_broadcasts_resolved() {
		let handle = start(ServerConfig::new("s", "secret")).await.unwrap();
		let mut ws = connect(&handle, "secret").await;
		next_server_hello(&mut ws).await;
		wait_for_clients(&handle, 1).await;
		handle.register_ask(ask("a1"), true);
		let _needed = next_server_msg(&mut ws).await;

		handle.resolve_local("a1", None);
		let resolved = next_server_msg(&mut ws).await;
		match resolved {
			ServerMessage::ActionResolved(r) => {
				assert_eq!(r.id, "a1");
				assert_eq!(r.resolved_by, crate::protocol::ResolvedBy::Local);
			},
			other => panic!("expected action_resolved local, got {other:?}"),
		}
		handle.stop();
	}

	#[tokio::test]
	async fn stop_is_idempotent() {
		let handle = start(ServerConfig::new("s", "secret")).await.unwrap();
		handle.stop();
		handle.stop();
		handle.stop();
	}

	#[tokio::test]
	async fn forward_mode_routes_reply_to_host_then_resolves() {
		let mut config = ServerConfig::new("s", "secret");
		config.forward_replies = true;
		let handle = start(config).await.unwrap();
		let mut rx = handle.take_reply_receiver().expect("forward receiver");
		assert!(handle.take_reply_receiver().is_none(), "receiver is take-once");

		let mut ws = connect(&handle, "secret").await;
		next_server_hello(&mut ws).await;
		wait_for_clients(&handle, 1).await;
		handle.register_ask(ask("a1"), true);
		let _needed = next_server_msg(&mut ws).await;

		let reply = Reply {
			id:              "a1".into(),
			answer:          ReplyAnswer::Index(1),
			token:           "secret".into(),
			idempotency_key: None,
		};
		ws.send(Message::Text(serde_json::to_string(&ClientMessage::Reply(reply)).unwrap()))
			.await
			.unwrap();

		let fwd = tokio::time::timeout(std::time::Duration::from_secs(2), rx.recv())
			.await
			.expect("forward timeout")
			.expect("reply forwarded");
		assert_eq!(fwd.id, "a1");
		assert_eq!(fwd.answer, ReplyAnswer::Index(1));

		handle.resolve_client("a1", Some(ReplyAnswer::Index(1)), None);
		let resolved = next_server_msg(&mut ws).await;
		assert!(
			matches!(resolved, ServerMessage::ActionResolved(r) if r.id == "a1" && r.resolved_by == crate::protocol::ResolvedBy::Client)
		);
		handle.stop();
	}

	#[tokio::test]
	async fn forward_mode_rejects_unknown_action_without_host() {
		let mut config = ServerConfig::new("s", "secret");
		config.forward_replies = true;
		let handle = start(config).await.unwrap();
		let _rx = handle.take_reply_receiver();
		let mut ws = connect(&handle, "secret").await;
		next_server_hello(&mut ws).await;
		wait_for_clients(&handle, 1).await;

		let reply = Reply {
			id:              "ghost".into(),
			answer:          ReplyAnswer::Index(0),
			token:           "secret".into(),
			idempotency_key: None,
		};
		ws.send(Message::Text(serde_json::to_string(&ClientMessage::Reply(reply)).unwrap()))
			.await
			.unwrap();
		let rejected = next_server_msg(&mut ws).await;
		assert!(
			matches!(rejected, ServerMessage::ReplyRejected(r) if r.id == "ghost" && r.reason == crate::protocol::RejectReason::UnknownAction)
		);
		handle.stop();
	}

	#[tokio::test]
	async fn writes_and_removes_endpoint_discovery_file() {
		let root = std::env::temp_dir().join(format!(
			"gjc-notif-srv-{}-{}",
			std::process::id(),
			std::time::SystemTime::now()
				.duration_since(std::time::UNIX_EPOCH)
				.unwrap()
				.as_nanos()
		));
		std::fs::create_dir_all(&root).unwrap();

		let mut config = ServerConfig::new("sess-disc", "secret");
		config.state_root = Some(root.clone());
		let handle = start(config).await.unwrap();

		let path = crate::discovery::endpoint_path(&root, "sess-disc");
		let record = crate::discovery::read_endpoint(&path).expect("endpoint file written");
		assert_eq!(record.port, handle.addr().port());
		assert_eq!(record.token, "secret");
		assert!(record.url.starts_with("ws://127.0.0.1:"));

		handle.stop();
		assert!(crate::discovery::read_endpoint(&path).is_none(), "endpoint removed on stop");
		std::fs::remove_dir_all(&root).ok();
	}

	async fn wait_for_clients(handle: &ServerHandle, n: usize) {
		for _ in 0..200 {
			if handle.client_count() >= n {
				return;
			}
			tokio::time::sleep(std::time::Duration::from_millis(10)).await;
		}
		panic!("clients did not subscribe in time");
	}

	#[tokio::test]
	async fn inbound_user_message_forwards_to_host() {
		let handle = start(ServerConfig::new("s", "secret")).await.unwrap();
		let mut inbound = handle.take_inbound_receiver().expect("inbound rx");
		let mut ws = connect(&handle, "secret").await;
		next_server_hello(&mut ws).await;
		wait_for_clients(&handle, 1).await;
		ws.send(Message::Text(
			serde_json::to_string(&ClientMessage::UserMessage(crate::protocol::UserMessage {
				session_id: "s".into(),
				text:       "keep going".into(),
				token:      "secret".into(),
				update_id:  Some(7),
				thread_id:  Some("topic-1".into()),
			}))
			.unwrap()
			.into(),
		))
		.await
		.unwrap();
		let got = tokio::time::timeout(std::time::Duration::from_secs(2), inbound.recv())
			.await
			.expect("inbound timed out")
			.expect("inbound channel closed");
		match got {
			ClientMessage::UserMessage(u) => {
				assert_eq!(u.text, "keep going");
				assert_eq!(u.update_id, Some(7));
				assert_eq!(u.thread_id.as_deref(), Some("topic-1"));
			},
			other => panic!("expected user_message, got {other:?}"),
		}
		handle.stop();
	}

	#[tokio::test]
	async fn inbound_user_message_wrong_token_is_dropped() {
		let handle = start(ServerConfig::new("s", "secret")).await.unwrap();
		let mut inbound = handle.take_inbound_receiver().expect("inbound rx");
		let mut ws = connect(&handle, "secret").await;
		next_server_hello(&mut ws).await;
		wait_for_clients(&handle, 1).await;
		ws.send(Message::Text(
			serde_json::to_string(&ClientMessage::UserMessage(crate::protocol::UserMessage {
				session_id: "s".into(),
				text:       "x".into(),
				token:      "WRONG".into(),
				update_id:  None,
				thread_id:  None,
			}))
			.unwrap()
			.into(),
		))
		.await
		.unwrap();
		let r = tokio::time::timeout(std::time::Duration::from_millis(300), inbound.recv()).await;
		assert!(r.is_err(), "wrong-token inbound must not forward");
		handle.stop();
	}
}
