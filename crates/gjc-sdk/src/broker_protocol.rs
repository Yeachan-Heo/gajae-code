//! Agent-level broker request, response, and negotiation frames.

use serde::{Deserialize, Serialize};
use serde_json::Value;

/// Current broker protocol major version.
pub const PROTOCOL_MAJOR: u32 = 3;

/// Broker negotiation preceding every lifecycle operation.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BrokerHello {
	pub protocol_version: u32,
}

/// Global session-index and lifecycle request.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BrokerRequest {
	pub id:              String,
	pub operation:       BrokerOperation,
	pub input:           Value,
	#[serde(default, skip_serializing_if = "Option::is_none")]
	pub idempotency_key: Option<String>,
}

/// The G01--G07 broker operation identifiers.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum BrokerOperation {
	#[serde(rename = "session.list")]
	SessionList,
	#[serde(rename = "session.get_endpoint")]
	SessionGetEndpoint,
	#[serde(rename = "session.create")]
	SessionCreate,
	#[serde(rename = "session.fork")]
	SessionFork,
	#[serde(rename = "session.resume")]
	SessionResume,
	#[serde(rename = "session.close")]
	SessionClose,
	#[serde(rename = "session.delete")]
	SessionDelete,
}

/// Global broker request result.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BrokerResponse {
	pub id:        String,
	pub ok:        bool,
	#[serde(default, skip_serializing_if = "Option::is_none")]
	pub result:    Option<Value>,
	/// `session.list` responses include the index snapshot sequence.
	#[serde(default, skip_serializing_if = "Option::is_none")]
	pub index_seq: Option<u64>,
	#[serde(default, skip_serializing_if = "Option::is_none")]
	pub error:     Option<BrokerError>,
}

/// A broker-level error.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BrokerError {
	pub code:    String,
	pub message: String,
}

/// Frames sent to the broker.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum BrokerClientFrame {
	BrokerHello(BrokerHello),
	BrokerRequest(BrokerRequest),
	#[serde(other)]
	Unknown,
}

/// Frames sent by the broker.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum BrokerServerFrame {
	BrokerResponse(BrokerResponse),
	#[serde(other)]
	Unknown,
}

/// Broker error code strings.
pub mod error_codes {
	pub const ENDPOINT_STALE: &str = "endpoint_stale";
	pub const UNSUPPORTED_PROTOCOL: &str = "unsupported_protocol";
}

#[cfg(test)]
mod tests {
	use serde_json::json;

	use super::*;

	#[test]
	fn hello_round_trips_with_protocol_version() {
		let hello = BrokerClientFrame::BrokerHello(BrokerHello { protocol_version: PROTOCOL_MAJOR });
		let value = serde_json::to_value(&hello).unwrap();
		assert_eq!(value, json!({"type":"broker_hello", "protocolVersion": 3}));
		assert_eq!(serde_json::from_value::<BrokerClientFrame>(value).unwrap(), hello);
	}

	#[test]
	fn broker_request_and_response_round_trip_with_wire_names() {
		let request = BrokerClientFrame::BrokerRequest(BrokerRequest {
			id:              "g1".into(),
			operation:       BrokerOperation::SessionCreate,
			input:           json!({"path":"/repo"}),
			idempotency_key: Some("key".into()),
		});
		let value = serde_json::to_value(&request).unwrap();
		assert_eq!(value["type"], "broker_request");
		assert_eq!(value["operation"], "session.create");
		assert_eq!(value["idempotencyKey"], "key");
		assert_eq!(
			value,
			json!({"type":"broker_request","id":"g1","operation":"session.create","input":{"path":"/repo"},"idempotencyKey":"key"})
		);
		let decoded: BrokerClientFrame = serde_json::from_value(
			json!({"type":"broker_request","id":"g","operation":"session.list","input":{},"future":true}),
		)
		.unwrap();
		assert!(matches!(decoded, BrokerClientFrame::BrokerRequest(_)));

		let response = BrokerServerFrame::BrokerResponse(BrokerResponse {
			id:        "g1".into(),
			ok:        false,
			result:    None,
			index_seq: Some(22),
			error:     Some(BrokerError {
				code:    error_codes::ENDPOINT_STALE.into(),
				message: "endpoint changed".into(),
			}),
		});
		let response_value = serde_json::to_value(&response).unwrap();
		assert_eq!(response_value["indexSeq"], 22);
		assert_eq!(response_value["error"]["code"], "endpoint_stale");
		assert_eq!(
			response_value,
			json!({"type":"broker_response","id":"g1","ok":false,"indexSeq":22,"error":{"code":"endpoint_stale","message":"endpoint changed"}})
		);
		assert_eq!(serde_json::from_value::<BrokerServerFrame>(response_value).unwrap(), response);
	}

	#[test]
	fn unknown_broker_frames_are_tolerated() {
		assert_eq!(
			serde_json::from_value::<BrokerClientFrame>(json!({"type":"future_broker"})).unwrap(),
			BrokerClientFrame::Unknown
		);
		assert_eq!(
			serde_json::from_value::<BrokerServerFrame>(json!({"type":"future_broker"})).unwrap(),
			BrokerServerFrame::Unknown
		);
	}
}
