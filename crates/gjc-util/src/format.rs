//! Human-readable formatting helpers. Port of `packages/utils/src/format.ts`.

const SEC: u64 = 1_000;
const MIN: u64 = 60 * SEC;
const HOUR: u64 = 60 * MIN;
const DAY: u64 = 24 * HOUR;

/// Format a duration in milliseconds: `123ms`, `1.5s`, `30m15s`, `2h30m`,
/// `3d2h`.
pub fn format_duration(ms: u64) -> String {
	if ms < SEC {
		return format!("{ms}ms");
	}
	if ms < MIN {
		// Truncate below 60.0s instead of rounding up into the minute branch.
		let tenths = round_below(ms as f64 / 100.0, 600);
		return format!("{:.1}s", tenths as f64 / 10.0);
	}
	if ms < HOUR {
		let mins = ms / MIN;
		let secs = (ms % MIN) / SEC;
		return if secs > 0 {
			format!("{mins}m{secs}s")
		} else {
			format!("{mins}m")
		};
	}
	if ms < DAY {
		let hours = ms / HOUR;
		let mins = (ms % HOUR) / MIN;
		return if mins > 0 {
			format!("{hours}h{mins}m")
		} else {
			format!("{hours}h")
		};
	}
	let days = ms / DAY;
	let hours = (ms % DAY) / HOUR;
	if hours > 0 {
		format!("{days}d{hours}h")
	} else {
		format!("{days}d")
	}
}

/// Format a number compactly: `999`, `1K`, `1.5K`, `25K`, `1M`, `1.5B`.
pub fn format_number(n: u64) -> String {
	if n < 1_000 {
		return n.to_string();
	}
	if n < 10_000 {
		return format!("{}K", trim1(n as f64 / 1_000.0));
	}
	if n < 1_000_000 {
		return format!("{}K", round_below(n as f64 / 1_000.0, 1_000));
	}
	if n < 10_000_000 {
		return format!("{}M", trim1(n as f64 / 1_000_000.0));
	}
	if n < 1_000_000_000 {
		return format!("{}M", round_below(n as f64 / 1_000_000.0, 1_000));
	}
	if n < 10_000_000_000 {
		return format!("{}B", trim1(n as f64 / 1_000_000_000.0));
	}
	format!("{}B", js_round(n as f64 / 1_000_000_000.0))
}

/// Format with up to 1 decimal place, dropping a trailing `.0`.
fn trim1(n: f64) -> String {
	let s = format!("{n:.1}");
	s.strip_suffix(".0")
		.map_or_else(|| s.clone(), ToOwned::to_owned)
}

/// JS `Math.round`: half-away-from-zero for positives (ties round up).
fn js_round(n: f64) -> i64 {
	(n + 0.5).floor() as i64
}

/// Round to an integer without crossing the next compact suffix boundary.
fn round_below(n: f64, next_unit: i64) -> i64 {
	js_round(n).min(next_unit - 1)
}

/// Format a byte count: `512B`, `1.5KB`, `2.3MB`, `1.2GB`.
pub fn format_bytes(bytes: u64) -> String {
	const KB: u64 = 1024;
	const MB: u64 = KB * 1024;
	const GB: u64 = MB * 1024;
	if bytes < KB {
		return format!("{bytes}B");
	}
	if bytes < MB {
		return format!("{}KB", format_byte_unit(bytes, KB, true));
	}
	if bytes < GB {
		return format!("{}MB", format_byte_unit(bytes, MB, true));
	}
	// GB is terminal: no clamp (2 TiB must report "2048.0GB").
	format!("{}GB", format_byte_unit(bytes, GB, false))
}

fn format_byte_unit(bytes: u64, unit: u64, clamp_to_next_unit: bool) -> String {
	let tenths = js_round((bytes as f64 / unit as f64) * 10.0);
	let tenths = if clamp_to_next_unit {
		tenths.min(1024 * 10 - 1)
	} else {
		tenths
	};
	format!("{:.1}", tenths as f64 / 10.0)
}

/// Truncate to `max_len` chars (not bytes), appending an ellipsis if truncated.
pub fn truncate(s: &str, max_len: usize, ellipsis: &str) -> String {
	let char_count = s.chars().count();
	if char_count <= max_len {
		return s.to_owned();
	}
	let slice_len = max_len.saturating_sub(ellipsis.chars().count());
	let cut: String = s.chars().take(slice_len).collect();
	format!("{cut}{ellipsis}")
}

/// `"3 files"`, `"1 error"`.
pub fn format_count(label: &str, count: i64) -> String {
	format!("{count} {}", pluralize(label, count))
}

/// Age in seconds to `"5m ago"` / `"just now"`; `None`/0 → empty string.
pub fn format_age(age_seconds: Option<i64>) -> String {
	let Some(age) = age_seconds else {
		return String::new();
	};
	if age == 0 {
		return String::new();
	}
	let mins = age / 60;
	let hours = mins / 60;
	let days = hours / 24;
	let weeks = days / 7;
	let months = days / 30;
	if months > 0 {
		return format!("{months}mo ago");
	}
	if weeks > 0 {
		return format!("{weeks}w ago");
	}
	if days > 0 {
		return format!("{days}d ago");
	}
	if hours > 0 {
		return format!("{hours}h ago");
	}
	if mins > 0 {
		return format!("{mins}m ago");
	}
	"just now".to_owned()
}

/// English pluralization matching the TS rules.
pub fn pluralize(label: &str, count: i64) -> String {
	if count == 1 {
		return label.to_owned();
	}
	let lower = label.to_lowercase();
	if ["ch", "sh", "s", "x", "z"]
		.iter()
		.any(|suffix| lower.ends_with(suffix))
	{
		return format!("{label}es");
	}
	let mut chars = lower.chars().rev();
	if chars.next() == Some('y') && chars.next().is_some_and(|c| !"aeiou".contains(c)) {
		return format!("{}ies", &label[..label.len() - 1]);
	}
	format!("{label}s")
}

/// Ratio to `"12.3%"`.
pub fn format_percent(ratio: f64) -> String {
	format!("{:.1}%", ratio * 100.0)
}

#[cfg(test)]
mod tests {
	use super::*;

	#[test]
	fn duration() {
		assert_eq!(format_duration(123), "123ms");
		assert_eq!(format_duration(1_500), "1.5s");
		assert_eq!(format_duration(59_999), "59.9s");
		assert_eq!(format_duration(30 * 60 * 1000 + 15_000), "30m15s");
		assert_eq!(format_duration(2 * 3_600_000 + 30 * 60_000), "2h30m");
		assert_eq!(format_duration(3 * 86_400_000 + 2 * 3_600_000), "3d2h");
		assert_eq!(format_duration(60_000), "1m");
	}

	#[test]
	fn number() {
		assert_eq!(format_number(999), "999");
		assert_eq!(format_number(1_000), "1K");
		assert_eq!(format_number(1_500), "1.5K");
		assert_eq!(format_number(25_000), "25K");
		assert_eq!(format_number(999_999), "999K"); // clamped below 1000K
		assert_eq!(format_number(1_000_000), "1M");
		assert_eq!(format_number(1_500_000), "1.5M");
		assert_eq!(format_number(1_500_000_000), "1.5B");
	}

	#[test]
	fn bytes() {
		assert_eq!(format_bytes(512), "512B");
		assert_eq!(format_bytes(1_536), "1.5KB");
		assert_eq!(format_bytes(1_048_570), "1023.9KB"); // clamped
		assert_eq!(format_bytes(2 * 1024 * 1024 * 1024 * 1024), "2048.0GB");
	}

	#[test]
	fn truncation_and_plurals() {
		assert_eq!(truncate("hello", 10, "…"), "hello");
		assert_eq!(truncate("hello world", 8, "…"), "hello w…");
		assert_eq!(pluralize("file", 3), "files");
		assert_eq!(pluralize("file", 1), "file");
		assert_eq!(pluralize("box", 2), "boxes");
		assert_eq!(pluralize("query", 2), "queries");
		assert_eq!(pluralize("day", 2), "days");
		assert_eq!(format_count("error", 1), "1 error");
		assert_eq!(format_count("error", 2), "2 errors");
	}

	#[test]
	fn age_and_percent() {
		assert_eq!(format_age(None), "");
		assert_eq!(format_age(Some(0)), "");
		assert_eq!(format_age(Some(30)), "just now");
		assert_eq!(format_age(Some(90)), "1m ago");
		assert_eq!(format_age(Some(3_700)), "1h ago");
		assert_eq!(format_age(Some(90_000)), "1d ago");
		assert_eq!(format_age(Some(700_000)), "1w ago");
		assert_eq!(format_age(Some(3_000_000)), "1mo ago");
		assert_eq!(format_percent(0.1234), "12.3%");
	}
}
