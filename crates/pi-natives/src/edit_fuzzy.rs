use std::collections::HashMap;

use napi::{JsString, bindgen_prelude::*};
use napi_derive::napi;

const FALLBACK_THRESHOLD: f64 = 0.8;
const SEQUENCE_FUZZY_THRESHOLD: f64 = 0.92;
const MAX_RECORDED_MATCHES: usize = 5;

#[napi(object)]
pub struct H01BestFuzzyMatch {
	pub actual_text: String,
	pub start_index: u32,
	pub start_line:  u32,
	pub confidence:  f64,
}

#[napi(object)]
pub struct H01BestFuzzyMatchResult {
	pub best:                  Option<H01BestFuzzyMatch>,
	pub above_threshold_count: u32,
	pub second_best_score:     f64,
}

#[napi(object)]
pub struct H02SequenceFuzzyResult {
	pub index:             Option<u32>,
	pub confidence:        f64,
	pub match_count:       u32,
	pub match_indices:     Vec<u32>,
	pub second_best_score: f64,
}

#[derive(Clone, Copy)]
struct Line<'a> {
	units: &'a [u16],
}

impl Line<'_> {
	fn is_empty_trim(&self) -> bool {
		let mut start = 0;
		let mut end = self.units.len();
		while start < end && is_js_trim_whitespace(self.units[start]) {
			start += 1;
		}
		while end > start && is_js_trim_whitespace(self.units[end - 1]) {
			end -= 1;
		}
		start == end
	}

	fn leading_indent(&self) -> usize {
		let mut count = 0;
		for &unit in self.units {
			if unit == b' ' as u16 || unit == b'\t' as u16 {
				count += 1;
			} else {
				break;
			}
		}
		count
	}

	fn trimmed_bounds(&self) -> (usize, usize) {
		let mut start = 0;
		let mut end = self.units.len();
		while start < end && is_js_trim_whitespace(self.units[start]) {
			start += 1;
		}
		while end > start && is_js_trim_whitespace(self.units[end - 1]) {
			end -= 1;
		}
		(start, end)
	}
}

#[inline]
const fn is_js_trim_whitespace(unit: u16) -> bool {
	matches!(
		unit,
		0x0009 | 0x000a | 0x000b | 0x000c | 0x000d | 0x0020 | 0x00a0 | 0x1680 | 0x2000
			..=0x200a | 0x2028 | 0x2029 | 0x202f | 0x205f | 0x3000 | 0xfeff
	)
}

fn split_lines(units: &[u16]) -> Vec<Line<'_>> {
	let mut lines = Vec::new();
	let mut start = 0;
	for (idx, &unit) in units.iter().enumerate() {
		if unit == b'\n' as u16 {
			lines.push(Line { units: &units[start..idx] });
			start = idx + 1;
		}
	}
	lines.push(Line { units: &units[start..] });
	lines
}

fn line_offsets(lines: &[Line<'_>]) -> Vec<usize> {
	let mut offsets = Vec::with_capacity(lines.len());
	let mut offset = 0;
	for (idx, line) in lines.iter().enumerate() {
		offsets.push(offset);
		offset += line.units.len();
		if idx < lines.len() - 1 {
			offset += 1;
		}
	}
	offsets
}

fn relative_indent_depths(lines: &[Line<'_>]) -> Vec<i32> {
	let indents: Vec<usize> = lines.iter().map(Line::leading_indent).collect();
	let mut non_empty = Vec::new();
	for (idx, line) in lines.iter().enumerate() {
		if !line.is_empty_trim() {
			non_empty.push(indents[idx]);
		}
	}
	let min_indent = non_empty.iter().copied().min().unwrap_or(0);
	let mut indent_unit = usize::MAX;
	for indent in &non_empty {
		let step = indent.saturating_sub(min_indent);
		if step > 0 && step < indent_unit {
			indent_unit = step;
		}
	}
	if indent_unit == usize::MAX {
		indent_unit = 1;
	}
	lines
		.iter()
		.enumerate()
		.map(|(idx, line)| {
			if line.is_empty_trim() || indent_unit == 0 {
				0
			} else {
				((indents[idx].saturating_sub(min_indent) as f64) / (indent_unit as f64)).round() as i32
			}
		})
		.collect()
}

fn push_depth_prefix(out: &mut Vec<u16>, depth: i32, include_depth: bool) {
	if include_depth {
		if depth == 0 {
			out.push(b'0' as u16);
		} else {
			let s = depth.to_string();
			out.extend(s.encode_utf16());
		}
	}
	out.push(b'|' as u16);
}

fn normalize_line(line: Line<'_>, prefix_depth: Option<i32>) -> Vec<u16> {
	let mut out = Vec::with_capacity(line.units.len() + 4);
	if let Some(depth) = prefix_depth {
		push_depth_prefix(&mut out, depth, true);
	} else if prefix_depth.is_none() {
		// no-op; callers that need the no-depth line prefix add it explicitly
	}
	let (start, end) = line.trimmed_bounds();
	let mut pending_space = false;
	for &unit in &line.units[start..end] {
		if unit == b' ' as u16 || unit == b'\t' as u16 {
			pending_space = true;
			continue;
		}
		if pending_space && !out.is_empty() && *out.last().unwrap() != b'|' as u16 {
			out.push(b' ' as u16);
		}
		pending_space = false;
		// Mirror TS normalizeForFuzzy EXACTLY: map only the U+201E/U+201F/«/» and
		// U+201A/U+201B/`/´ and dash classes. TS does NOT map U+201C/U+201D/U+2018/
		// U+2019, and does NOT lowercase.
		let mapped = match unit {
			0x201e | 0x201f | 0x00ab | 0x00bb => b'"' as u16,
			0x201a | 0x201b | 0x0060 | 0x00b4 => b'\'' as u16,
			0x2010 | 0x2011 | 0x2012 | 0x2013 | 0x2014 | 0x2212 => b'-' as u16,
			_ => unit,
		};
		out.push(mapped);
	}
	out
}

fn normalize_block_lines(lines: &[Line<'_>], include_depth: bool) -> Vec<Vec<u16>> {
	let depths = if include_depth {
		Some(relative_indent_depths(lines))
	} else {
		None
	};
	lines
		.iter()
		.enumerate()
		.map(|(idx, &line)| {
			let mut out = Vec::new();
			if include_depth {
				push_depth_prefix(&mut out, depths.as_ref().unwrap()[idx], true);
			} else {
				out.push(b'|' as u16);
			}
			let mut normalized = normalize_line(line, None);
			out.append(&mut normalized);
			out
		})
		.collect()
}

fn normalize_for_fuzzy(line: Line<'_>) -> Vec<u16> {
	normalize_line(line, None)
}

fn levenshtein_dp(a: &[u16], b: &[u16]) -> usize {
	if a == b {
		return 0;
	}
	let a_len = a.len();
	let b_len = b.len();
	if a_len == 0 {
		return b_len;
	}
	if b_len == 0 {
		return a_len;
	}
	let mut prev: Vec<usize> = (0..=b_len).collect();
	let mut curr = vec![0usize; b_len + 1];
	for i in 1..=a_len {
		curr[0] = i;
		let a_code = a[i - 1];
		for j in 1..=b_len {
			let cost = usize::from(a_code != b[j - 1]);
			let deletion = prev[j] + 1;
			let insertion = curr[j - 1] + 1;
			let substitution = prev[j - 1] + cost;
			curr[j] = deletion.min(insertion).min(substitution);
		}
		std::mem::swap(&mut prev, &mut curr);
	}
	prev[b_len]
}

struct MyersPattern {
	units:       Vec<u16>,
	masks:       HashMap<u16, u128>,
	high_bit:    u128,
	active_bits: u128,
}

enum FuzzyPattern {
	Myers(MyersPattern),
	Dp(Vec<u16>),
}

impl FuzzyPattern {
	fn new(units: &[u16]) -> Self {
		if units.is_empty() || units.len() > 128 {
			Self::Dp(units.to_vec())
		} else {
			Self::Myers(MyersPattern::new(units))
		}
	}

	fn similarity(&self, text: &[u16]) -> f64 {
		match self {
			Self::Myers(pattern) => pattern.similarity(text),
			Self::Dp(units) => similarity_dp(units, text),
		}
	}
}

fn similarity_dp(a: &[u16], b: &[u16]) -> f64 {
	if a.is_empty() && b.is_empty() {
		return 1.0;
	}
	let max_len = a.len().max(b.len());
	if max_len == 0 {
		return 1.0;
	}
	let distance = levenshtein_dp(a, b);
	1.0 - (distance as f64) / (max_len as f64)
}

impl MyersPattern {
	fn new(units: &[u16]) -> Self {
		let mut masks = HashMap::with_capacity(units.len().min(64));
		for (idx, &unit) in units.iter().enumerate() {
			*masks.entry(unit).or_insert(0) |= 1u128 << idx;
		}
		let len = units.len();
		if len == 0 {
			return Self { units: Vec::new(), masks, high_bit: 0, active_bits: 0 };
		}
		let active_bits = if len == 128 {
			u128::MAX
		} else {
			(1u128 << len) - 1
		};
		Self { units: units.to_vec(), masks, high_bit: 1u128 << (len - 1), active_bits }
	}

	fn distance(&self, text: &[u16]) -> usize {
		if self.units == text {
			return 0;
		}
		let pattern_len = self.units.len();
		if pattern_len == 0 {
			return text.len();
		}
		if text.is_empty() {
			return pattern_len;
		}
		if pattern_len > 128 {
			return levenshtein_dp(&self.units, text);
		}

		let mut score = pattern_len;
		let mut pv = self.active_bits;
		let mut mv = 0u128;
		for &unit in text {
			let eq = *self.masks.get(&unit).unwrap_or(&0);
			let xv = eq | mv;
			let xh = (((eq & pv).wrapping_add(pv)) ^ pv) | eq;
			let ph = mv | !(xh | pv);
			let mh = pv & xh;
			if (ph & self.high_bit) != 0 {
				score += 1;
			} else if (mh & self.high_bit) != 0 {
				score -= 1;
			}
			let ph = ((ph << 1) | 1) & self.active_bits;
			let mh = (mh << 1) & self.active_bits;
			pv = (mh | !(xv | ph)) & self.active_bits;
			mv = (ph & xv) & self.active_bits;
		}
		score
	}

	fn similarity(&self, text: &[u16]) -> f64 {
		if self.units.is_empty() && text.is_empty() {
			return 1.0;
		}
		let max_len = self.units.len().max(text.len());
		if max_len == 0 {
			return 1.0;
		}
		let distance = self.distance(text);
		1.0 - (distance as f64) / (max_len as f64)
	}
}

fn similarity(a: &[u16], b: &[u16]) -> f64 {
	FuzzyPattern::new(a).similarity(b)
}

fn best_core_one_line(
	content_lines: &[Line<'_>],
	target_norm: &[u16],
	offsets: &[usize],
	threshold: f64,
	include_depth: bool,
) -> H01BestFuzzyMatchResult {
	let target_pattern = FuzzyPattern::new(target_norm);
	let mut best: Option<H01BestFuzzyMatch> = None;
	let mut best_score = -1.0f64;
	let mut second_best_score = -1.0f64;
	let mut above_threshold_count = 0u32;
	for (start, &line) in content_lines.iter().enumerate() {
		let window_norm = if include_depth {
			let mut out = Vec::with_capacity(line.units.len() + 3);
			out.push(b'0' as u16);
			out.push(b'|' as u16);
			out.append(&mut normalize_line(line, None));
			out
		} else {
			let mut out = Vec::with_capacity(line.units.len() + 1);
			out.push(b'|' as u16);
			out.append(&mut normalize_line(line, None));
			out
		};
		let score = target_pattern.similarity(&window_norm);
		if score >= threshold {
			above_threshold_count += 1;
		}
		if score > best_score {
			second_best_score = best_score;
			best_score = score;
			best = Some(H01BestFuzzyMatch {
				actual_text: String::from_utf16_lossy(line.units),
				start_index: offsets[start] as u32,
				start_line:  (start + 1) as u32,
				confidence:  score,
			});
		} else if score > second_best_score {
			second_best_score = score;
		}
	}
	H01BestFuzzyMatchResult { best, above_threshold_count, second_best_score }
}

fn best_core(
	content_lines: &[Line<'_>],
	target_lines: &[Line<'_>],
	offsets: &[usize],
	threshold: f64,
	include_depth: bool,
) -> H01BestFuzzyMatchResult {
	let target_norm = normalize_block_lines(target_lines, include_depth);
	let target_patterns: Vec<FuzzyPattern> = target_norm
		.iter()
		.map(|norm| FuzzyPattern::new(norm))
		.collect();
	let mut best: Option<H01BestFuzzyMatch> = None;
	let mut best_score = -1.0f64;
	let mut second_best_score = -1.0f64;
	let mut above_threshold_count = 0u32;
	for start in 0..=content_lines.len() - target_lines.len() {
		let window = &content_lines[start..start + target_lines.len()];
		let window_norm = normalize_block_lines(window, include_depth);
		let mut score = 0.0f64;
		for i in 0..target_lines.len() {
			score += target_patterns[i].similarity(&window_norm[i]);
		}
		score /= target_lines.len() as f64;
		if score >= threshold {
			above_threshold_count += 1;
		}
		if score > best_score {
			second_best_score = best_score;
			best_score = score;
			let actual_units = join_lines(window);
			best = Some(H01BestFuzzyMatch {
				actual_text: String::from_utf16_lossy(&actual_units),
				start_index: offsets[start] as u32,
				start_line:  (start + 1) as u32,
				confidence:  score,
			});
		} else if score > second_best_score {
			second_best_score = score;
		}
	}
	H01BestFuzzyMatchResult { best, above_threshold_count, second_best_score }
}

fn join_lines(lines: &[Line<'_>]) -> Vec<u16> {
	let mut out = Vec::new();
	for (idx, line) in lines.iter().enumerate() {
		if idx > 0 {
			out.push(b'\n' as u16);
		}
		out.extend_from_slice(line.units);
	}
	out
}

#[napi]
pub fn h01_find_best_fuzzy_match(
	content: JsString,
	target: JsString,
	threshold: f64,
) -> Result<H01BestFuzzyMatchResult> {
	let content_u16 = content.into_utf16()?;
	let target_u16 = target.into_utf16()?;
	let mut content_units = content_u16.as_slice();
	let mut target_units = target_u16.as_slice();
	if content_units.last() == Some(&0) {
		content_units = &content_units[..content_units.len() - 1];
	}
	if target_units.last() == Some(&0) {
		target_units = &target_units[..target_units.len() - 1];
	}
	let content_units = content_units.to_vec();
	let target_units = target_units.to_vec();
	let content_lines = split_lines(&content_units);
	let target_lines = split_lines(&target_units);
	if target_lines.is_empty() || target_units.is_empty() || target_lines.len() > content_lines.len()
	{
		return Ok(H01BestFuzzyMatchResult {
			best:                  None,
			above_threshold_count: 0,
			second_best_score:     0.0,
		});
	}
	let offsets = line_offsets(&content_lines);
	let mut result = if target_lines.len() == 1 {
		let mut target_norm = Vec::new();
		target_norm.push(b'0' as u16);
		target_norm.push(b'|' as u16);
		target_norm.append(&mut normalize_line(target_lines[0], None));
		best_core_one_line(&content_lines, &target_norm, &offsets, threshold, true)
	} else {
		best_core(&content_lines, &target_lines, &offsets, threshold, true)
	};
	if let Some(best) = &result.best
		&& best.confidence < threshold
		&& best.confidence >= FALLBACK_THRESHOLD
	{
		let no_depth = if target_lines.len() == 1 {
			let mut target_norm = Vec::new();
			target_norm.push(b'|' as u16);
			target_norm.append(&mut normalize_line(target_lines[0], None));
			best_core_one_line(&content_lines, &target_norm, &offsets, threshold, false)
		} else {
			best_core(&content_lines, &target_lines, &offsets, threshold, false)
		};
		if let (Some(no_depth_best), Some(current_best)) = (&no_depth.best, &result.best)
			&& no_depth_best.confidence > current_best.confidence
		{
			result = no_depth;
		}
	}
	Ok(result)
}

#[napi]
pub fn h02_score_sequence_fuzzy(
	lines: Vec<String>,
	pattern: Vec<String>,
	start: u32,
	eof: bool,
) -> H02SequenceFuzzyResult {
	let line_units: Vec<Vec<u16>> = lines.iter().map(|s| s.encode_utf16().collect()).collect();
	let pattern_units: Vec<Vec<u16>> = pattern.iter().map(|s| s.encode_utf16().collect()).collect();
	if pattern_units.is_empty() || pattern_units.len() > line_units.len() {
		return H02SequenceFuzzyResult {
			index:             None,
			confidence:        0.0,
			match_count:       0,
			match_indices:     Vec::new(),
			second_best_score: 0.0,
		};
	}
	let max_start = line_units.len() - pattern_units.len();
	let start = start as usize;
	let search_start = if eof && line_units.len() >= pattern_units.len() {
		max_start
	} else {
		start
	};
	let mut best_score = 0.0f64;
	let mut second_best_score = 0.0f64;
	let mut best_index: Option<u32> = None;
	let mut first_match: Option<u32> = None;
	let mut match_count = 0u32;
	let mut match_indices = Vec::new();
	let mut score_range = |from: usize, to: usize| {
		for i in from..=to {
			let mut score = 0.0f64;
			for j in 0..pattern_units.len() {
				let line = Line { units: &line_units[i + j] };
				let pat = Line { units: &pattern_units[j] };
				let line_norm = normalize_for_fuzzy(line);
				let pat_norm = normalize_for_fuzzy(pat);
				score += similarity(&line_norm, &pat_norm);
			}
			score /= pattern_units.len() as f64;
			if score >= SEQUENCE_FUZZY_THRESHOLD {
				if first_match.is_none() {
					first_match = Some(i as u32);
				}
				match_count += 1;
				if match_indices.len() < MAX_RECORDED_MATCHES {
					match_indices.push(i as u32);
				}
			}
			if score > best_score {
				second_best_score = best_score;
				best_score = score;
				best_index = Some(i as u32);
			} else if score > second_best_score {
				second_best_score = score;
			}
		}
	};
	if search_start <= max_start {
		score_range(search_start, max_start);
	}
	if eof && search_start > start {
		score_range(start, search_start - 1);
	}
	H02SequenceFuzzyResult {
		index: best_index,
		confidence: best_score,
		match_count,
		match_indices,
		second_best_score,
	}
}
