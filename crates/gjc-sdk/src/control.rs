//! Typed per-session control request and response frames.
//!
//! Fields are camelCase on the wire and frame discriminators are `snake_case`.

use serde::{Deserialize, Serialize};
use serde_json::Value;

/// A typed control invocation against a session operation.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ControlRequest {
	pub id:                String,
	pub operation:         String,
	pub input:             Value,
	#[serde(default, skip_serializing_if = "Option::is_none")]
	pub expected_revision: Option<String>,
	#[serde(default, skip_serializing_if = "Option::is_none")]
	pub idempotency_key:   Option<String>,
	#[serde(default, skip_serializing_if = "Option::is_none")]
	pub confirm:           Option<bool>,
}

/// A control invocation result.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ControlResponse {
	pub id:     String,
	pub ok:     bool,
	#[serde(default, skip_serializing_if = "Option::is_none")]
	pub result: Option<Value>,
	#[serde(default, skip_serializing_if = "Option::is_none")]
	pub error:  Option<ControlError>,
}

/// A structured control failure.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ControlError {
	pub code:             String,
	pub message:          String,
	#[serde(default, skip_serializing_if = "Option::is_none")]
	pub current_revision: Option<String>,
}

/// Control frames sent to a session endpoint.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum ControlClientFrame {
	ControlRequest(ControlRequest),
	/// Forward-compatible unknown frame type; ignored by receivers.
	#[serde(other)]
	Unknown,
}

/// Control frames sent by a session endpoint.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum ControlServerFrame {
	ControlResponse(ControlResponse),
	/// Forward-compatible unknown frame type; ignored by receivers.
	#[serde(other)]
	Unknown,
}

/// Standard control error code strings.
pub mod error_codes {
	pub const REVISION_CONFLICT: &str = "revision_conflict";
	pub const UNKNOWN_OPERATION: &str = "unknown_operation";
	pub const INVALID_INPUT: &str = "invalid_input";
	pub const BUSY: &str = "busy";
	pub const RESOURCE_GONE: &str = "resource_gone";
	pub const UNSUPPORTED_PROTOCOL: &str = "unsupported_protocol";
	pub const TOPIC_REQUIRED: &str = "topic_required";
	pub const ENDPOINT_CREDENTIAL_FORBIDDEN: &str = "endpoint_credential_forbidden";
}

#[cfg(test)]
mod tests {
	use serde_json::json;

	use super::*;

	#[test]
	fn control_frames_round_trip_with_wire_names_and_unknown_fields() {
		let frame = ControlClientFrame::ControlRequest(ControlRequest {
			id:                "r1".into(),
			operation:         "turn.prompt".into(),
			input:             json!({"text": "hi"}),
			expected_revision: Some("rev-1".into()),
			idempotency_key:   Some("key-1".into()),
			confirm:           Some(true),
		});
		let value = serde_json::to_value(&frame).unwrap();
		assert_eq!(value["type"], "control_request");
		assert_eq!(value["expectedRevision"], "rev-1");
		assert_eq!(value["idempotencyKey"], "key-1");
		let decoded: ControlClientFrame = serde_json::from_value(json!({
			"type":"control_request", "id":"r1", "operation":"turn.prompt", "input":{}, "future":true
		}))
		.unwrap();
		assert!(matches!(decoded, ControlClientFrame::ControlRequest(_)));
		let unknown: ControlClientFrame =
			serde_json::from_value(json!({"type":"future_control"})).unwrap();
		assert_eq!(unknown, ControlClientFrame::Unknown);
	}

	#[test]
	fn control_response_round_trips() {
		let frame = ControlServerFrame::ControlResponse(ControlResponse {
			id:     "r1".into(),
			ok:     false,
			result: None,
			error:  Some(ControlError {
				code:             error_codes::REVISION_CONFLICT.into(),
				message:          "changed".into(),
				current_revision: Some("rev-2".into()),
			}),
		});
		let value = serde_json::to_value(&frame).unwrap();
		assert_eq!(value["type"], "control_response");
		assert_eq!(value["error"]["currentRevision"], "rev-2");
		assert_eq!(serde_json::from_value::<ControlServerFrame>(value).unwrap(), frame);
	}
}
