//! ANSI-aware text measurement and slicing utilities.
//!
//! Optimized for JS string interop (UTF-16).
//! - Single-pass ANSI scanning (no O(n²) `next_ansi` rescans)
//! - ASCII fast-path (no grapheme segmentation, no UTF-8 conversion)
//! - Non-ASCII uses a reused scratch String for grapheme segmentation
//! - Width checks early-exit
//! - Ellipsis decoded lazily
//! - truncateToWidth returns the original `JsString` when possible

use std::cell::RefCell;

use napi::{JsString, bindgen_prelude::*};
use napi_derive::napi;
use smallvec::{SmallVec, smallvec};
use unicode_segmentation::UnicodeSegmentation;
use unicode_width::UnicodeWidthChar;

const MIN_TAB_WIDTH: u32 = 1;
const MAX_TAB_WIDTH: u32 = 16;
pub const DEFAULT_TAB_WIDTH: usize = 3;
const ESC: u16 = 0x1b;

#[inline]
fn clamp_tab_width_for_ops(width: u32) -> usize {
	width.clamp(MIN_TAB_WIDTH, MAX_TAB_WIDTH) as usize
}

/// Ellipsis strategy for [`truncate_to_width`].
#[derive(Clone, Copy)]
#[napi]
pub enum Ellipsis {
	/// Use a single Unicode ellipsis character ("…").
	Unicode = 0,
	/// Use three ASCII dots ("...").
	Ascii   = 1,
	/// Omit ellipsis entirely.
	Omit    = 2,
}

fn build_utf16_string(mut data: Vec<u16>) -> Utf16String {
	while data.last() == Some(&0) {
		data.pop();
	}
	// SAFETY: we know Utf16String == struct(Vec<u16>)
	unsafe { std::mem::transmute(data) }
}

fn build_utf16_string_preserve_nul(data: Vec<u16>) -> Utf16String {
	// SAFETY: we know Utf16String == struct(Vec<u16>)
	unsafe { std::mem::transmute(data) }
}

// ============================================================================
// Results
// ============================================================================

/// Visible slice of a line after ANSI-aware column selection
/// (`sliceWithWidth`).
#[napi(object)]
pub struct SliceResult {
	/// UTF-16 slice containing the selected text.
	pub text:  Utf16String,
	/// Visible width of the slice in terminal cells.
	pub width: u32,
}

/// Before/after UTF-16 segments around an overlay region, with measured widths.
#[napi(object)]
pub struct ExtractSegmentsResult {
	/// UTF-16 content before the overlay region.
	pub before:       Utf16String,
	/// Visible width of the `before` segment.
	pub before_width: u32,
	/// UTF-16 content after the overlay region.
	pub after:        Utf16String,
	/// Visible width of the `after` segment.
	pub after_width:  u32,
}

// ============================================================================
// ANSI State Tracking - Zero Allocation
// ============================================================================

const ATTR_BOLD: u16 = 1 << 0;
const ATTR_DIM: u16 = 1 << 1;
const ATTR_ITALIC: u16 = 1 << 2;
const ATTR_UNDERLINE: u16 = 1 << 3;
const ATTR_BLINK: u16 = 1 << 4;
const ATTR_INVERSE: u16 = 1 << 6;
const ATTR_HIDDEN: u16 = 1 << 7;
const ATTR_STRIKE: u16 = 1 << 8;

type ColorVal = u32;
const COLOR_NONE: ColorVal = 0;

#[derive(Clone, Copy, Default)]
struct AnsiState {
	attrs: u16,
	fg:    ColorVal,
	bg:    ColorVal,
}

impl AnsiState {
	#[inline]
	const fn new() -> Self {
		Self { attrs: 0, fg: COLOR_NONE, bg: COLOR_NONE }
	}

	#[inline]
	const fn is_empty(&self) -> bool {
		self.attrs == 0 && self.fg == COLOR_NONE && self.bg == COLOR_NONE
	}

	#[inline]
	const fn reset(&mut self) {
		*self = Self::new();
	}

	fn apply_sgr_u16(&mut self, params: &[u16]) {
		if params.is_empty() {
			self.reset();
			return;
		}

		let mut i = 0;
		while i < params.len() {
			let (code, next_i) = parse_sgr_num_u16(params, i);
			i = next_i;

			match code {
				0 => self.reset(),
				1 => self.attrs |= ATTR_BOLD,
				2 => self.attrs |= ATTR_DIM,
				3 => self.attrs |= ATTR_ITALIC,
				4 => self.attrs |= ATTR_UNDERLINE,
				5 => self.attrs |= ATTR_BLINK,
				7 => self.attrs |= ATTR_INVERSE,
				8 => self.attrs |= ATTR_HIDDEN,
				9 => self.attrs |= ATTR_STRIKE,

				21 => self.attrs &= !ATTR_BOLD,
				22 => self.attrs &= !(ATTR_BOLD | ATTR_DIM),
				23 => self.attrs &= !ATTR_ITALIC,
				24 => self.attrs &= !ATTR_UNDERLINE,
				25 => self.attrs &= !ATTR_BLINK,
				27 => self.attrs &= !ATTR_INVERSE,
				28 => self.attrs &= !ATTR_HIDDEN,
				29 => self.attrs &= !ATTR_STRIKE,

				30..=37 => self.fg = (code - 29) as ColorVal,
				39 => self.fg = COLOR_NONE,
				40..=47 => self.bg = (code - 39) as ColorVal,
				49 => self.bg = COLOR_NONE,
				90..=97 => self.fg = (code - 81) as ColorVal,
				100..=107 => self.bg = (code - 91) as ColorVal,

				38 | 48 => {
					let (mode, ni) = parse_sgr_num_u16(params, i);
					i = ni;

					let color = match mode {
						5 => {
							let (idx, ni) = parse_sgr_num_u16(params, i);
							i = ni;
							0x100 | (idx as ColorVal & 0xff)
						},
						2 => {
							let (r, ni) = parse_sgr_num_u16(params, i);
							let (g, ni) = parse_sgr_num_u16(params, ni);
							let (b, ni) = parse_sgr_num_u16(params, ni);
							i = ni;
							0x1000000
								| ((r as ColorVal & 0xff) << 16)
								| ((g as ColorVal & 0xff) << 8)
								| (b as ColorVal & 0xff)
						},
						_ => continue,
					};

					if code == 38 {
						self.fg = color;
					} else {
						self.bg = color;
					}
				},

				_ => {},
			}
		}
	}

	fn write_restore_u16(&self, out: &mut Vec<u16>) {
		if self.is_empty() {
			return;
		}

		out.extend_from_slice(&[ESC, b'[' as u16]);
		let mut first = true;

		macro_rules! push_code {
			($code:expr) => {{
				if !first {
					out.push(b';' as u16);
				}
				first = false;
				write_u32_u16(out, $code);
			}};
		}

		if self.attrs & ATTR_BOLD != 0 {
			push_code!(1);
		}
		if self.attrs & ATTR_DIM != 0 {
			push_code!(2);
		}
		if self.attrs & ATTR_ITALIC != 0 {
			push_code!(3);
		}
		if self.attrs & ATTR_UNDERLINE != 0 {
			push_code!(4);
		}
		if self.attrs & ATTR_BLINK != 0 {
			push_code!(5);
		}
		if self.attrs & ATTR_INVERSE != 0 {
			push_code!(7);
		}
		if self.attrs & ATTR_HIDDEN != 0 {
			push_code!(8);
		}
		if self.attrs & ATTR_STRIKE != 0 {
			push_code!(9);
		}

		write_color_u16(out, self.fg, 38, &mut first);
		write_color_u16(out, self.bg, 48, &mut first);

		out.push(b'm' as u16);
	}
}

#[inline]
fn write_color_u16(out: &mut Vec<u16>, color: ColorVal, base: u32, first: &mut bool) {
	if color == COLOR_NONE {
		return;
	}

	if !*first {
		out.push(b';' as u16);
	}
	*first = false;

	if color < 0x100 {
		let code = if color <= 8 { color + 29 } else { color + 81 };
		let code = if base == 48 { code + 10 } else { code };
		write_u32_u16(out, code);
	} else if color < 0x1000000 {
		write_u32_u16(out, base);
		out.extend_from_slice(&[b';' as u16, b'5' as u16, b';' as u16]);
		write_u32_u16(out, color & 0xff);
	} else {
		write_u32_u16(out, base);
		out.extend_from_slice(&[b';' as u16, b'2' as u16, b';' as u16]);
		write_u32_u16(out, (color >> 16) & 0xff);
		out.push(b';' as u16);
		write_u32_u16(out, (color >> 8) & 0xff);
		out.push(b';' as u16);
		write_u32_u16(out, color & 0xff);
	}
}

#[inline]
fn parse_sgr_num_u16(params: &[u16], mut i: usize) -> (u32, usize) {
	while i < params.len() && params[i] == b';' as u16 {
		i += 1;
	}

	let mut val: u32 = 0;
	while i < params.len() {
		let b = params[i];
		if b == b';' as u16 {
			i += 1;
			break;
		}
		if (b'0' as u16..=b'9' as u16).contains(&b) {
			val = val
				.saturating_mul(10)
				.saturating_add((b - b'0' as u16) as u32);
		}
		i += 1;
	}
	(val, i)
}

#[inline]
fn write_u32_u16(out: &mut Vec<u16>, mut val: u32) {
	if val == 0 {
		out.push(b'0' as u16);
		return;
	}
	let start = out.len();
	while val > 0 {
		out.push(b'0' as u16 + (val % 10) as u16);
		val /= 10;
	}
	out[start..].reverse();
}

// ============================================================================
// ANSI Sequence Detection - UTF-16
// ============================================================================

#[inline]
fn ansi_seq_len_u16(data: &[u16], pos: usize) -> Option<usize> {
	if pos >= data.len() || data[pos] != ESC {
		return None;
	}
	if pos + 1 >= data.len() {
		return None;
	}

	match data[pos + 1] {
		0x5b => {
			// '[' CSI
			for (i, b) in data[pos + 2..].iter().enumerate() {
				if (0x40..=0x7e).contains(b) {
					return Some(i + 3);
				}
			}
			None
		},
		0x5d => {
			// ']' OSC
			for (i, &b) in data[pos + 2..].iter().enumerate() {
				if b == 0x07 {
					return Some(i + 3);
				}
				if b == ESC && data.get(pos + 2 + i + 1) == Some(&0x5c) {
					return Some(i + 4);
				}
			}
			None
		},
		0x50 | 0x58 | 0x5e | 0x5f => {
			// 'P' DCS, 'X' SOS, '^' PM, '_' APC (terminated by ST)
			for (i, &b) in data[pos + 2..].iter().enumerate() {
				if b == ESC && data.get(pos + 2 + i + 1) == Some(&0x5c) {
					return Some(i + 4);
				}
			}
			None
		},
		0x20..=0x2f => {
			// ESC + intermediates + final byte
			for (i, b) in data[pos + 2..].iter().enumerate() {
				if (0x30..=0x7e).contains(b) {
					return Some(i + 3);
				}
			}
			None
		},
		0x40..=0x7e => Some(2),
		_ => None,
	}
}

#[inline]
fn is_sgr_u16(seq: &[u16]) -> bool {
	seq.len() >= 3 && seq[1] == b'[' as u16 && *seq.last().unwrap() == b'm' as u16
}

// ============================================================================
// Grapheme / Width
// ============================================================================

#[inline]
const fn ascii_cell_width_u16(u: u16, tab_width: usize) -> usize {
	let b = u as u8;
	match b {
		b'\t' => tab_width,
		0x20..=0x7e => 1,
		_ => 0,
	}
}

#[inline]
fn char_width_corrected(c: char) -> Option<usize> {
	UnicodeWidthChar::width(c)
}

#[inline]
fn grapheme_width_str(g: &str, tab_width: usize) -> usize {
	if g == "\t" {
		return tab_width;
	}
	let mut it = g.chars();
	let Some(c0) = it.next() else {
		return 0;
	};
	if it.next().is_none() {
		return char_width_corrected(c0).unwrap_or(0);
	}
	if g.contains('\u{200d}') {
		return g
			.chars()
			.filter_map(char_width_corrected)
			.max()
			.unwrap_or(0);
	}
	// Multi-char grapheme: sum per-char widths. Conjoining Hangul jamo are
	// kept in grapheme clusters by unicode-segmentation, and their summed
	// width matches the NFC syllable width terminals render.
	g.chars()
		.map(|c| char_width_corrected(c).unwrap_or(0))
		.sum()
}

thread_local! {
  static SCRATCH: RefCell<String> = const { RefCell::new(String::new()) };
}

/// Iterate graphemes in a non-ASCII UTF-16 segment.
///
/// Callback returns `true` to continue, `false` to stop early.
#[inline]
fn for_each_grapheme_u16_slow<F>(segment: &[u16], tab_width: usize, mut f: F) -> bool
where
	F: FnMut(&[u16], usize) -> bool,
{
	if segment.is_empty() {
		return true;
	}

	SCRATCH.with_borrow_mut(|scratch| {
		scratch.clear();
		scratch.reserve(segment.len());

		for r in std::char::decode_utf16(segment.iter().copied()) {
			scratch.push(r.unwrap_or('\u{FFFD}'));
		}

		let mut utf16_pos = 0usize;
		for g in scratch.graphemes(true) {
			let w = grapheme_width_str(g, tab_width);

			let g_u16_len: usize = g.chars().map(|c| c.len_utf16()).sum();
			let u16_slice = &segment[utf16_pos..utf16_pos + g_u16_len];
			utf16_pos += g_u16_len;

			if !f(u16_slice, w) {
				return false;
			}
		}

		true
	})
}

/// Visible width, with early-exit if width exceeds `limit`.
fn visible_width_u16_up_to(data: &[u16], limit: usize, tab_width: usize) -> (usize, bool) {
	let mut width = 0usize;
	let mut i = 0usize;
	let len = data.len();

	while i < len {
		if data[i] == ESC {
			if let Some(seq_len) = ansi_seq_len_u16(data, i) {
				i += seq_len;
				continue;
			}
			i += 1;
			continue;
		}

		let start = i;
		let mut is_ascii = true;
		while i < len && data[i] != ESC {
			if data[i] > 0x7f {
				is_ascii = false;
			}
			i += 1;
		}
		let seg = &data[start..i];

		if is_ascii {
			for &u in seg {
				width += ascii_cell_width_u16(u, tab_width);
				if width > limit {
					return (width, true);
				}
			}
		} else {
			let ok = for_each_grapheme_u16_slow(seg, tab_width, |_, w| {
				width += w;
				width <= limit
			});
			if !ok {
				return (width, true);
			}
		}
	}

	(width, width > limit)
}

fn visible_width_u16(data: &[u16], tab_width: usize) -> usize {
	visible_width_u16_up_to(data, usize::MAX, tab_width).0
}

// ============================================================================
// wrapTextWithAnsi
// ============================================================================

#[inline]
fn write_active_codes(state: &AnsiState, out: &mut Vec<u16>) {
	if !state.is_empty() {
		state.write_restore_u16(out);
	}
}

#[inline]
fn write_line_end_reset(state: &AnsiState, out: &mut Vec<u16>) {
	let has_underline = state.attrs & ATTR_UNDERLINE != 0;
	let has_strike = state.attrs & ATTR_STRIKE != 0;
	if !has_underline && !has_strike {
		return;
	}

	out.extend_from_slice(&[ESC, b'[' as u16]);
	if has_underline {
		out.extend_from_slice(&[b'2' as u16, b'4' as u16]);
		if has_strike {
			out.push(b';' as u16);
		}
	}
	if has_strike {
		out.extend_from_slice(&[b'2' as u16, b'9' as u16]);
	}
	out.push(b'm' as u16);
}

fn update_state_from_text(data: &[u16], state: &mut AnsiState) {
	let mut i = 0usize;
	while i < data.len() {
		if data[i] == ESC
			&& let Some(seq_len) = ansi_seq_len_u16(data, i)
		{
			let seq = &data[i..i + seq_len];
			if is_sgr_u16(seq) {
				state.apply_sgr_u16(&seq[2..seq_len - 1]);
			}
			i += seq_len;
			continue;
		}
		i += 1;
	}
}

fn token_is_whitespace(token: &[u16]) -> bool {
	let mut i = 0usize;
	while i < token.len() {
		if token[i] == ESC
			&& let Some(seq_len) = ansi_seq_len_u16(token, i)
		{
			i += seq_len;
			continue;
		}
		if token[i] != b' ' as u16 {
			return false;
		}
		i += 1;
	}
	true
}

fn trim_end_spaces_in_place(line: &mut Vec<u16>) {
	while let Some(&last) = line.last() {
		if last == b' ' as u16 {
			line.pop();
		} else {
			break;
		}
	}
}

fn is_escaped_u16(data: &[u16], index: usize) -> bool {
	let mut backslashes = 0usize;
	let mut i = index;
	while i > 0 {
		i -= 1;
		if data[i] != b'\\' as u16 {
			break;
		}
		backslashes += 1;
	}
	backslashes % 2 == 1
}

fn is_adjacent_dollar_u16(data: &[u16], index: usize) -> bool {
	data.get(index.wrapping_sub(1)).copied() == Some(b'$' as u16)
		|| data.get(index + 1).copied() == Some(b'$' as u16)
}

fn inline_math_end(data: &[u16], start: usize) -> Option<usize> {
	if data.get(start).copied() != Some(b'$' as u16)
		|| is_escaped_u16(data, start)
		|| is_adjacent_dollar_u16(data, start)
	{
		return None;
	}

	let mut i = start + 1;
	while i < data.len() {
		let ch = data[i];
		if ch == b'\n' as u16 || ch == b'\r' as u16 {
			return None;
		}
		if ch == b'$' as u16
			&& i > start + 1
			&& !is_escaped_u16(data, i)
			&& !is_adjacent_dollar_u16(data, i)
		{
			return Some(i + 1);
		}
		i += 1;
	}
	None
}

fn split_into_tokens_with_ansi(line: &[u16]) -> SmallVec<[Vec<u16>; 4]> {
	let mut tokens = SmallVec::<[Vec<u16>; 4]>::new();
	let mut current = Vec::<u16>::new();
	let mut pending_ansi = SmallVec::<[u16; 32]>::new();
	let mut in_whitespace = false;
	let mut i = 0usize;

	while i < line.len() {
		if line[i] == ESC
			&& let Some(seq_len) = ansi_seq_len_u16(line, i)
		{
			pending_ansi.extend_from_slice(&line[i..i + seq_len]);
			i += seq_len;
			continue;
		}

		let ch = line[i];
		if ch == b'$' as u16
			&& let Some(math_end) = inline_math_end(line, i)
		{
			if !current.is_empty() {
				tokens.push(current);
				current = Vec::new();
			}
			if !pending_ansi.is_empty() {
				current.extend_from_slice(&pending_ansi);
				pending_ansi.clear();
			}
			current.extend_from_slice(&line[i..math_end]);
			tokens.push(current);
			current = Vec::new();
			in_whitespace = false;
			i = math_end;
			continue;
		}
		let char_is_space = ch == b' ' as u16;
		if char_is_space != in_whitespace && !current.is_empty() {
			tokens.push(current);
			current = Vec::new();
		}

		if !pending_ansi.is_empty() {
			current.extend_from_slice(&pending_ansi);
			pending_ansi.clear();
		}

		in_whitespace = char_is_space;
		current.push(ch);
		i += 1;
	}

	if !pending_ansi.is_empty() {
		current.extend_from_slice(&pending_ansi);
	}

	if !current.is_empty() {
		tokens.push(current);
	}

	tokens
}

fn break_long_word(
	word: &[u16],
	width: usize,
	tab_width: usize,
	state: &mut AnsiState,
) -> SmallVec<[Vec<u16>; 4]> {
	let mut lines = SmallVec::<[Vec<u16>; 4]>::new();
	let mut current_line = Vec::<u16>::new();
	write_active_codes(state, &mut current_line);
	let mut current_width = 0usize;
	let mut i = 0usize;

	while i < word.len() {
		if word[i] == ESC
			&& let Some(seq_len) = ansi_seq_len_u16(word, i)
		{
			let seq = &word[i..i + seq_len];
			current_line.extend_from_slice(seq);
			if is_sgr_u16(seq) {
				state.apply_sgr_u16(&seq[2..seq_len - 1]);
			}
			i += seq_len;
			continue;
		}

		let start = i;
		let mut is_ascii = true;
		while i < word.len() && word[i] != ESC {
			if word[i] > 0x7f {
				is_ascii = false;
			}
			i += 1;
		}
		let seg = &word[start..i];

		if is_ascii {
			for &u in seg {
				let gw = ascii_cell_width_u16(u, tab_width);
				if current_width + gw > width {
					write_line_end_reset(state, &mut current_line);
					lines.push(current_line);
					current_line = Vec::new();
					write_active_codes(state, &mut current_line);
					current_width = 0;
				}
				current_line.push(u);
				current_width += gw;
			}
		} else {
			let _ = for_each_grapheme_u16_slow(seg, tab_width, |gu16, gw| {
				if current_width + gw > width {
					write_line_end_reset(state, &mut current_line);
					lines.push(std::mem::take(&mut current_line));
					write_active_codes(state, &mut current_line);
					current_width = 0;
				}
				current_line.extend_from_slice(gu16);
				current_width += gw;
				true
			});
		}
	}

	if !current_line.is_empty() {
		lines.push(current_line);
	}

	lines
}

fn wrap_single_line(line: &[u16], width: usize, tab_width: usize) -> SmallVec<[Vec<u16>; 4]> {
	if line.is_empty() {
		return smallvec![Vec::new()];
	}

	if visible_width_u16(line, tab_width) <= width {
		return smallvec![line.to_vec()];
	}

	let tokens = split_into_tokens_with_ansi(line);
	let mut wrapped = SmallVec::<[Vec<u16>; 4]>::new();
	let mut current_line = Vec::<u16>::new();
	let mut current_width = 0usize;
	let mut state = AnsiState::new();

	for token in tokens {
		let token_width = visible_width_u16(&token, tab_width);
		let is_whitespace = token_is_whitespace(&token);

		if token_width > width && !is_whitespace {
			if !current_line.is_empty() {
				write_line_end_reset(&state, &mut current_line);
				wrapped.push(current_line);
				current_line = Vec::new();
				current_width = 0;
			}

			let mut broken = break_long_word(&token, width, tab_width, &mut state);
			if let Some(last) = broken.pop() {
				wrapped.extend(broken);
				current_line = last;
				current_width = visible_width_u16(&current_line, tab_width);
			}
			continue;
		}

		let total_needed = current_width + token_width;
		if total_needed > width && current_width > 0 {
			let mut line_to_wrap = current_line;
			trim_end_spaces_in_place(&mut line_to_wrap);
			write_line_end_reset(&state, &mut line_to_wrap);
			wrapped.push(line_to_wrap);

			current_line = Vec::new();
			write_active_codes(&state, &mut current_line);
			if is_whitespace {
				current_width = 0;
			} else {
				current_line.extend_from_slice(&token);
				current_width = token_width;
			}
		} else {
			current_line.extend_from_slice(&token);
			current_width += token_width;
		}

		update_state_from_text(&token, &mut state);
	}

	if !current_line.is_empty() {
		wrapped.push(current_line);
	}

	for line in &mut wrapped {
		trim_end_spaces_in_place(line);
	}

	if wrapped.is_empty() {
		wrapped.push(Vec::new());
	}

	wrapped
}

fn wrap_text_with_ansi_impl(
	text: &[u16],
	width: usize,
	tab_width: usize,
) -> SmallVec<[Vec<u16>; 4]> {
	if text.is_empty() {
		return smallvec![Vec::new()];
	}

	let mut result = SmallVec::<[Vec<u16>; 4]>::new();
	let mut state = AnsiState::new();
	let mut line_start = 0usize;

	for i in 0..=text.len() {
		if i == text.len() || text[i] == b'\n' as u16 {
			let line = &text[line_start..i];
			let mut line_with_prefix: Vec<u16> = Vec::new();
			if !result.is_empty() {
				write_active_codes(&state, &mut line_with_prefix);
			}
			line_with_prefix.extend_from_slice(line);

			let wrapped = wrap_single_line(&line_with_prefix, width, tab_width);
			result.extend(wrapped);
			update_state_from_text(line, &mut state);
			line_start = i + 1;
		}
	}

	if result.is_empty() {
		result.push(Vec::new());
	}

	result
}

/// Wrap text to a visible width, preserving ANSI escape codes across line
/// breaks.
///
/// Returns UTF-16 lines with active SGR codes carried across line boundaries.
#[napi]
pub fn wrap_text_with_ansi(text: JsString, width: u32, tab_width: u32) -> Result<Vec<Utf16String>> {
	let text_u16 = text.into_utf16()?;
	let tab_width = clamp_tab_width_for_ops(tab_width);
	let lines = wrap_text_with_ansi_impl(text_u16.as_slice(), width as usize, tab_width);
	Ok(lines.into_iter().map(build_utf16_string).collect())
}

// ============================================================================
// truncateToWidth
// ============================================================================

/// Truncate text to a visible width, preserving ANSI codes.
///
/// Pads with spaces when requested.
fn truncate_to_width_u16_impl(
	text: &[u16],
	max_width: usize,
	ellipsis_kind: Ellipsis,
	pad: bool,
	tab_width: usize,
) -> Vec<u16> {
	let (text_w, exceeded) = visible_width_u16_up_to(text, max_width, tab_width);
	if !exceeded {
		let mut out = Vec::with_capacity(text.len() + max_width.saturating_sub(text_w));
		out.extend_from_slice(text);
		if pad && text_w < max_width {
			out.resize(out.len() + (max_width - text_w), b' ' as u16);
		}
		return out;
	}

	const ELLIPSIS_UNICODE: &[u16] = &[0x2026];
	const ELLIPSIS_ASCII: &[u16] = &[0x2e, 0x2e, 0x2e];
	const ELLIPSIS_OMIT: &[u16] = &[];

	let (ellipsis, ellipsis_w): (&[u16], usize) = match ellipsis_kind {
		Ellipsis::Unicode => (ELLIPSIS_UNICODE, 1),
		Ellipsis::Ascii => (ELLIPSIS_ASCII, 3),
		Ellipsis::Omit => (ELLIPSIS_OMIT, 0),
	};

	let target_w = max_width.saturating_sub(ellipsis_w);
	if target_w == 0 {
		let mut out = Vec::with_capacity(ellipsis.len().min(max_width * 2));
		let mut w = 0usize;
		let _ = for_each_grapheme_u16_slow(ellipsis, tab_width, |gu16, gw| {
			if w + gw > max_width {
				return false;
			}
			out.extend_from_slice(gu16);
			w += gw;
			true
		});

		if pad && w < max_width {
			out.resize(out.len() + (max_width - w), b' ' as u16);
		}
		return out;
	}

	let mut out = Vec::with_capacity(text.len().min(max_width * 2) + ellipsis.len() + 8);
	let mut w = 0usize;
	let mut i = 0usize;
	let text_len = text.len();
	let mut saw_sgr = false;

	while i < text_len {
		if text[i] == ESC {
			if let Some(seq_len) = ansi_seq_len_u16(text, i) {
				let seq = &text[i..i + seq_len];
				out.extend_from_slice(seq);
				if is_sgr_u16(seq) {
					saw_sgr = true;
				}
				i += seq_len;
				continue;
			}
			out.push(ESC);
			i += 1;
			continue;
		}

		let start = i;
		let mut is_ascii = true;
		while i < text_len && text[i] != ESC {
			if text[i] > 0x7f {
				is_ascii = false;
			}
			i += 1;
		}
		let seg = &text[start..i];

		if is_ascii {
			for &u in seg {
				let gw = ascii_cell_width_u16(u, tab_width);
				if w + gw > target_w {
					break;
				}
				out.push(u);
				w += gw;
			}
			if w >= target_w {
				break;
			}
		} else {
			let keep_going = for_each_grapheme_u16_slow(seg, tab_width, |gu16, gw| {
				if w + gw > target_w {
					return false;
				}
				out.extend_from_slice(gu16);
				w += gw;
				true
			});
			if !keep_going {
				break;
			}
		}
	}

	if saw_sgr {
		out.extend_from_slice(&[ESC, b'[' as u16, b'0' as u16, b'm' as u16]);
	}
	out.extend_from_slice(ellipsis);

	if pad {
		let out_w = w + ellipsis_w;
		if out_w < max_width {
			out.resize(out.len() + (max_width - out_w), b' ' as u16);
		}
	}

	out
}

#[napi]
pub fn truncate_to_width(
	text: JsString<'_>,
	max_width: u32,
	ellipsis_kind: Option<Ellipsis>,
	pad: Option<bool>,
	tab_width: u32,
) -> Result<Either<JsString<'_>, Utf16String>> {
	let max_width = max_width as usize;
	let ellipsis_kind = ellipsis_kind.unwrap_or(Ellipsis::Unicode);
	let pad = pad.unwrap_or(false);
	let tab_width = clamp_tab_width_for_ops(tab_width);

	// Keep original handle so we can return it without allocating.
	let original = text;

	let text_u16 = text.into_utf16()?;
	let text = text_u16.as_slice();

	let (text_w, exceeded) = visible_width_u16_up_to(text, max_width, tab_width);
	if !exceeded && !pad {
		return Ok(Either::A(original));
	}
	if !exceeded && text_w == max_width {
		return Ok(Either::A(original));
	}

	Ok(Either::B(build_utf16_string(truncate_to_width_u16_impl(
		text,
		max_width,
		ellipsis_kind,
		pad,
		tab_width,
	))))
}

/// Truncate many strings to a visible width, preserving ANSI codes.
#[napi]
pub fn truncate_lines_to_width(
	lines: Vec<JsString>,
	max_width: u32,
	ellipsis_kind: Option<Ellipsis>,
	pad: Option<bool>,
	tab_width: u32,
) -> Result<Vec<Utf16String>> {
	let max_width = max_width as usize;
	let ellipsis_kind = ellipsis_kind.unwrap_or(Ellipsis::Unicode);
	let pad = pad.unwrap_or(false);
	let tab_width = clamp_tab_width_for_ops(tab_width);
	let mut out = Vec::with_capacity(lines.len());
	for line in lines {
		let original = line.into_utf16()?;
		let text = original.as_slice();

		let (text_w, exceeded) = visible_width_u16_up_to(text, max_width, tab_width);
		if !exceeded && (!pad || text_w == max_width) {
			let mut data = text.to_vec();
			if data.last() == Some(&0) {
				data.pop();
			}
			out.push(build_utf16_string_preserve_nul(data));
			continue;
		}

		out.push(build_utf16_string_preserve_nul(truncate_to_width_u16_impl(
			text,
			max_width,
			ellipsis_kind,
			pad,
			tab_width,
		)));
	}
	Ok(out)
}

// ============================================================================
// sliceWithWidth
// ============================================================================

fn slice_with_width_impl(
	line: &[u16],
	start_col: usize,
	length: usize,
	strict: bool,
	tab_width: usize,
) -> (Vec<u16>, usize) {
	let end_col = start_col.saturating_add(length);

	let mut out = Vec::with_capacity(length * 2);
	let mut out_w = 0usize;

	let mut current_col = 0usize;
	let mut i = 0usize;
	let line_len = line.len();

	// Store pending ANSI ranges (pos, len) to avoid copying until needed
	let mut pending_ansi: SmallVec<[(usize, usize); 4]> = SmallVec::new();

	while i < line_len && current_col < end_col {
		if line[i] == ESC {
			if let Some(seq_len) = ansi_seq_len_u16(line, i) {
				if current_col >= start_col {
					out.extend_from_slice(&line[i..i + seq_len]);
				} else {
					pending_ansi.push((i, seq_len));
				}
				i += seq_len;
				continue;
			}
			if current_col >= start_col {
				out.push(ESC);
			}
			i += 1;
			continue;
		}

		let start = i;
		let mut is_ascii = true;
		while i < line_len && line[i] != ESC {
			if line[i] > 0x7f {
				is_ascii = false;
			}
			i += 1;
		}
		let seg = &line[start..i];

		if is_ascii {
			for &u in seg {
				if current_col >= end_col {
					break;
				}
				let gw = ascii_cell_width_u16(u, tab_width);
				let in_range = current_col >= start_col;
				let fits = !strict || current_col + gw <= end_col;

				if in_range && fits {
					if !pending_ansi.is_empty() {
						for &(p, l) in &pending_ansi {
							out.extend_from_slice(&line[p..p + l]);
						}
						pending_ansi.clear();
					}
					out.push(u);
					out_w += gw;
				}
				current_col += gw;
			}
		} else {
			let _ = for_each_grapheme_u16_slow(seg, tab_width, |gu16, gw| {
				if current_col >= end_col {
					return false;
				}

				let in_range = current_col >= start_col;
				let fits = !strict || current_col + gw <= end_col;

				if in_range && fits {
					if !pending_ansi.is_empty() {
						for &(p, l) in &pending_ansi {
							out.extend_from_slice(&line[p..p + l]);
						}
						pending_ansi.clear();
					}
					out.extend_from_slice(gu16);
					out_w += gw;
				}

				current_col += gw;
				current_col < end_col
			});
		}
	}

	// Include trailing ANSI sequences (e.g., reset codes) that immediately follow
	while i < line.len() {
		if line[i] == ESC
			&& let Some(len) = ansi_seq_len_u16(line, i)
		{
			out.extend_from_slice(&line[i..i + len]);
			i += len;
			continue;
		}
		break;
	}

	(out, out_w)
}

/// Slice a range of visible columns from a line.
///
/// Counts terminal cells, skipping ANSI escapes, and optionally enforces strict
/// width.
#[napi]
pub fn slice_with_width(
	line: JsString,
	start_col: u32,
	length: u32,
	strict: Option<bool>,
	tab_width: u32,
) -> Result<SliceResult> {
	let line_u16 = line.into_utf16()?;
	let line = line_u16.as_slice();
	let strict = strict.unwrap_or(false);

	if length == 0 {
		return Ok(SliceResult { text: build_utf16_string(vec![]), width: 0 });
	}

	let tab_width = clamp_tab_width_for_ops(tab_width);
	let (out, w) =
		slice_with_width_impl(line, start_col as usize, length as usize, strict, tab_width);

	Ok(SliceResult { text: build_utf16_string(out), width: crate::utils::clamp_u32(w as u64) })
}

// ============================================================================
// extractSegments
// ============================================================================

fn extract_segments_impl(
	line: &[u16],
	before_end: usize,
	after_start: usize,
	after_len: usize,
	strict_after: bool,
	tab_width: usize,
) -> (Vec<u16>, usize, Vec<u16>, usize) {
	let after_end = after_start.saturating_add(after_len);

	let mut before = Vec::with_capacity(before_end * 2);
	let mut before_w = 0usize;

	let mut after = Vec::with_capacity(after_len * 2);
	let mut after_w = 0usize;

	let mut current_col = 0usize;
	let mut i = 0usize;
	let line_len = line.len();

	// Store pending ANSI ranges for "before"
	let mut pending_before_ansi: SmallVec<[(usize, usize); 4]> = SmallVec::new();

	let mut after_started = false;
	let mut state = AnsiState::new();

	let done_col = if after_len == 0 {
		before_end
	} else {
		after_end
	};

	while i < line_len && current_col < done_col {
		if line[i] == ESC {
			if let Some(seq_len) = ansi_seq_len_u16(line, i) {
				let seq = &line[i..i + seq_len];
				if is_sgr_u16(seq) {
					state.apply_sgr_u16(&seq[2..seq_len - 1]);
				}

				if current_col < before_end {
					pending_before_ansi.push((i, seq_len));
				} else if current_col >= after_start && current_col < after_end && after_started {
					after.extend_from_slice(seq);
				}

				i += seq_len;
				continue;
			}

			if current_col < before_end {
				before.push(ESC);
			} else if current_col >= after_start && current_col < after_end && after_started {
				after.push(ESC);
			}
			i += 1;
			continue;
		}

		let start = i;
		let mut is_ascii = true;
		while i < line_len && line[i] != ESC {
			if line[i] > 0x7f {
				is_ascii = false;
			}
			i += 1;
		}
		let seg = &line[start..i];

		if is_ascii {
			for &u in seg {
				if current_col >= done_col {
					break;
				}
				let gw = ascii_cell_width_u16(u, tab_width);

				if current_col < before_end {
					if !pending_before_ansi.is_empty() {
						for &(p, l) in &pending_before_ansi {
							before.extend_from_slice(&line[p..p + l]);
						}
						pending_before_ansi.clear();
					}
					before.push(u);
					before_w += gw;
				} else if current_col >= after_start && current_col < after_end {
					let fits = !strict_after || current_col + gw <= after_end;
					if fits {
						if !after_started {
							state.write_restore_u16(&mut after);
							after_started = true;
						}
						after.push(u);
						after_w += gw;
					}
				}
				current_col += gw;
			}
		} else {
			let _ = for_each_grapheme_u16_slow(seg, tab_width, |gu16, gw| {
				if current_col >= done_col {
					return false;
				}

				if current_col < before_end {
					if !pending_before_ansi.is_empty() {
						for &(p, l) in &pending_before_ansi {
							before.extend_from_slice(&line[p..p + l]);
						}
						pending_before_ansi.clear();
					}
					before.extend_from_slice(gu16);
					before_w += gw;
				} else if current_col >= after_start && current_col < after_end {
					let fits = !strict_after || current_col + gw <= after_end;
					if fits {
						if !after_started {
							state.write_restore_u16(&mut after);
							after_started = true;
						}
						after.extend_from_slice(gu16);
						after_w += gw;
					}
				}

				current_col += gw;
				true
			});
		}
	}

	(before, before_w, after, after_w)
}

/// Extract the before/after slices around an overlay region.
///
/// Preserves ANSI state so the `after` segment renders correctly after
/// truncation.
#[napi]
pub fn extract_segments(
	line: JsString,
	before_end: u32,
	after_start: u32,
	after_len: u32,
	strict_after: bool,
	tab_width: u32,
) -> Result<ExtractSegmentsResult> {
	let line_u16 = line.into_utf16()?;
	let line = line_u16.as_slice();

	let tab_width = clamp_tab_width_for_ops(tab_width);
	let (before, bw, after, aw) = extract_segments_impl(
		line,
		before_end as usize,
		after_start as usize,
		after_len as usize,
		strict_after,
		tab_width,
	);

	Ok(ExtractSegmentsResult {
		before:       build_utf16_string(before),
		before_width: crate::utils::clamp_u32(bw as u64),
		after:        build_utf16_string(after),
		after_width:  crate::utils::clamp_u32(aw as u64),
	})
}

// ============================================================================
// visibleWidth
// ============================================================================

/// Calculate visible width of text, excluding ANSI escape sequences.
///
/// Tabs count as a fixed-width cell.
#[napi]
pub fn visible_width(text: JsString, tab_width: u32) -> Result<u32> {
	let text_u16 = text.into_utf16()?;
	let tab_width = clamp_tab_width_for_ops(tab_width);
	Ok(crate::utils::clamp_u32(visible_width_u16(text_u16.as_slice(), tab_width) as u64))
}

/// Calculate visible widths of many strings, excluding ANSI escape sequences.
#[napi]
pub fn visible_widths(lines: Vec<String>, tab_width: u32) -> Vec<u32> {
	let tab_width = clamp_tab_width_for_ops(tab_width);
	lines
		.into_iter()
		.map(|line| {
			let text: Vec<u16> = line.encode_utf16().collect();
			crate::utils::clamp_u32(visible_width_u16(&text, tab_width) as u64)
		})
		.collect()
}
#[cfg(test)]
mod tests {
	use super::*;

	fn to_u16(s: &str) -> Vec<u16> {
		s.encode_utf16().collect()
	}

	fn truncate_string_for_test(s: &str, width: usize) -> String {
		String::from_utf16_lossy(&truncate_to_width_u16_impl(
			&to_u16(s),
			width,
			Ellipsis::Omit,
			false,
			DEFAULT_TAB_WIDTH,
		))
	}

	#[test]
	fn test_visible_width() {
		assert_eq!(visible_width_u16(&to_u16("hello"), DEFAULT_TAB_WIDTH), 5);
		assert_eq!(visible_width_u16(&to_u16("\x1b[31mhello\x1b[0m"), DEFAULT_TAB_WIDTH), 5);
		assert_eq!(visible_width_u16(&to_u16("\x1b[38;5;196mred\x1b[0m"), DEFAULT_TAB_WIDTH), 3);
		assert_eq!(visible_width_u16(&to_u16("a\tb"), DEFAULT_TAB_WIDTH), 1 + DEFAULT_TAB_WIDTH + 1);
		assert_eq!(visible_width_u16(&to_u16("👨‍👩‍👧‍👦"), DEFAULT_TAB_WIDTH), 2);
		assert_eq!(visible_width_u16(&to_u16("abcd👨‍👩‍👧‍👦wxyz"), DEFAULT_TAB_WIDTH), 10);
	}

	#[test]
	fn test_batch_internal_parity_cases() {
		let cases = [
			("", 0),
			("plain ascii", 11),
			("a\tb", 5),
			("\x1b[31mred\x1b[0m", 3),
			("한글 jamo 한", 12),
			("ไทยคำลาวຄໍາ", 10),
		];
		for (case, expected_width) in cases {
			let u16 = to_u16(case);
			assert_eq!(visible_width_u16(&u16, DEFAULT_TAB_WIDTH), expected_width);
			assert_eq!(
				truncate_to_width_u16_impl(&u16, 8, Ellipsis::Omit, false, DEFAULT_TAB_WIDTH),
				truncate_to_width_u16_impl(&u16, 8, Ellipsis::Omit, false, DEFAULT_TAB_WIDTH),
			);
		}
		assert_eq!(truncate_string_for_test("\x1b[31mred text\x1b[0m", 5), "\x1b[31mred t\x1b[0m");
		assert_eq!(truncate_string_for_test("abcd👨‍👩‍👧‍👦wxyzz", 10), "abcd👨‍👩‍👧‍👦wxyz");
	}

	#[test]
	fn test_ansi_detection() {
		let data = to_u16("\x1b[31mred\x1b[0m");
		assert_eq!(ansi_seq_len_u16(&data, 0), Some(5)); // \x1b[31m
		assert_eq!(ansi_seq_len_u16(&data, 8), Some(4)); // \x1b[0m
	}

	#[test]
	fn test_slice_basic() {
		let data = to_u16("hello world");
		let (out, width) = slice_with_width_impl(&data, 0, 5, false, DEFAULT_TAB_WIDTH);
		assert_eq!(String::from_utf16_lossy(&out), "hello");
		assert_eq!(width, 5);
	}

	#[test]
	fn test_slice_with_ansi() {
		let data = to_u16("\x1b[31mhello\x1b[0m world");
		let (out, width) = slice_with_width_impl(&data, 0, 5, false, DEFAULT_TAB_WIDTH);
		assert_eq!(String::from_utf16_lossy(&out), "\x1b[31mhello\x1b[0m");
		assert_eq!(width, 5);
	}

	#[test]
	fn test_ascii_fast_path() {
		fn is_ascii(seg: &[u16]) -> bool {
			seg.iter().all(|&u| u <= 0x7f)
		}

		let ascii = to_u16("hello world 12345");
		assert!(is_ascii(&ascii));

		let non_ascii = to_u16("hello 世界");
		assert!(!is_ascii(&non_ascii));
	}

	#[test]
	fn test_early_exit() {
		let data = to_u16(&"a]b".repeat(1000));
		let (w, exceeded) = visible_width_u16_up_to(&data, 10, DEFAULT_TAB_WIDTH);
		assert!(exceeded);
		assert!(w > 10);
	}

	#[test]
	fn test_wrap_text_with_ansi_preserves_color() {
		let data = to_u16("\x1b[38;2;156;163;176mhello world\x1b[0m");
		let lines = wrap_text_with_ansi_impl(&data, 5, DEFAULT_TAB_WIDTH);
		assert_eq!(lines.len(), 2);
		let first = String::from_utf16_lossy(&lines[0]);
		let second = String::from_utf16_lossy(&lines[1]);
		assert!(first.starts_with("\x1b[38;2;156;163;176m"));
		assert!(second.starts_with("\x1b[38;2;156;163;176m"));
		assert!(second.contains("world"));
	}

	#[test]
	fn test_wrap_text_with_ansi_resets_strike_without_resetting_colors() {
		let data =
			to_u16("\x1b[38;5;196m\x1b[48;5;236m\x1b[9mstrikethrough content wraps\x1b[29m\x1b[0m");
		let lines = wrap_text_with_ansi_impl(&data, 12, DEFAULT_TAB_WIDTH);
		assert!(lines.len() > 1);

		for line in &lines[..lines.len() - 1] {
			let line_text = String::from_utf16_lossy(line);
			if line_text.contains("\x1b[9m") {
				assert!(line_text.ends_with("\x1b[29m"));
				assert!(!line_text.ends_with("\x1b[0m"));
			}
		}

		for line in &lines[1..] {
			let line_text = String::from_utf16_lossy(line);
			assert!(line_text.contains("38;5;196"));
			assert!(line_text.contains("48;5;236"));
		}
	}

	#[test]
	fn test_wrap_text_with_ansi_keeps_inline_math_with_cjk() {
		let data = to_u16("비정상성: $C$와 $\\kappa$는 제도");
		let lines = wrap_text_with_ansi_impl(&data, 12, DEFAULT_TAB_WIDTH);
		let rendered: Vec<String> = lines
			.iter()
			.map(|line| String::from_utf16_lossy(line))
			.collect();

		assert!(rendered.iter().any(|line| line.contains("$C$")), "{rendered:?}");
		assert!(rendered.iter().any(|line| line.contains("$\\kappa$")), "{rendered:?}");
		assert!(!rendered.iter().any(|line| line.ends_with('$')), "{rendered:?}");
	}

	#[test]
	fn test_inline_math_rejects_display_math_dollar_adjacency() {
		let data = to_u16("abc $$x$$ def");
		assert_eq!(inline_math_end(&data, 4), None);
		assert_eq!(inline_math_end(&data, 5), None);

		let lines = wrap_text_with_ansi_impl(&data, 6, DEFAULT_TAB_WIDTH);
		let rendered: Vec<String> = lines
			.iter()
			.map(|line| String::from_utf16_lossy(line))
			.collect();

		assert!(rendered.iter().any(|line| line.contains("$$x$$")), "{rendered:?}");
		assert!(!rendered.iter().any(|line| line == "abc $"), "{rendered:?}");
	}

	#[test]
	fn test_inline_math_rejects_escaped_dollar_opener() {
		let data = to_u16("\\$5 and $x$");
		assert_eq!(inline_math_end(&data, 1), None);

		let lines = wrap_text_with_ansi_impl(&data, 6, DEFAULT_TAB_WIDTH);
		let rendered: Vec<String> = lines
			.iter()
			.map(|line| String::from_utf16_lossy(line))
			.collect();

		assert!(rendered.iter().any(|line| line.contains("$x$")), "{rendered:?}");
		assert!(!rendered.iter().any(|line| line.contains("\\$5 and $")), "{rendered:?}");
	}
}
