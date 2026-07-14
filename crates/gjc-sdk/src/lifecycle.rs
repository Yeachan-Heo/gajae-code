//! Session lifecycle control protocol for the Gajae-Code SDK.
//!
//! This is the wire contract for remote session **create / close / resume**,
//! issued by the daemon-owned control client (e.g. the bundled Telegram daemon)
//! against a session-independent, authenticated loopback control endpoint.
//!
//! Design boundary (deliberate): the Rust side is a *minimal authenticated
//! ingress*. It parses, authenticates, and forwards lifecycle frames; it does
//! **not** own Telegram policy, spawn orchestration, idempotency, rate
//! limiting, audit, or UX — those live in the TypeScript daemon.
//!
//! Field names are `camelCase` on the wire (matching the TypeScript daemon),
//! while the `type` / enum discriminators are `snake_case`, consistent with the
//! per-session [`crate::protocol`] frames.

use serde::{Deserialize, Serialize};

/// Where a `session_create` should run. Tagged by `kind` on the wire.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum SessionCreateTarget {
	/// Start a session in an existing repository/working directory.
	#[serde(rename_all = "camelCase")]
	ExistingPath {
		/// Absolute path to the existing repo/working dir.
		path: String,
	},
	/// Provision a new git worktree off `repo` on `branch`, then start there.
	#[serde(rename_all = "camelCase")]
	Worktree {
		/// Absolute path to the source repository.
		repo:   String,
		/// Branch name for the new worktree.
		branch: String,
	},
	/// Create a brand-new plain directory, then start there.
	#[serde(rename_all = "camelCase")]
	PlainDir {
		/// Absolute path of the directory to create.
		path: String,
	},
}

/// Identifies the session a `session_close` targets.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionCloseTarget {
	/// Authoritative GJC session id.
	pub session_id:         String,
	/// Expected GJC-managed tmux session name (defense-in-depth match).
	#[serde(default, skip_serializing_if = "Option::is_none")]
	pub tmux_session:       Option<String>,
	/// Expected `@gjc-session-state-file` tag (defense-in-depth match).
	#[serde(default, skip_serializing_if = "Option::is_none")]
	pub session_state_file: Option<String>,
}

/// Identifies the session a `session_resume` targets.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionResumeTarget {
	/// Session id or unambiguous prefix to resume.
	pub session_id_or_prefix: String,
	/// Optional repo/working dir hint to disambiguate matches.
	#[serde(default, skip_serializing_if = "Option::is_none")]
	pub path:                 Option<String>,
}

/// Request to create a new session.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionCreate {
	/// Correlation id for this control request (echoed in the response).
	pub request_id:           String,
	/// Deterministic lifecycle marker preallocated by the daemon before spawn.
	pub lifecycle_request_id: String,
	/// The session id the daemon preallocated and propagates to the child.
	pub intended_session_id:  String,
	/// Telegram update id (idempotency key on the daemon side).
	pub update_id:            i64,
	/// Originating paired chat id.
	pub chat_id:              String,
	/// Control-endpoint token authorizing this frame.
	pub token:                String,
	/// Where the session should run.
	pub target:               SessionCreateTarget,
	/// Reference to the daemon-written, once-consumed startup-prompt file.
	#[serde(default, skip_serializing_if = "Option::is_none")]
	pub startup_prompt_ref:   Option<String>,
}

/// Request to close (hard-kill, history preserved) a session.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionClose {
	/// Correlation id for this control request.
	pub request_id: String,
	/// Telegram update id (idempotency key on the daemon side).
	pub update_id:  i64,
	/// Originating paired chat id.
	pub chat_id:    String,
	/// Control-endpoint token authorizing this frame.
	pub token:      String,
	/// Which session to close.
	pub target:     SessionCloseTarget,
	/// Required force-only close flag; `false` is rejected by daemon policy.
	#[serde(default)]
	pub force:      bool,
}

/// Request to resume a session (reattach if alive, else cold-restart).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionResume {
	/// Correlation id for this control request.
	pub request_id:         String,
	/// Telegram update id (idempotency key on the daemon side).
	pub update_id:          i64,
	/// Originating paired chat id.
	pub chat_id:            String,
	/// Control-endpoint token authorizing this frame.
	pub token:              String,
	/// Which session to resume.
	pub target:             SessionResumeTarget,
	/// Optional follow-up prompt reference for a cold restart.
	#[serde(default, skip_serializing_if = "Option::is_none")]
	pub startup_prompt_ref: Option<String>,
}

/// Lifecycle frames sent from the control client to the ingress.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum LifecycleClientMessage {
	/// Create a new session.
	SessionCreate(SessionCreate),
	/// Close a running session.
	SessionClose(SessionClose),
	/// Resume a session.
	SessionResume(SessionResume),
	/// Forward-compat: an unrecognized frame type. Tolerated, ignored.
	#[serde(other)]
	Unknown,
}

/// Terminal status of a lifecycle request.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum LifecycleStatus {
	/// The request succeeded.
	Ok,
	/// The request failed; see the error frame for the reason.
	Error,
}

/// A connected session's per-session endpoint, returned to the control client.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LifecycleEndpoint {
	/// Full `ws://host:port` URL of the per-session endpoint.
	pub url:   String,
	/// Per-session token for the per-session endpoint.
	pub token: String,
}

/// The Telegram topic/thread a session is surfaced in.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LifecycleTopic {
	/// Paired chat id.
	pub chat_id:   String,
	/// Forum-topic / thread id where the session streams.
	pub thread_id: String,
}

/// How a create request was correlated to its spawned session.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum MatchedBy {
	/// Matched via the preallocated spawn marker echoed in discovery.
	SpawnMarker,
	/// Matched via a replayable `session_ready` frame.
	SessionReady,
}

/// Response to a successful `session_create`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionCreateResponse {
	/// Echoed request correlation id.
	pub request_id:           String,
	/// Terminal status (`ok`).
	pub status:               LifecycleStatus,
	/// Echoed lifecycle marker.
	pub lifecycle_request_id: String,
	/// The authoritative session id of the new session.
	pub session_id:           String,
	/// How the new session was correlated to the request.
	pub matched_by:           MatchedBy,
	/// The new session's per-session endpoint.
	pub endpoint:             LifecycleEndpoint,
	/// The topic the new session is surfaced in.
	pub topic:                LifecycleTopic,
	/// The resolved target (e.g. the actual worktree path).
	pub target:               SessionCreateTarget,
}

/// Response to a successful `session_close`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionCloseResponse {
	/// Echoed request correlation id.
	pub request_id:        String,
	/// Terminal status (`ok`).
	pub status:            LifecycleStatus,
	/// The session id that was closed.
	pub session_id:        String,
	/// Whether the process/tmux session is confirmed gone.
	pub process_gone:      bool,
	/// Whether saved history was preserved (always true for hard-kill).
	pub history_preserved: bool,
	/// Whether the per-session endpoint was marked stale/removed.
	pub endpoint_stale:    bool,
}

/// Whether a resume reattached to a live session or cold-restarted a dead one.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ResumeMode {
	/// The session was alive; the daemon reconnected to its live endpoint.
	Reattached,
	/// The session was dead; the daemon cold-restarted it from history.
	ColdRestarted,
}

/// Response to a successful `session_resume`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionResumeResponse {
	/// Echoed request correlation id.
	pub request_id: String,
	/// Terminal status (`ok`).
	pub status:     LifecycleStatus,
	/// The resumed session id.
	pub session_id: String,
	/// Whether it reattached or cold-restarted.
	pub mode:       ResumeMode,
	/// The (re)connected per-session endpoint.
	pub endpoint:   LifecycleEndpoint,
	/// The topic the session is surfaced in.
	pub topic:      LifecycleTopic,
}

/// Why a lifecycle request failed.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum LifecycleErrorReason {
	/// Missing/wrong control token (handshake or per-frame).
	Unauthorized,
	/// The per-chat create rate limit was exceeded.
	RateLimited,
	/// Same update id seen with a different request body.
	DuplicateConflict,
	/// The target was malformed or otherwise invalid.
	InvalidTarget,
	/// A resume matched more than one candidate (fail closed).
	AmbiguousTarget,
	/// The session failed to spawn.
	SpawnFailed,
	/// Discovery did not surface a matching endpoint in time.
	DiscoveryTimeout,
	/// The endpoint came up but readiness/topic never surfaced in time.
	ReadinessTimeout,
	/// Close refused (not GJC-managed, or id/state-file mismatch).
	CloseRefused,
	/// No matching session was found.
	NotFound,
	/// Side effects may have occurred but success could not be confirmed.
	TerminalUncertain,
	/// This host cannot prove the immutable session identity needed for remote
	/// lifecycle control.
	UnsupportedPlatform,
}

/// A candidate returned with an [`LifecycleErrorReason::AmbiguousTarget`]
/// error.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ResumeCandidate {
	/// Candidate session id.
	pub session_id: String,
	/// Candidate repo/working dir, if known.
	#[serde(default, skip_serializing_if = "Option::is_none")]
	pub path:       Option<String>,
	/// Last-activity epoch-millis (session history file mtime), if known.
	#[serde(default, skip_serializing_if = "Option::is_none")]
	pub mtime_ms:   Option<u64>,
}

/// A structured lifecycle error frame.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionLifecycleError {
	/// Echoed request correlation id (may be empty for pre-parse failures).
	pub request_id: String,
	/// Terminal status (`error`).
	pub status:     LifecycleStatus,
	/// Machine-readable failure reason.
	pub reason:     LifecycleErrorReason,
	/// Human-readable, redaction-safe message.
	pub message:    String,
	/// Candidate sessions for an ambiguous resume.
	#[serde(default, skip_serializing_if = "Vec::is_empty")]
	pub candidates: Vec<ResumeCandidate>,
}

/// Lifecycle frames sent from the ingress back to the control client.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum LifecycleServerMessage {
	/// A create succeeded.
	SessionCreateResponse(SessionCreateResponse),
	/// A close succeeded.
	SessionCloseResponse(SessionCloseResponse),
	/// A resume succeeded.
	SessionResumeResponse(SessionResumeResponse),
	/// A lifecycle request failed.
	SessionLifecycleError(SessionLifecycleError),
	/// Forward-compat: an unrecognized frame type. Tolerated, never emitted.
	#[serde(other)]
	Unknown,
}

impl LifecycleClientMessage {
	/// The control token carried by an authenticated lifecycle request, if any.
	///
	/// Returns `None` for [`LifecycleClientMessage::Unknown`], which carries no
	/// fields and is ignored as a forward-compatible no-op by the ingress.
	#[must_use]
	pub fn token(&self) -> Option<&str> {
		match self {
			Self::SessionCreate(m) => Some(&m.token),
			Self::SessionClose(m) => Some(&m.token),
			Self::SessionResume(m) => Some(&m.token),
			Self::Unknown => None,
		}
	}

	/// The request correlation id, if the frame carries one.
	#[must_use]
	pub fn request_id(&self) -> Option<&str> {
		match self {
			Self::SessionCreate(m) => Some(&m.request_id),
			Self::SessionClose(m) => Some(&m.request_id),
			Self::SessionResume(m) => Some(&m.request_id),
			Self::Unknown => None,
		}
	}

	/// Whether the per-frame `token` matches the control endpoint's token.
	///
	/// Defense-in-depth: the handshake already validates `?token=`, but every
	/// lifecycle frame is re-checked so a forwarded or replayed frame without
	/// the right token is rejected as [`LifecycleErrorReason::Unauthorized`].
	#[must_use]
	pub fn is_authorized(&self, control_token: &str) -> bool {
		self.token().is_some_and(|t| t == control_token)
	}
}

#[cfg(test)]
mod tests {
	use super::*;

	fn round_trip<T>(value: &T) -> T
	where
		T: Serialize + for<'de> Deserialize<'de>,
	{
		let json = serde_json::to_string(value).expect("serialize");
		serde_json::from_str(&json).expect("deserialize")
	}

	#[test]
	fn session_create_existing_path_round_trips() {
		let msg = LifecycleClientMessage::SessionCreate(SessionCreate {
			request_id:           "lc_01".into(),
			lifecycle_request_id: "lc_01".into(),
			intended_session_id:  "sess_pre_01".into(),
			update_id:            100,
			chat_id:              "42".into(),
			token:                "control-token".into(),
			target:               SessionCreateTarget::ExistingPath { path: "/repo".into() },
			startup_prompt_ref:   Some("prompt_lc_01".into()),
		});
		assert_eq!(round_trip(&msg), msg);
	}

	#[test]
	fn create_target_kind_is_snake_case_on_wire() {
		let target =
			SessionCreateTarget::Worktree { repo: "/repo".into(), branch: "feat/x".into() };
		let json = serde_json::to_value(&target).expect("serialize");
		assert_eq!(json["kind"], "worktree");
		assert_eq!(json["repo"], "/repo");
		assert_eq!(json["branch"], "feat/x");
	}

	#[test]
	fn client_message_type_tag_is_snake_case() {
		let msg = LifecycleClientMessage::SessionResume(SessionResume {
			request_id:         "lc_05".into(),
			update_id:          104,
			chat_id:            "42".into(),
			token:              "control-token".into(),
			target:             SessionResumeTarget {
				session_id_or_prefix: "abc".into(),
				path:                 Some("/repo".into()),
			},
			startup_prompt_ref: None,
		});
		let json = serde_json::to_value(&msg).expect("serialize");
		assert_eq!(json["type"], "session_resume");
		// Optional None fields are omitted on the wire.
		assert!(json.get("startupPromptRef").is_none());
	}

	#[test]
	fn create_response_round_trips_with_camel_case() {
		let resp = LifecycleServerMessage::SessionCreateResponse(SessionCreateResponse {
			request_id:           "lc_01".into(),
			status:               LifecycleStatus::Ok,
			lifecycle_request_id: "lc_01".into(),
			session_id:           "sess_pre_01".into(),
			matched_by:           MatchedBy::SpawnMarker,
			endpoint:             LifecycleEndpoint {
				url:   "ws://127.0.0.1:49152".into(),
				token: "session-token".into(),
			},
			topic:                LifecycleTopic { chat_id: "42".into(), thread_id: "99".into() },
			target:               SessionCreateTarget::ExistingPath { path: "/repo".into() },
		});
		let json = serde_json::to_value(&resp).expect("serialize");
		assert_eq!(json["type"], "session_create_response");
		assert_eq!(json["lifecycleRequestId"], "lc_01");
		assert_eq!(json["matchedBy"], "spawn_marker");
		assert_eq!(round_trip(&resp), resp);
	}

	#[test]
	fn ambiguous_resume_error_carries_candidates() {
		let err = LifecycleServerMessage::SessionLifecycleError(SessionLifecycleError {
			request_id: "lc_05".into(),
			status:     LifecycleStatus::Error,
			reason:     LifecycleErrorReason::AmbiguousTarget,
			message:    "Multiple sessions match".into(),
			candidates: vec![ResumeCandidate {
				session_id: "sess-a".into(),
				path:       Some("/repo".into()),
				mtime_ms:   Some(1_710_000_000_000),
			}],
		});
		let json = serde_json::to_value(&err).expect("serialize");
		assert_eq!(json["type"], "session_lifecycle_error");
		assert_eq!(json["reason"], "ambiguous_target");
		assert_eq!(json["candidates"][0]["sessionId"], "sess-a");
		assert_eq!(round_trip(&err), err);
	}

	#[test]
	fn unsupported_platform_lifecycle_error_round_trips() {
		let err = LifecycleServerMessage::SessionLifecycleError(SessionLifecycleError {
			request_id: "lc_psmux".into(),
			status:     LifecycleStatus::Error,
			reason:     LifecycleErrorReason::UnsupportedPlatform,
			message:    "Remote session lifecycle is unavailable on this psmux host because GJC \
			             cannot prove immutable session identity. No lifecycle action was performed. \
			             Use a local GJC terminal with a supported tmux provider."
				.into(),
			candidates: Vec::new(),
		});
		let json = serde_json::to_value(&err).expect("serialize");
		assert_eq!(json["reason"], "unsupported_platform");
		assert_eq!(round_trip(&err), err);
	}

	#[test]
	fn close_response_round_trips() {
		let resp = SessionCloseResponse {
			request_id:        "lc_04".into(),
			status:            LifecycleStatus::Ok,
			session_id:        "sess_pre_01".into(),
			process_gone:      true,
			history_preserved: true,
			endpoint_stale:    true,
		};
		let json = serde_json::to_value(&resp).expect("serialize");
		assert_eq!(json["processGone"], true);
		assert_eq!(json["historyPreserved"], true);
		assert_eq!(round_trip(&resp), resp);
	}

	#[test]
	fn resume_mode_round_trips_snake_case() {
		let resp = SessionResumeResponse {
			request_id: "lc_05".into(),
			status:     LifecycleStatus::Ok,
			session_id: "sess_pre_01".into(),
			mode:       ResumeMode::ColdRestarted,
			endpoint:   LifecycleEndpoint {
				url:   "ws://127.0.0.1:49153".into(),
				token: "session-token".into(),
			},
			topic:      LifecycleTopic { chat_id: "42".into(), thread_id: "99".into() },
		};
		let json = serde_json::to_value(&resp).expect("serialize");
		assert_eq!(json["mode"], "cold_restarted");
		assert_eq!(round_trip(&resp), resp);
	}

	#[test]
	fn unknown_lifecycle_frame_is_tolerated() {
		let msg: LifecycleClientMessage =
			serde_json::from_str(r#"{"type":"session_teleport","foo":1}"#).expect("parse");
		assert_eq!(msg, LifecycleClientMessage::Unknown);
		assert_eq!(msg.token(), None);
		assert!(!msg.is_authorized("control-token"));
	}

	#[test]
	fn per_frame_token_authorization() {
		let msg = LifecycleClientMessage::SessionClose(SessionClose {
			request_id: "lc_04".into(),
			update_id:  103,
			chat_id:    "42".into(),
			token:      "control-token".into(),
			target:     SessionCloseTarget {
				session_id:         "sess_pre_01".into(),
				tmux_session:       Some("gjc-abc".into()),
				session_state_file: None,
			},
			force:      true,
		});
		assert!(msg.is_authorized("control-token"));
		assert!(!msg.is_authorized("wrong-token"));
		assert_eq!(msg.request_id(), Some("lc_04"));
	}
}
