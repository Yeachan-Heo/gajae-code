//! Directed reverse-RPC provider and lease frames.

use serde::{Deserialize, Serialize};
use serde_json::Value;

pub const LEASE_TTL_SECS: u64 = 15;
pub const HEARTBEAT_SECS: u64 = 5;
pub const MAX_OUTSTANDING_REVERSE: usize = 64;
pub const REVERSE_PAYLOAD_BYTES: usize = 256 * 1024;

/// A host capability that can be leased by one connection per session.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ReverseCapability {
	HostTools,
	HostUri,
	Terminal,
	Filesystem,
	Permission,
	Ui,
}

/// A directed call from the session host to a leased provider.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReverseRequest {
	pub id:            String,
	pub capability:    ReverseCapability,
	pub connection_id: String,
	pub lease_id:      String,
	pub payload:       Value,
}

/// A provider's terminal response to a reverse request.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReverseResponse {
	pub id:            String,
	pub connection_id: String,
	pub lease_id:      String,
	pub ok:            bool,
	#[serde(default, skip_serializing_if = "Option::is_none")]
	pub result:        Option<Value>,
	#[serde(default, skip_serializing_if = "Option::is_none")]
	pub error:         Option<ReverseError>,
}

/// A reverse-RPC error.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReverseError {
	pub code:    String,
	pub message: String,
}

/// Atomically acquire or refresh a provider lease while registering
/// definitions.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RegisterProvider {
	pub id:                String,
	pub connection_id:     String,
	pub capability:        ReverseCapability,
	pub definitions:       Value,
	#[serde(default, skip_serializing_if = "Option::is_none")]
	pub expected_lease_id: Option<String>,
	#[serde(default, skip_serializing_if = "Option::is_none")]
	pub idempotency_key:   Option<String>,
}

/// A successful atomic provider registration.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RegisterProviderResult {
	pub lease_id:         String,
	pub lease_expires_at: String,
	pub registered_names: Vec<String>,
}

/// Refreshes a provider lease owned by a connection.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderHeartbeat {
	pub connection_id: String,
	pub lease_id:      String,
}

/// Releases a provider lease, optionally transferring it to another connection.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LeaseRelease {
	pub connection_id: String,
	pub lease_id:      String,
	#[serde(default, skip_serializing_if = "Option::is_none")]
	pub handoff_to:    Option<String>,
}

/// Current state of one provider lease.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LeaseState {
	pub id:               String,
	pub connection_id:    String,
	pub capability:       ReverseCapability,
	pub lease_id:         String,
	pub lease_expires_at: String,
	pub active:           bool,
}

/// Reverse frames sent by the session host.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum ReverseServerFrame {
	ReverseRequest(ReverseRequest),
	RegisterProviderResult(RegisterProviderResult),
	LeaseState(LeaseState),
	#[serde(other)]
	Unknown,
}

/// Reverse frames sent by a provider connection.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum ReverseClientFrame {
	ReverseResponse(ReverseResponse),
	RegisterProvider(RegisterProvider),
	ProviderHeartbeat(ProviderHeartbeat),
	LeaseRelease(LeaseRelease),
	#[serde(other)]
	Unknown,
}

/// Reverse-provider error code strings.
pub mod error_codes {
	pub const PROVIDER_LEASE_CONFLICT: &str = "provider_lease_conflict";
	pub const LEASE_EXPIRED: &str = "lease_expired";
	pub const NOT_LEASE_OWNER: &str = "not_lease_owner";
}

#[cfg(test)]
mod tests {
	use serde_json::json;

	use super::*;

	#[test]
	fn reverse_request_and_response_round_trip() {
		let request = ReverseServerFrame::ReverseRequest(ReverseRequest {
			id:            "rr1".into(),
			capability:    ReverseCapability::HostTools,
			connection_id: "c1".into(),
			lease_id:      "l1".into(),
			payload:       json!({"name":"tool"}),
		});
		let value = serde_json::to_value(&request).unwrap();
		assert_eq!(value["type"], "reverse_request");
		assert_eq!(value["connectionId"], "c1");
		assert_eq!(value["capability"], "host_tools");
		assert_eq!(serde_json::from_value::<ReverseServerFrame>(value).unwrap(), request);

		let response = ReverseClientFrame::ReverseResponse(ReverseResponse {
			id:            "rr1".into(),
			connection_id: "c1".into(),
			lease_id:      "l1".into(),
			ok:            false,
			result:        None,
			error:         Some(ReverseError {
				code:    error_codes::LEASE_EXPIRED.into(),
				message: "expired".into(),
			}),
		});
		assert_eq!(
			serde_json::from_value::<ReverseClientFrame>(serde_json::to_value(&response).unwrap())
				.unwrap(),
			response
		);
	}

	#[test]
	fn provider_registration_heartbeat_and_release_frames_round_trip_and_tolerate_unknown_fields() {
		let registration = ReverseClientFrame::RegisterProvider(RegisterProvider {
			id:                "p1".into(),
			connection_id:     "c1".into(),
			capability:        ReverseCapability::HostUri,
			definitions:       json!([{"name":"read"}]),
			expected_lease_id: Some("old".into()),
			idempotency_key:   Some("key".into()),
		});
		let value = serde_json::to_value(&registration).unwrap();
		assert_eq!(value["type"], "register_provider");
		assert_eq!(value["expectedLeaseId"], "old");
		assert_eq!(serde_json::from_value::<ReverseClientFrame>(value).unwrap(), registration);

		let heartbeat = ReverseClientFrame::ProviderHeartbeat(ProviderHeartbeat {
			connection_id: "c1".into(),
			lease_id:      "lease1".into(),
		});
		let heartbeat_value = serde_json::to_value(&heartbeat).unwrap();
		assert_eq!(
			heartbeat_value,
			json!({"type":"provider_heartbeat","connectionId":"c1","leaseId":"lease1"})
		);
		assert_eq!(serde_json::from_value::<ReverseClientFrame>(heartbeat_value).unwrap(), heartbeat);

		let release = ReverseClientFrame::LeaseRelease(LeaseRelease {
			connection_id: "c1".into(),
			lease_id:      "lease1".into(),
			handoff_to:    Some("c2".into()),
		});
		let release_value = serde_json::to_value(&release).unwrap();
		assert_eq!(
			release_value,
			json!({"type":"lease_release","connectionId":"c1","leaseId":"lease1","handoffTo":"c2"})
		);
		assert_eq!(serde_json::from_value::<ReverseClientFrame>(release_value).unwrap(), release);
		assert_eq!(
			serde_json::from_value::<ReverseClientFrame>(json!({"type":"future_reverse"})).unwrap(),
			ReverseClientFrame::Unknown
		);

		let state = ReverseServerFrame::LeaseState(LeaseState {
			id:               "l".into(),
			connection_id:    "c".into(),
			capability:       ReverseCapability::Terminal,
			lease_id:         "lease".into(),
			lease_expires_at: "2026-01-01T00:00:15Z".into(),
			active:           true,
		});
		let state_value = serde_json::to_value(&state).unwrap();
		assert_eq!(state_value["type"], "lease_state");
		assert_eq!(state_value["leaseExpiresAt"], "2026-01-01T00:00:15Z");
		assert_eq!(serde_json::from_value::<ReverseServerFrame>(state_value).unwrap(), state);
		let registered = ReverseServerFrame::RegisterProviderResult(RegisterProviderResult {
			lease_id:         "lease".into(),
			lease_expires_at: "2026-01-01T00:00:15Z".into(),
			registered_names: vec!["read".into()],
		});
		let registered_value = serde_json::to_value(&registered).unwrap();
		assert_eq!(registered_value["type"], "register_provider_result");
		assert_eq!(
			serde_json::from_value::<ReverseServerFrame>(registered_value).unwrap(),
			registered
		);
	}

	#[test]
	fn reverse_bounds_are_exposed() {
		assert_eq!(LEASE_TTL_SECS, 15);
		assert_eq!(HEARTBEAT_SECS, 5);
		assert_eq!(MAX_OUTSTANDING_REVERSE, 64);
		assert_eq!(REVERSE_PAYLOAD_BYTES, 256 * 1024);
	}
}
