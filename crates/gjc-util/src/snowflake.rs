//! Non-distributed snowflake ids. Port of `packages/utils/src/snowflake.ts`.
//!
//! 16-char lowercase-hex values packing `(timestamp - EPOCH) << 22 | seq`
//! with a 22-bit sequence (no machine id; the generator is process-local).

/// Custom epoch (2015-01-01T00:00:00Z, Discord-style).
pub const EPOCH_TIMESTAMP: u64 = 1_420_070_400_000;

/// Maximum 22-bit sequence value.
pub const MAX_SEQUENCE: u32 = 0x3f_ffff;

/// Format a delta-timestamp and sequence into a snowflake hex string.
pub fn format_parts(dt_ms: u64, seq: u32) -> String {
	let value = (dt_ms << 22) | u64::from(seq & MAX_SEQUENCE);
	format!("{value:016x}")
}

/// Validate a snowflake hex string (16 lowercase hex chars).
pub fn valid(value: &str) -> bool {
	value.len() == 16
		&& value
			.bytes()
			.all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

/// Lower boundary snowflake for a unix-ms timestamp.
pub fn lowerbound(timestamp_ms: u64) -> String {
	format_parts(timestamp_ms - EPOCH_TIMESTAMP, 0)
}

/// Upper boundary snowflake for a unix-ms timestamp.
pub fn upperbound(timestamp_ms: u64) -> String {
	format_parts(timestamp_ms - EPOCH_TIMESTAMP, MAX_SEQUENCE)
}

/// Extract the sequence bits.
pub fn get_sequence(value: &str) -> Option<u32> {
	let lo = u32::from_str_radix(value.get(8..16)?, 16).ok()?;
	Some(lo & MAX_SEQUENCE)
}

/// Extract the unix-ms timestamp.
pub fn get_timestamp(value: &str) -> Option<u64> {
	let full = u64::from_str_radix(value, 16).ok()?;
	Some((full >> 22) + EPOCH_TIMESTAMP)
}

/// Sequential generator (process-local; no machine id).
pub struct Source {
	seq: u32,
}

impl Source {
	pub const fn new(sequence: u32) -> Self {
		Self { seq: sequence & MAX_SEQUENCE }
	}

	pub const fn sequence(&self) -> u32 {
		self.seq & MAX_SEQUENCE
	}

	pub const fn reset(&mut self) {
		self.seq = 0;
	}

	/// Generate the next snowflake for a unix-ms timestamp.
	pub const fn generate(&mut self, timestamp_ms: u64) -> u64 {
		let seq = (self.seq + 1) & MAX_SEQUENCE;
		self.seq = seq;
		((timestamp_ms - EPOCH_TIMESTAMP) << 22) | seq as u64
	}

	/// Generate the next snowflake as its canonical hex string.
	pub fn generate_hex(&mut self, timestamp_ms: u64) -> String {
		format!("{:016x}", self.generate(timestamp_ms))
	}
}

#[cfg(test)]
mod tests {
	use super::*;

	#[test]
	fn format_and_parse_round_trip() {
		// Reference: TS formatParts(1_000_000, 42) with the same packing.
		let ts = EPOCH_TIMESTAMP + 1_000_000;
		let hex = format_parts(1_000_000, 42);
		assert_eq!(hex.len(), 16);
		assert!(valid(&hex));
		assert_eq!(get_timestamp(&hex), Some(ts));
		assert_eq!(get_sequence(&hex), Some(42));
	}

	#[test]
	fn bounds_order() {
		let ts = EPOCH_TIMESTAMP + 123_456_789;
		assert!(lowerbound(ts) < upperbound(ts));
		assert_eq!(get_sequence(&lowerbound(ts)), Some(0));
		assert_eq!(get_sequence(&upperbound(ts)), Some(MAX_SEQUENCE));
	}

	#[test]
	fn generator_wraps_sequence() {
		let mut src = Source::new(MAX_SEQUENCE - 1);
		let ts = EPOCH_TIMESTAMP + 5;
		src.generate(ts); // -> MAX_SEQUENCE
		let hex = src.generate_hex(ts); // wraps to 0
		assert_eq!(get_sequence(&hex), Some(0));
		assert_eq!(get_timestamp(&hex), Some(ts));
	}

	#[test]
	fn validation() {
		assert!(valid("0123456789abcdef"));
		assert!(!valid("0123456789ABCDEF"));
		assert!(!valid("xyz"));
		assert!(!valid("0123456789abcde"));
	}
}
