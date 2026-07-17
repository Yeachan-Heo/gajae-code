//! Typed bounded query and cursor frames.

use std::collections::BTreeMap;

use hmac::{Hmac, Mac};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use sha2::Sha256;

/// Maximum serialized response envelope size.
pub const RESPONSE_CEILING_BYTES: usize = 1024 * 1024;
/// Preferred serialized page size.
pub const TARGET_PAGE_BYTES: usize = 256 * 1024;
/// Maximum serialized request frame size.
pub const REQUEST_FRAME_BYTES: usize = 256 * 1024;
/// Cursor idle lifetime.
pub const CURSOR_TTL_SECS: u64 = 15 * 60;
/// Maximum cursors retained for one connection.
pub const MAX_CURSORS_PER_CONNECTION: usize = 32;
/// Maximum cursors retained for one session.
pub const MAX_CURSORS_PER_SESSION: usize = 128;

/// A typed bounded query invocation.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct QueryRequest {
	pub id:     String,
	pub query:  String,
	pub input:  Value,
	#[serde(default, skip_serializing_if = "Option::is_none")]
	pub cursor: Option<String>,
}

/// A paginated query result.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct QueryPage {
	pub items:               Vec<Value>,
	pub complete:            bool,
	#[serde(default, skip_serializing_if = "Option::is_none")]
	pub continuation_cursor: Option<String>,
	pub revision:            String,
	#[serde(default, skip_serializing_if = "Option::is_none")]
	pub preview:             Option<bool>,
}

/// A query failure.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct QueryError {
	pub code:             String,
	pub message:          String,
	#[serde(default, skip_serializing_if = "Option::is_none")]
	pub current_revision: Option<String>,
}

/// A typed query response.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct QueryResponse {
	pub id:     String,
	pub ok:     bool,
	#[serde(default, skip_serializing_if = "Option::is_none")]
	pub result: Option<Value>,
	#[serde(default, skip_serializing_if = "Option::is_none")]
	pub page:   Option<QueryPage>,
	#[serde(default, skip_serializing_if = "Option::is_none")]
	pub error:  Option<QueryError>,
}

/// The authenticated contents of an opaque continuation cursor.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CursorEnvelope {
	pub cursor_version: u32,
	pub protocol_major: u32,
	pub session_id:     String,
	pub resource:       String,
	pub revision:       String,
	#[serde(default, skip_serializing_if = "Option::is_none")]
	pub high_watermark: Option<Value>,
	pub position:       Value,
	pub direction:      String,
	pub page_shape:     Value,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
struct SignedCursor {
	envelope: CursorEnvelope,
	mac:      String,
}

/// Sign a cursor envelope with the session token and return its opaque
/// encoding.
pub fn sign_cursor(
	envelope: CursorEnvelope,
	session_token: &[u8],
) -> Result<String, serde_json::Error> {
	let mac = cursor_mac(&envelope, session_token)?;
	serde_json::to_string(&SignedCursor { envelope, mac })
}

/// Verify an opaque cursor encoding and return its envelope when its MAC
/// matches.
pub fn verify_cursor(cursor: &str, session_token: &[u8]) -> Option<CursorEnvelope> {
	let signed: SignedCursor = serde_json::from_str(cursor).ok()?;
	let expected = cursor_mac(&signed.envelope, session_token).ok()?;
	constant_time_eq(expected.as_bytes(), signed.mac.as_bytes()).then_some(signed.envelope)
}

/// Produce the hexadecimal HMAC-SHA256 over canonical JSON for an envelope.
pub fn cursor_mac(
	envelope: &CursorEnvelope,
	session_token: &[u8],
) -> Result<String, serde_json::Error> {
	let value = serde_json::to_value(envelope)?;
	let canonical = canonical_json(&value)?;
	let mut mac = Hmac::<Sha256>::new_from_slice(session_token)
		.expect("HMAC-SHA256 accepts session tokens of every length");
	mac.update(canonical.as_bytes());
	Ok(hex_encode(&mac.finalize().into_bytes()))
}

fn canonical_json(value: &Value) -> Result<String, serde_json::Error> {
	fn sort(value: &Value) -> Value {
		match value {
			Value::Array(values) => Value::Array(values.iter().map(sort).collect()),
			Value::Object(values) => {
				let ordered: BTreeMap<_, _> = values
					.iter()
					.map(|(key, value)| (key.clone(), sort(value)))
					.collect();
				let map: Map<String, Value> = ordered.into_iter().collect();
				Value::Object(map)
			},
			_ => value.clone(),
		}
	}
	serde_json::to_string(&sort(value))
}

fn hex_encode(bytes: &[u8]) -> String {
	const HEX: &[u8; 16] = b"0123456789abcdef";
	let mut output = String::with_capacity(bytes.len() * 2);
	for byte in bytes {
		output.push(HEX[(byte >> 4) as usize] as char);
		output.push(HEX[(byte & 0x0f) as usize] as char);
	}
	output
}

fn constant_time_eq(left: &[u8], right: &[u8]) -> bool {
	left.len() == right.len()
		&& left
			.iter()
			.zip(right)
			.fold(0u8, |difference, (left, right)| difference | (left ^ right))
			== 0
}

/// Query frames sent to a session endpoint.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum QueryClientFrame {
	QueryRequest(QueryRequest),
	#[serde(other)]
	Unknown,
}

/// Query frames sent by a session endpoint.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum QueryServerFrame {
	QueryResponse(Box<QueryResponse>),
	#[serde(other)]
	Unknown,
}

#[cfg(test)]
mod tests {
	use serde_json::json;

	use super::*;

	fn envelope() -> CursorEnvelope {
		CursorEnvelope {
			cursor_version: 1,
			protocol_major: 3,
			session_id:     "s1".into(),
			resource:       "transcript".into(),
			revision:       "r1".into(),
			high_watermark: Some(json!(12)),
			position:       json!({"offset": 4}),
			direction:      "forward".into(),
			page_shape:     json!({"limit": 10}),
		}
	}

	#[test]
	fn query_frames_round_trip_with_wire_names_and_unknown_fields() {
		let frame = QueryClientFrame::QueryRequest(QueryRequest {
			id:     "q1".into(),
			query:  "todo.list".into(),
			input:  json!({}),
			cursor: Some("cursor".into()),
		});
		let value = serde_json::to_value(&frame).unwrap();
		assert_eq!(value["type"], "query_request");
		assert_eq!(value["query"], "todo.list");
		let decoded: QueryClientFrame = serde_json::from_value(
			json!({"type":"query_request","id":"q1","query":"todo.list","input":{},"future":true}),
		)
		.unwrap();
		assert!(matches!(decoded, QueryClientFrame::QueryRequest(_)));
		assert_eq!(
			serde_json::from_value::<QueryClientFrame>(json!({"type":"future_query"})).unwrap(),
			QueryClientFrame::Unknown
		);
	}

	#[test]
	fn query_response_round_trips_page() {
		let frame = QueryServerFrame::QueryResponse(Box::new(QueryResponse {
			id:     "q1".into(),
			ok:     true,
			result: None,
			page:   Some(QueryPage {
				items:               vec![json!({"id":"one"})],
				complete:            false,
				continuation_cursor: Some("next".into()),
				revision:            "r1".into(),
				preview:             Some(true),
			}),
			error:  None,
		}));
		let value = serde_json::to_value(&frame).unwrap();
		assert_eq!(value["type"], "query_response");
		assert_eq!(value["page"]["continuationCursor"], "next");
		assert_eq!(serde_json::from_value::<QueryServerFrame>(value).unwrap(), frame);
	}

	#[test]
	fn cursor_mac_signs_verifies_and_rejects_tampering() {
		let signed = sign_cursor(envelope(), b"session-token").unwrap();
		assert_eq!(verify_cursor(&signed, b"session-token"), Some(envelope()));
		assert_eq!(verify_cursor(&signed, b"different-token"), None);
		let tampered = signed.replacen("transcript", "othercript", 1);
		assert_eq!(verify_cursor(&tampered, b"session-token"), None);
	}

	#[test]
	fn bounds_are_exposed_at_contract_values() {
		assert_eq!(RESPONSE_CEILING_BYTES, 1024 * 1024);
		assert_eq!(TARGET_PAGE_BYTES, 256 * 1024);
		assert_eq!(REQUEST_FRAME_BYTES, 256 * 1024);
		assert_eq!(CURSOR_TTL_SECS, 900);
		assert_eq!(MAX_CURSORS_PER_CONNECTION, 32);
		assert_eq!(MAX_CURSORS_PER_SESSION, 128);
	}
}
