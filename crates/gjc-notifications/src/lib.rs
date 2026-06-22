//! GJC Notifications SDK core.
//!
//! A small, transport-agnostic core for the notifications SDK:
//!
//! - [`protocol`] defines the JSON wire contract ([`protocol::ServerMessage`] /
//!   [`protocol::ClientMessage`]) that third-party clients implement.
//! - [`actions`] implements the action lifecycle ([`actions::ActionRegistry`]):
//!   buffering the pending ask, replay to late clients, first-valid-reply-wins,
//!   idempotency, and non-repliable resolution.
//!
//! Networking (the loopback WebSocket server) and the N-API surface are layered
//! on top of this core in separate modules so the rules stay unit-testable
//! without native build tooling or sockets.

pub mod actions;
pub mod discovery;
pub mod protocol;
pub mod server;

pub use actions::{ActionRegistry, ReplyClassification, ReplyOutcome};
pub use discovery::{EndpointRecord, clean_stale, endpoint_path, read_endpoint, write_endpoint};
pub use protocol::{
	ActionKind, ActionNeeded, ActionResolved, AnswerSelector, ClientMessage, RejectReason, Reply,
	ReplyAnswer, ReplyRejected, ResolvedBy, ServerMessage,
};
pub use server::{ServerConfig, ServerHandle, start};
