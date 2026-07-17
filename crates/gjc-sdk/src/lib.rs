//! Gajae-Code SDK core.
//!
//! A small, transport-agnostic core for the Gajae-Code SDK:
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
pub mod broker_protocol;
pub mod control;
pub mod control_server;
pub mod discovery;
pub mod lifecycle;
pub mod protocol;
pub mod query;
pub mod reverse;
pub mod server;

pub use actions::{ActionIdentity, ActionRegistry, ReplyClassification, ReplyOutcome};
pub use broker_protocol::{
	BrokerClientFrame, BrokerError, BrokerHello, BrokerOperation, BrokerRequest, BrokerResponse,
	BrokerServerFrame, PROTOCOL_MAJOR,
};
pub use control::{
	ControlClientFrame, ControlError, ControlRequest, ControlResponse, ControlServerFrame,
};
pub use control_server::{ControlServerConfig, ControlServerHandle, start_control};
pub use discovery::{
	ControlEndpointRecord, EndpointRecord, clean_stale, control_endpoint_path, endpoint_path,
	read_control_endpoint, read_endpoint, remove_control_endpoint, write_control_endpoint,
	write_endpoint,
};
pub use lifecycle::{
	LifecycleClientMessage, LifecycleEndpoint, LifecycleErrorReason, LifecycleServerMessage,
	LifecycleStatus, MatchedBy, ResumeCandidate, ResumeMode, SessionClose, SessionCloseResponse,
	SessionCloseTarget, SessionCreate, SessionCreateResponse, SessionCreateTarget,
	SessionLifecycleError, SessionResume, SessionResumeResponse, SessionResumeTarget,
};
pub use protocol::{
	ActionKind, ActionNeeded, ActionResolved, ActionUnavailable, ActionUnavailableReason,
	AnswerSelector, ClientMessage, RejectReason, Reply, ReplyAnswer, ReplyRejected, ResolvedBy,
	ServerMessage, Verbosity,
};
pub use query::{
	CursorEnvelope, QueryClientFrame, QueryError, QueryPage, QueryRequest, QueryResponse,
	QueryServerFrame,
};
pub use reverse::{
	LeaseRelease, LeaseState, ProviderHeartbeat, RegisterProvider, RegisterProviderResult,
	ReverseCapability, ReverseClientFrame, ReverseError, ReverseRequest, ReverseResponse,
	ReverseServerFrame,
};
pub use server::{
	CapabilityUpdate, PushFrameError, ServerConfig, ServerHandle, WorkflowGateRegistrationError,
	start,
};
