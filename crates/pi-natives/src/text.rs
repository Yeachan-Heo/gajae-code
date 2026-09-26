// Vendored from oh-my-pi (MIT) crates/pi-natives/src/text.rs @
// a85bd5228d9f0f619deade1db78fa49420a721e1 Local modifications: retain GJC OSC
// 8, inline-math, CRLF, 2-cell Hangul width, and private UTF-16 helper.
//! ANSI-aware text measurement and slicing utilities.
//!
//! Optimized for JS string interop (UTF-16).
//! - Single-pass ANSI scanning (no O(n²) `next_ansi` rescans)
//! - ASCII fast-path (no grapheme segmentation, no UTF-8 conversion)
//! - Non-ASCII uses a reused scratch String for grapheme segmentation
//! - Width checks early-exit
//! - Ellipsis decoded lazily
//! - truncateToWidth returns the original `JsString` when possible

use std::{
	cell::RefCell,
	sync::atomic::{AtomicU8, Ordering},
};

use napi::{JsString, bindgen_prelude::*};
use napi_derive::napi;
use smallvec::{SmallVec, smallvec};

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

fn with_js_utf16<T>(text: JsString, f: impl FnOnce(&[u16]) -> Result<T>) -> Result<T> {
	let text = text.into_utf16()?;
	let mut units = text.as_slice();
	if units.last() == Some(&0) {
		units = &units[..units.len() - 1];
	}
	f(units)
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
const fn is_sgr_u16(seq: &[u16]) -> bool {
	seq.len() >= 3 && seq[1] == b'[' as u16 && *seq.last().unwrap() == b'm' as u16
}

/// OSC 8 hyperlink state carried across soft-wrapped rows (issue #4711).
///
/// SGR state already survives wrapping via [`AnsiState`]; the hyperlink open
/// sequence must too, or every continuation row of a wrapped URL renders as
/// plain non-clickable text. The tracked open sequence is the verbatim input
/// bytes (BEL- or ST-terminated) so re-emission cannot alter link ids/URIs.
#[derive(Default)]
struct Osc8State {
	/// Active OSC 8 open sequence (`ESC ] 8 ; params ; URI` + terminator).
	open: Vec<u16>,
}

impl Osc8State {
	const CLOSE_BEL: &'static [u16] =
		&[ESC, b']' as u16, b'8' as u16, b';' as u16, b';' as u16, 0x07];

	#[inline]
	const fn is_active(&self) -> bool {
		!self.open.is_empty()
	}

	/// Record an OSC 8 sequence. Open sequences with a non-empty URI activate
	/// the link; close sequences (empty URI) deactivate it. Other OSC payloads
	/// leave link state untouched.
	fn apply(&mut self, seq: &[u16]) {
		if !is_osc8_u16(seq) {
			return;
		}
		// Slice between `ESC ] 8 ;` and the terminator (BEL or ST).
		let terminator_len = if *seq.last().unwrap() == 0x07 { 1 } else { 2 };
		let body = &seq[4..seq.len() - terminator_len];
		let uri_start = body
			.iter()
			.position(|&b| b == b';' as u16)
			.map_or(0, |p| p + 1);
		self.open.clear();
		if uri_start < body.len() {
			self.open.extend_from_slice(seq);
		}
	}

	/// Close any active link so it cannot bleed into padding or later text.
	#[inline]
	fn write_close(&self, out: &mut Vec<u16>) {
		if self.is_active() {
			out.extend_from_slice(Self::CLOSE_BEL);
		}
	}

	/// Re-emit the active open sequence on a continuation row.
	#[inline]
	fn write_open(&self, out: &mut Vec<u16>) {
		if self.is_active() {
			out.extend_from_slice(&self.open);
		}
	}
}

#[inline]
const fn is_osc8_u16(seq: &[u16]) -> bool {
	seq.len() >= 6
		&& seq[0] == ESC
		&& seq[1] == b']' as u16
		&& seq[2] == b'8' as u16
		&& seq[3] == b';' as u16
}

struct Osc66Info<'a> {
	payload: &'a [u16],
	scale:   usize,
	width:   usize,
}

#[inline]
fn parse_ascii_usize_u16(data: &[u16]) -> Option<usize> {
	if data.is_empty() {
		return None;
	}

	let mut value = 0usize;
	for &u in data {
		if !(b'0' as u16..=b'9' as u16).contains(&u) {
			return None;
		}
		value = value
			.saturating_mul(10)
			.saturating_add((u - b'0' as u16) as usize);
	}
	Some(value)
}

#[inline]
fn osc66_meta_payload_u16(seq: &[u16]) -> Option<(&[u16], &[u16])> {
	if seq.len() < 7
		|| seq[0] != ESC
		|| seq[1] != b']' as u16
		|| seq[2] != b'6' as u16
		|| seq[3] != b'6' as u16
		|| seq[4] != b';' as u16
	{
		return None;
	}

	let payload_end = if *seq.last()? == 0x07 {
		seq.len() - 1
	} else if seq.len() >= 8 && seq[seq.len() - 2] == ESC && seq[seq.len() - 1] == b'\\' as u16 {
		seq.len() - 2
	} else {
		return None;
	};

	let mut sep = 5usize;
	while sep < payload_end {
		if seq[sep] == b';' as u16 {
			return Some((&seq[5..sep], &seq[sep + 1..payload_end]));
		}
		sep += 1;
	}

	None
}

#[inline]
fn parse_osc66_meta_u16(meta: &[u16]) -> (usize, Option<usize>) {
	let mut scale = 1usize;
	let mut explicit_width = None;
	let mut part_start = 0usize;
	let mut i = 0usize;

	while i <= meta.len() {
		if i == meta.len() || meta[i] == b':' as u16 {
			let part = &meta[part_start..i];
			if let Some(eq) = part.iter().position(|&u| u == b'=' as u16) {
				let key = &part[..eq];
				let value = &part[eq + 1..];
				if key.len() == 1 {
					match key[0] {
						0x73 => {
							if let Some(parsed) = parse_ascii_usize_u16(value)
								&& (1..=7).contains(&parsed)
							{
								scale = parsed;
							}
						},
						0x77 => {
							if let Some(parsed) = parse_ascii_usize_u16(value) {
								explicit_width = Some(parsed);
							}
						},
						_ => {},
					}
				}
			}
			part_start = i + 1;
		}
		i += 1;
	}

	(scale, explicit_width.filter(|&width| width > 0))
}

#[inline]
fn osc66_info_u16(seq: &[u16], tab_width: usize) -> Option<Osc66Info<'_>> {
	let (meta, payload) = osc66_meta_payload_u16(seq)?;
	let (scale, explicit_width) = parse_osc66_meta_u16(meta);
	let base_width = explicit_width.unwrap_or_else(|| visible_width_u16(payload, tab_width));
	Some(Osc66Info { payload, scale, width: scale.saturating_mul(base_width) })
}

#[inline]
fn osc66_visible_width_u16(seq: &[u16], tab_width: usize) -> Option<usize> {
	Some(osc66_info_u16(seq, tab_width)?.width)
}

#[inline]
const fn div_ceil_usize(n: usize, d: usize) -> usize {
	if n == 0 { 0 } else { 1 + (n - 1) / d }
}

#[inline]
const fn osc66_payload_range(
	visual_start: usize,
	visual_len: usize,
	scale: usize,
	strict: bool,
) -> (usize, usize) {
	let visual_end = visual_start.saturating_add(visual_len);
	let payload_start = if strict {
		div_ceil_usize(visual_start, scale)
	} else {
		visual_start / scale
	};
	let payload_end = if strict {
		visual_end / scale
	} else {
		div_ceil_usize(visual_end, scale)
	};
	(payload_start, payload_end.saturating_sub(payload_start))
}

#[inline]
const fn is_ascii_grapheme_extender_u16(u: u16) -> bool {
	matches!(
		u,
		0x0300..=0x036f
			| 0x1ab0..=0x1aff
			| 0x1dc0..=0x1dff
			| 0x200d
			| 0x20d0..=0x20ff
			| 0xfe00..=0xfe0f
	)
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

/// Scan text for OSC 8 sequences and update link state (mirrors
/// [`update_state_from_text`] for SGR).
fn update_osc8_from_text(data: &[u16], osc8: &mut Osc8State) {
	let mut i = 0usize;
	while i < data.len() {
		if data[i] == ESC
			&& let Some(seq_len) = ansi_seq_len_u16(data, i)
		{
			osc8.apply(&data[i..i + seq_len]);
			i += seq_len;
			continue;
		}
		i += 1;
	}
}

const HANGUL_COMPAT_JAMO_WIDE_WIDTH: usize = 2;

/// Runtime override for Hangul Compatibility Jamo cell width.
///   0 = unset → GJC's retained 2-cell default
///   1 = force narrow (1 cell)
///   2 = force wide (2 cells)
///   3 = force Unicode width (no correction)
static HANGUL_COMPAT_JAMO_WIDTH_OVERRIDE: AtomicU8 = AtomicU8::new(0);

#[napi]
pub fn set_hangul_compat_jamo_width_override(value: u8) {
	HANGUL_COMPAT_JAMO_WIDTH_OVERRIDE.store(value, Ordering::Relaxed);
}

#[inline]
const fn is_hangul_compat_jamo(c: char) -> bool {
	let cp = c as u32;
	cp >= 0x3131 && cp <= 0x318e
}

#[inline]
fn hangul_compat_jamo_target_width() -> Option<usize> {
	match HANGUL_COMPAT_JAMO_WIDTH_OVERRIDE.load(Ordering::Relaxed) {
		1 => Some(1),
		2 => Some(HANGUL_COMPAT_JAMO_WIDE_WIDTH),
		3 => None,
		_ => Some(HANGUL_COMPAT_JAMO_WIDE_WIDTH),
	}
}

#[inline]
fn apply_hangul_compat_jamo_delta(mut width: usize, c: char) -> usize {
	if c == '\u{3164}' {
		return width.saturating_add(2);
	}
	if !is_hangul_compat_jamo(c) {
		return width;
	}
	let Some(target) = hangul_compat_jamo_target_width() else {
		return width;
	};
	let unicode_width = xutf::width_char(c);
	if unicode_width > target {
		width = width.saturating_sub(unicode_width - target);
	} else {
		width = width.saturating_add(target - unicode_width);
	}
	width
}

#[inline]
fn char_width_corrected(c: char) -> usize {
	if c == '\u{3164}' {
		return 2;
	}
	if is_hangul_compat_jamo(c)
		&& let Some(target) = hangul_compat_jamo_target_width()
	{
		return target;
	}
	xutf::width_char(c)
}

#[inline]
fn grapheme_width_str(g: &str, tab_width: usize) -> usize {
	if g == "\t" {
		return tab_width;
	}
	if g == "\r\n" {
		return 0;
	}
	let mut it = g.chars();
	let Some(c0) = it.next() else {
		return 0;
	};
	if it.next().is_none() {
		return char_width_corrected(c0);
	}
	let mut width = xutf::width_str(g);
	for c in g.chars() {
		width = apply_hangul_compat_jamo_delta(width, c);
	}
	width
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
		for g in xutf::graphemes_str(scratch) {
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
				let seq = &data[i..i + seq_len];
				if let Some(seq_width) = osc66_visible_width_u16(seq, tab_width) {
					width = width.saturating_add(seq_width);
					if width > limit {
						return (width, true);
					}
				}
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

fn append_visible_range_plain_u16<F>(
	out: &mut Vec<u16>,
	data: &[u16],
	start_col: usize,
	length: usize,
	strict: bool,
	tab_width: usize,
	mut before_first_write: F,
) -> (usize, bool)
where
	F: FnMut(&mut Vec<u16>),
{
	if length == 0 {
		return (0, false);
	}

	let end_col = start_col.saturating_add(length);
	let mut out_w = 0usize;
	let mut wrote = false;
	let mut current_col = 0usize;
	let mut i = 0usize;

	while i < data.len() && current_col < end_col {
		let start = i;
		let mut is_ascii = data[i] <= 0x7f;
		i += 1;
		if is_ascii {
			while i < data.len() && data[i] <= 0x7f {
				i += 1;
			}
			if i < data.len() && is_ascii_grapheme_extender_u16(data[i]) {
				let safe_end = i.saturating_sub(1);
				if safe_end > start {
					i = safe_end;
				} else {
					is_ascii = false;
					i += 1;
				}
			}
		}
		if !is_ascii {
			while i < data.len() && data[i] > 0x7f {
				i += 1;
			}
		}
		let seg = &data[start..i];

		if is_ascii {
			for &u in seg {
				if current_col >= end_col {
					break;
				}
				let gw = ascii_cell_width_u16(u, tab_width);
				let in_range = current_col >= start_col;
				let fits = !strict || current_col + gw <= end_col;
				if in_range && fits {
					if !wrote {
						before_first_write(out);
						wrote = true;
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
					if !wrote {
						before_first_write(out);
						wrote = true;
					}
					out.extend_from_slice(gu16);
					out_w += gw;
				}
				current_col += gw;
				current_col < end_col
			});
		}
	}

	(out_w, wrote)
}

fn flush_pending_ansi(
	out: &mut Vec<u16>,
	source: &[u16],
	pending: &mut SmallVec<[(usize, usize); 4]>,
) {
	if pending.is_empty() {
		return;
	}
	for &(p, l) in pending.iter() {
		out.extend_from_slice(&source[p..p + l]);
	}
	pending.clear();
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
			let seq = &token[i..i + seq_len];
			if let Some((_, payload)) = osc66_meta_payload_u16(seq)
				&& payload.iter().any(|&u| u != b' ' as u16)
			{
				return false;
			}
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

const fn is_escaped_u16(data: &[u16], index: usize) -> bool {
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
			let seq = &line[i..i + seq_len];
			if current.is_empty() || in_whitespace {
				pending_ansi.extend_from_slice(seq);
			} else {
				current.extend_from_slice(seq);
			}
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
	osc8: &mut Osc8State,
) -> SmallVec<[Vec<u16>; 4]> {
	let mut lines = SmallVec::<[Vec<u16>; 4]>::new();
	let mut current_line = Vec::<u16>::new();
	write_active_codes(state, &mut current_line);
	osc8.write_open(&mut current_line);
	let mut current_width = 0usize;
	let mut i = 0usize;
	while i < word.len() {
		if word[i] == ESC {
			if let Some(seq_len) = ansi_seq_len_u16(word, i) {
				let seq = &word[i..i + seq_len];
				if let Some(osc66) = osc66_info_u16(seq, tab_width) {
					if current_width.saturating_add(osc66.width) > width {
						write_line_end_reset(state, &mut current_line);
						osc8.write_close(&mut current_line);
						lines.push(current_line);
						current_line = Vec::new();
						write_active_codes(state, &mut current_line);
						osc8.write_open(&mut current_line);
						current_width = 0;
					}
					current_line.extend_from_slice(seq);
					current_width = current_width.saturating_add(osc66.width);
					i += seq_len;
					continue;
				}
				current_line.extend_from_slice(seq);
				if is_sgr_u16(seq) {
					state.apply_sgr_u16(&seq[2..seq_len - 1]);
				} else {
					osc8.apply(seq);
				}
				i += seq_len;
				continue;
			}
			// A lone ESC that does not start a recognizable ANSI sequence
			// as a zero-width scalar like truncate/slice do; without this the
			// segment scan below stops at the ESC without advancing `i` and
			// the outer loop never terminates.
			current_line.push(ESC);
			i += 1;
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
					osc8.write_close(&mut current_line);
					lines.push(current_line);
					current_line = Vec::new();
					write_active_codes(state, &mut current_line);
					osc8.write_open(&mut current_line);
					current_width = 0;
				}
				current_line.push(u);
				current_width += gw;
			}
		} else {
			let _ = for_each_grapheme_u16_slow(seg, tab_width, |gu16, gw| {
				if current_width + gw > width {
					write_line_end_reset(state, &mut current_line);
					osc8.write_close(&mut current_line);
					lines.push(std::mem::take(&mut current_line));
					write_active_codes(state, &mut current_line);
					osc8.write_open(&mut current_line);
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
		// Fast path: no wrap break, but an unterminated OSC 8 span still must
		// not leak past this row into margins/padding appended by callers
		// (Text.render, tui.ts) or into whatever a direct native consumer
		// emits next (#4711 review P2).
		let mut osc8 = Osc8State::default();
		update_osc8_from_text(line, &mut osc8);
		if osc8.is_active() {
			let mut row = line.to_vec();
			osc8.write_close(&mut row);
			return smallvec![row];
		}
		return smallvec![line.to_vec()];
	}

	let tokens = split_into_tokens_with_ansi(line);
	let mut wrapped = SmallVec::<[Vec<u16>; 4]>::new();
	let mut current_line = Vec::<u16>::new();
	let mut current_width = 0usize;
	let mut state = AnsiState::new();
	let mut osc8 = Osc8State::default();

	for token in tokens {
		let token_width = visible_width_u16(&token, tab_width);
		let is_whitespace = token_is_whitespace(&token);

		if token_width > width && !is_whitespace {
			// Same escape-only guard as the final flush: after dropped boundary
			// whitespace, current_line can hold only the re-emitted state
			// prefix. Pushing it here would emit a zero-width blank row before
			// the broken word's rows (#4711 review P2).
			if visible_width_u16(&current_line, tab_width) > 0 {
				write_line_end_reset(&state, &mut current_line);
				osc8.write_close(&mut current_line);
				wrapped.push(current_line);
				current_line = Vec::new();
				current_width = 0;
			}

			let mut broken = break_long_word(&token, width, tab_width, &mut state, &mut osc8);
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
			osc8.write_close(&mut line_to_wrap);
			wrapped.push(line_to_wrap);

			current_line = Vec::new();
			// A whitespace token dropped at the wrap boundary carries its own
			// escape transitions (notably an OSC 8 close attached to the boundary
			// spaces). Apply them BEFORE the continuation prefix re-emits active
			// state, or the stale open leaks onto this row and links the following
			// text to the old target (#4711 review P1).
			if is_whitespace {
				update_state_from_text(&token, &mut state);
				update_osc8_from_text(&token, &mut osc8);
			}
			write_active_codes(&state, &mut current_line);
			osc8.write_open(&mut current_line);
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
		update_osc8_from_text(&token, &mut osc8);
	}

	if !current_line.is_empty() {
		// Trim BEFORE the synthesized close: the cleanup loop below cannot trim
		// past a BEL terminator, so closing first would preserve trailing
		// spaces inside the link on the final row (#4711 review P2).
		trim_end_spaces_in_place(&mut current_line);
		// Skip an escape-only final row (zero visible width): after a dropped
		// boundary-whitespace token the buffer can hold just the re-emitted
		// state prefix (SGR restore, OSC 8 open) with no visible characters.
		// Emitting it would add a blank visual row and, for an unterminated
		// link, a phantom clickable row (#4711 review P2).
		if visible_width_u16(&current_line, tab_width) > 0 {
			osc8.write_close(&mut current_line);
			wrapped.push(current_line);
		}
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
pub fn wrap_text_with_ansi(
	text: Utf16String,
	width: u32,
	tab_width: u32,
) -> Result<Vec<Utf16String>> {
	// Take `Utf16String`, not `JsString::into_utf16()`: the latter slices its
	// buffer with the capacity (`utf16_len + 1`) instead of the written count,
	// so the NUL terminator napi writes rides along as a phantom trailing
	// U+0000. That zero-width phantom is normally trimmed from row output, but
	// a synthesized OSC 8 close appended after it (an unterminated hyperlink
	// that soft-wraps, #4711) would trap it mid-row and leak a control byte
	// into selection/copy text. `Utf16String`'s conversion truncates correctly.
	let tab_width = clamp_tab_width_for_ops(tab_width);
	let lines = wrap_text_with_ansi_impl(&text, width as usize, tab_width);
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
				if let Some(osc66) = osc66_info_u16(seq, tab_width) {
					let span_end = w.saturating_add(osc66.width);
					if span_end <= target_w {
						out.extend_from_slice(seq);
						w = span_end;
						i += seq_len;
						if w >= target_w {
							break;
						}
						continue;
					}
					if w < target_w {
						let remaining = target_w - w;
						let (payload_w, _) = append_visible_range_plain_u16(
							&mut out,
							osc66.payload,
							0,
							remaining,
							true,
							tab_width,
							|_| {},
						);
						w = w.saturating_add(payload_w);
					}
					break;
				}
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
	let original = text;
	with_js_utf16(text, |text| {
		let (text_w, exceeded) = visible_width_u16_up_to(text, max_width, tab_width);
		if !exceeded && (!pad || text_w == max_width) {
			return Ok(Either::A(original));
		}
		Ok(Either::B(build_utf16_string(truncate_to_width_u16_impl(
			text,
			max_width,
			ellipsis_kind,
			pad,
			tab_width,
		))))
	})
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
		out.push(with_js_utf16(line, |text| {
			let (text_w, exceeded) = visible_width_u16_up_to(text, max_width, tab_width);
			if !exceeded && (!pad || text_w == max_width) {
				return Ok(build_utf16_string_preserve_nul(text.to_vec()));
			}
			Ok(build_utf16_string_preserve_nul(truncate_to_width_u16_impl(
				text,
				max_width,
				ellipsis_kind,
				pad,
				tab_width,
			)))
		})?);
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
				let seq = &line[i..i + seq_len];
				if let Some(osc66) = osc66_info_u16(seq, tab_width) {
					let span_start = current_col;
					let span_end = current_col.saturating_add(osc66.width);
					if span_start >= start_col && span_end <= end_col {
						flush_pending_ansi(&mut out, line, &mut pending_ansi);
						out.extend_from_slice(seq);
						out_w = out_w.saturating_add(osc66.width);
					} else if span_start < end_col && span_end > start_col {
						let overlap_start = start_col.saturating_sub(span_start);
						let overlap_end = span_end.min(end_col) - span_start;
						let overlap_len = overlap_end.saturating_sub(overlap_start);
						let (payload_start, payload_len) =
							osc66_payload_range(overlap_start, overlap_len, osc66.scale, strict);
						let (payload_w, _) = append_visible_range_plain_u16(
							&mut out,
							osc66.payload,
							payload_start,
							payload_len,
							strict,
							tab_width,
							|out| flush_pending_ansi(out, line, &mut pending_ansi),
						);
						out_w = out_w.saturating_add(payload_w);
					}
					current_col = span_end;
					i += seq_len;
					continue;
				}

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
					flush_pending_ansi(&mut out, line, &mut pending_ansi);
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
					flush_pending_ansi(&mut out, line, &mut pending_ansi);
					out.extend_from_slice(gu16);
					out_w += gw;
				}

				current_col += gw;
				current_col < end_col
			});
		}
	}

	// Include trailing ANSI sequences (e.g., reset codes) that immediately
	// follow
	while i < line.len() {
		if line[i] == ESC
			&& let Some(len) = ansi_seq_len_u16(line, i)
		{
			let seq = &line[i..i + len];
			if osc66_visible_width_u16(seq, tab_width).is_none() {
				out.extend_from_slice(seq);
			}
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
	if length == 0 {
		return Ok(SliceResult { text: build_utf16_string(vec![]), width: 0 });
	}
	let strict = strict.unwrap_or(false);
	let tab_width = clamp_tab_width_for_ops(tab_width);
	with_js_utf16(line, |line| {
		let (out, width) =
			slice_with_width_impl(line, start_col as usize, length as usize, strict, tab_width);
		Ok(SliceResult {
			text:  build_utf16_string(out),
			width: crate::utils::clamp_u32(width as u64),
		})
	})
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
				if let Some(osc66) = osc66_info_u16(seq, tab_width) {
					let span_start = current_col;
					let span_end = current_col.saturating_add(osc66.width);

					if span_start < before_end {
						if span_end <= before_end {
							flush_pending_ansi(&mut before, line, &mut pending_before_ansi);
							before.extend_from_slice(seq);
							before_w = before_w.saturating_add(osc66.width);
						} else {
							let overlap_len = before_end - span_start;
							let (payload_start, payload_len) =
								osc66_payload_range(0, overlap_len, osc66.scale, true);
							let (payload_w, _) = append_visible_range_plain_u16(
								&mut before,
								osc66.payload,
								payload_start,
								payload_len,
								true,
								tab_width,
								|out| flush_pending_ansi(out, line, &mut pending_before_ansi),
							);
							before_w = before_w.saturating_add(payload_w);
						}
					}

					if after_len != 0 && span_start < after_end && span_end > after_start {
						let overlap_start = after_start.saturating_sub(span_start);
						let overlap_end = span_end.min(after_end) - span_start;
						let overlap_len = overlap_end.saturating_sub(overlap_start);

						if span_start >= after_start && span_end <= after_end {
							if !after_started {
								state.write_restore_u16(&mut after);
								after_started = true;
							}
							after.extend_from_slice(seq);
							after_w = after_w.saturating_add(osc66.width);
						} else {
							let (payload_start, payload_len) =
								osc66_payload_range(overlap_start, overlap_len, osc66.scale, strict_after);
							let (payload_w, wrote_payload) = append_visible_range_plain_u16(
								&mut after,
								osc66.payload,
								payload_start,
								payload_len,
								strict_after,
								tab_width,
								|out| {
									if !after_started {
										state.write_restore_u16(out);
										after_started = true;
									}
								},
							);
							if wrote_payload {
								after_w = after_w.saturating_add(payload_w);
							}
						}
					}

					current_col = span_end;
					i += seq_len;
					continue;
				}

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
					flush_pending_ansi(&mut before, line, &mut pending_before_ansi);
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
					flush_pending_ansi(&mut before, line, &mut pending_before_ansi);
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
	let tab_width = clamp_tab_width_for_ops(tab_width);
	with_js_utf16(line, |line| {
		let (before, before_width, after, after_width) = extract_segments_impl(
			line,
			before_end as usize,
			after_start as usize,
			after_len as usize,
			strict_after,
			tab_width,
		);
		Ok(ExtractSegmentsResult {
			before:       build_utf16_string(before),
			before_width: crate::utils::clamp_u32(before_width as u64),
			after:        build_utf16_string(after),
			after_width:  crate::utils::clamp_u32(after_width as u64),
		})
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
	let tab_width = clamp_tab_width_for_ops(tab_width);
	with_js_utf16(text, |text| {
		Ok(crate::utils::clamp_u32(visible_width_u16(text, tab_width) as u64))
	})
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
	fn test_emoji_grapheme_width() {
		for emoji in ["❤️", "☑️", "↔️", "1️⃣", "👍🏽"] {
			assert_eq!(visible_width_u16(&to_u16(emoji), DEFAULT_TAB_WIDTH), 2);
		}
		assert_eq!(truncate_string_for_test("❤️X", 2), "❤️");
		assert_eq!(truncate_string_for_test("👍🏽X", 2), "👍🏽");
	}

	#[test]
	fn test_hangul_filler_width() {
		assert_eq!(visible_width_u16(&to_u16("\u{3164}"), DEFAULT_TAB_WIDTH), 2);
		assert_eq!(truncate_string_for_test("\u{3164}X", 2), "\u{3164}");
	}

	#[test]
	fn test_crlf_zero_width_scalar_batch_parity() {
		// CR and LF are zero-width under the ASCII fast path. The grapheme path
		// (triggered by any non-ASCII scalar in the same segment) must agree so
		// the width primitive stays context-independent.
		assert_eq!(visible_width_u16(&to_u16("\r\n"), DEFAULT_TAB_WIDTH), 0);

		// Korean (한글) and CJK ideographs are East Asian Wide (2 cells each);
		// the adjacent CRLF must contribute 0 in every position.
		let cases = [
			("한\r\n", 2),
			("\r\n한", 2),
			("한\r\n글", 4),
			("가\r나\n다", 6),
			("字\r\n漢", 4),
			("한字\r\n漢글", 8),
			("한\r\n\r\n글", 4),
		];
		for (case, expected) in cases {
			let scalar = visible_width_u16(&to_u16(case), DEFAULT_TAB_WIDTH);
			let batch = visible_widths(vec![case.to_string()], DEFAULT_TAB_WIDTH as u32);
			assert_eq!(scalar, expected, "scalar width mismatch for {case:?}");
			assert_eq!(batch, vec![expected as u32], "batch width mismatch for {case:?}");
			// The non-ASCII CRLF result must match the pure-ASCII CRLF policy:
			// removing the CR/LF scalars leaves exactly `expected` cells.
			let stripped = case.replace(['\r', '\n'], "");
			assert_eq!(
				visible_width_u16(&to_u16(&stripped), DEFAULT_TAB_WIDTH),
				expected,
				"CR/LF must be zero-width for {case:?}"
			);
		}
	}

	#[test]
	fn test_crlf_preserves_grapheme_correctness() {
		// The CRLF correction must not regress VS16/modifier/keycap/ZWJ widths,
		// including when a CRLF sits next to complex graphemes.
		let cases = [("❤️\r\n", 2), ("👍🏽\r\n", 2), ("1️⃣\r\n", 2), ("👨‍👩‍👧‍👦\r\n", 2), ("한\r\n👨‍👩‍👧‍👦", 4)];
		for (case, expected) in cases {
			assert_eq!(
				visible_width_u16(&to_u16(case), DEFAULT_TAB_WIDTH),
				expected,
				"grapheme width regressed for {case:?}"
			);
		}
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
	fn test_wrap_text_with_ansi_terminates_on_lone_esc_in_long_word() {
		// Regression: a word wider than the wrap width containing an ESC that
		// does not start a recognizable ANSI sequence (binary tool output,
		// e.g. `head` on a compiled binary persisted into a session) made
		// `break_long_word` loop forever: the segment scan stops at ESC
		// without consuming it. Interactive session resume then spun at 100%
		// CPU while wrapping history.
		let cases: &[Vec<u16>] = &[
			// lone ESC followed by NUL inside an over-width word
			to_u16(&format!("{}\u{1b}\0{}", "x".repeat(85), "y".repeat(85))),
			// lone ESC at the very end of an over-width word
			to_u16(&format!("{}\u{1b}", "x".repeat(85))),
			// ESC followed by a byte outside every recognized sequence class
			to_u16(&format!("{}\u{1b}5{}", "x".repeat(85), "y".repeat(85))),
			// Mach-O-flavored soup: NUL runs, replacement chars, trailing ESC
			to_u16(&format!(
				"__TEXT{}\u{fffd}F{}__literals{}\u{fffd}\u{fffd}\u{1b}",
				"\0".repeat(20),
				"\0".repeat(40),
				"\0".repeat(30),
			)),
		];
		for data in cases {
			let lines = wrap_text_with_ansi_impl(data, 80, DEFAULT_TAB_WIDTH);
			assert!(!lines.is_empty());
			// Zero-width scalars must not be dropped by the wrap.
			let total: usize = lines.iter().map(Vec::len).sum();
			let esc_in: usize = data.iter().filter(|&&u| u == ESC).count();
			let esc_out: usize = lines
				.iter()
				.map(|l| l.iter().filter(|&&u| u == ESC).count())
				.sum();
			assert!(esc_out >= esc_in, "lone ESC dropped: {esc_in} in, {esc_out} out");
			assert!(total > 0);
		}
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

	fn osc8_open(uri: &str) -> String {
		format!("\x1b]8;;{uri}\x07")
	}

	const OSC8_CLOSE: &str = "\x1b]8;;\x07";

	fn visible_plain(line: &[u16]) -> String {
		let text = String::from_utf16_lossy(line);
		regex_strip_osc(&text)
	}

	fn regex_strip_osc(text: &str) -> String {
		let mut out = String::with_capacity(text.len());
		let bytes: Vec<char> = text.chars().collect();
		let mut i = 0usize;
		while i < bytes.len() {
			if bytes[i] == '\x1b' && i + 1 < bytes.len() && bytes[i + 1] == ']' {
				let mut j = i + 2;
				while j < bytes.len() {
					if bytes[j] == '\x07' {
						j += 1;
						break;
					}
					if bytes[j] == '\x1b' && j + 1 < bytes.len() && bytes[j + 1] == '\\' {
						j += 2;
						break;
					}
					j += 1;
				}
				i = j;
				continue;
			}
			if bytes[i] == '\x1b' && i + 1 < bytes.len() && bytes[i + 1] == '[' {
				let mut j = i + 2;
				while j < bytes.len() && !((0x40..=0x7e).contains(&(bytes[j] as u32))) {
					j += 1;
				}
				i = j + 1;
				continue;
			}
			out.push(bytes[i]);
			i += 1;
		}
		out
	}

	fn osc8_uris(line: &[u16]) -> Vec<String> {
		// Non-close OSC 8 opens with their URI payload.
		let text = String::from_utf16_lossy(line);
		let bytes: Vec<char> = text.chars().collect();
		let mut out = Vec::new();
		let mut i = 0usize;
		while i < bytes.len() {
			if bytes[i] == '\x1b' && i + 1 < bytes.len() && bytes[i + 1] == ']' {
				let mut j = i + 2;
				let mut body = String::new();
				let mut closed = false;
				while j < bytes.len() {
					if bytes[j] == '\x07' {
						j += 1;
						closed = true;
						break;
					}
					if bytes[j] == '\x1b' && j + 1 < bytes.len() && bytes[j + 1] == '\\' {
						j += 2;
						closed = true;
						break;
					}
					body.push(bytes[j]);
					j += 1;
				}
				if closed && (body.starts_with("8;")) && body.len() > 3 {
					out.push(body[3..].to_string());
				}
				i = j;
				continue;
			}
			i += 1;
		}
		out
	}

	#[test]
	fn test_wrap_carries_osc8_hyperlink_across_soft_wrap() {
		// Issue #4711: continuation rows of a wrapped URL must keep the open.
		let url = "https://example.com/a/very/long/url/that/wraps/over/two/lines/when/narrow";
		let data = to_u16(&format!("docs {}{}{}{}", osc8_open(url), url, OSC8_CLOSE, " trailing"));
		let lines = wrap_text_with_ansi_impl(&data, 20, DEFAULT_TAB_WIDTH);

		assert_eq!(visible_plain(&lines[0]), "docs");
		assert_eq!(visible_plain(lines.last().unwrap()), "trailing");
		let fragments = &lines[1..lines.len() - 1];
		assert!(fragments.len() >= 2);
		for line in fragments {
			assert_eq!(osc8_uris(line), vec![url.to_string()]);
			let text = visible_plain(line);
			assert!(url.contains(&text), "fragment {text:?} not from URL");
		}
		let reassembled: String = fragments.iter().map(|line| visible_plain(line)).collect();
		assert_eq!(reassembled, url);
	}

	#[test]
	fn test_wrap_carries_osc8_hyperlink_over_three_or_more_rows() {
		let url = "https://example.com/a/very/long/url/that/wraps/over/two/lines/when/narrow";
		for width in [12usize, 8, 6] {
			let data = to_u16(&format!("{}{}{}", osc8_open(url), url, OSC8_CLOSE));
			let lines = wrap_text_with_ansi_impl(&data, width, DEFAULT_TAB_WIDTH);
			assert!(lines.len() >= 3, "width {width} produced {} rows", lines.len());
			for line in &lines {
				assert_eq!(osc8_uris(line), vec![url.to_string()]);
				assert!(!visible_plain(line).is_empty());
			}
			let reassembled: String = lines.iter().map(|line| visible_plain(line)).collect();
			assert_eq!(reassembled, url);
		}
	}

	#[test]
	fn test_wrap_closes_osc8_at_row_ends_and_does_not_leak_into_plain_rows() {
		let url = "https://example.com/a/very/long/url/that/wraps/over/two/lines/when/narrow";
		let data = to_u16(&format!("docs {}{}{}{}", osc8_open(url), url, OSC8_CLOSE, " trailing"));
		for width in [6usize, 8, 12, 20, 40, 60, 80, 90] {
			let lines = wrap_text_with_ansi_impl(&data, width, DEFAULT_TAB_WIDTH);
			for line in &lines {
				let text = visible_plain(line);
				let uris = osc8_uris(line);
				let is_plain = text == "docs"
					|| text == "trailing"
					|| text.is_empty()
					|| text.split_whitespace().all(|w| {
						w == "docs"
							|| w == "trailing"
							|| "trailing".contains(w) && w.chars().all(|c| "trailing".contains(c))
					});
				if is_plain {
					assert!(uris.is_empty(), "plain row {text:?} carries link at width {width}");
				} else {
					assert_eq!(uris, vec![url.to_string()], "url row at width {width}: {text:?}");
				}
			}
		}
	}

	#[test]
	fn test_wrap_does_not_carry_osc8_across_hard_newline() {
		let url = "https://example.com/a/very/long/url";
		let data = to_u16(&format!("{}{}{}\nadjacent plain text", osc8_open(url), url, OSC8_CLOSE));
		let lines = wrap_text_with_ansi_impl(&data, 20, DEFAULT_TAB_WIDTH);
		let split = lines
			.iter()
			.position(|line| visible_plain(line).starts_with("adjacent"))
			.expect("hard-break line missing");
		for line in &lines[split..] {
			assert!(osc8_uris(line).is_empty());
			assert!(!String::from_utf16_lossy(line).contains("\x1b]8;"));
		}
		for line in &lines[..split] {
			assert_eq!(osc8_uris(line), vec![url.to_string()]);
		}
	}

	#[test]
	fn test_wrap_does_not_link_text_after_unclosed_osc8_hard_newline() {
		let url = "https://example.com/a/very/long/url";
		let data = to_u16(&format!("{}short\nnext-line", osc8_open(url)));
		let lines = wrap_text_with_ansi_impl(&data, 40, DEFAULT_TAB_WIDTH);
		assert_eq!(lines.len(), 2);
		assert_eq!(osc8_uris(&lines[0]), vec![url.to_string()]);
		assert!(osc8_uris(&lines[1]).is_empty());
		assert!(!String::from_utf16_lossy(&lines[1]).contains("\x1b]8;"));
	}

	#[test]
	fn test_wrap_unterminated_osc8_that_wraps_emits_no_control_bytes() {
		// Guards the napi bridge regression (#4711 red-team): an unterminated
		// link that soft-wraps gets a synthesized close on its final row, and
		// nothing — including a phantom trailing NUL from input conversion —
		// may sit between the display text and that close.
		let url = "https://example.com/a/very/long/url/that/wraps/over/two/lines/when/narrow";
		for width in [20usize, 12, 8] {
			let data = to_u16(&format!("{}{}", osc8_open(url), url));
			let lines = wrap_text_with_ansi_impl(&data, width, DEFAULT_TAB_WIDTH);
			assert!(lines.len() >= 3, "width {width} produced {} rows", lines.len());
			for line in &lines {
				assert!(!line.contains(&0u16), "NUL leaked at width {width}");
				assert_eq!(osc8_uris(line), vec![url.to_string()]);
			}
			let reassembled: String = lines.iter().map(|line| visible_plain(line)).collect();
			assert_eq!(reassembled, url);
		}
	}

	#[test]
	fn test_wrap_applies_close_in_dropped_boundary_whitespace_before_prefix() {
		// #4711 review P1: the tokenizer attaches the close to the whitespace
		// token; that token is dropped at the wrap boundary, so its OSC
		// transition must land before the continuation prefix re-emits the
		// active open — otherwise the following text renders linked to the
		// already-closed target.
		let url = "https://x.test/";
		let data = to_u16(&format!("{}foo{} bar", osc8_open(url), OSC8_CLOSE));
		for width in [3usize, 4, 5] {
			let lines = wrap_text_with_ansi_impl(&data, width, DEFAULT_TAB_WIDTH);
			assert_eq!(visible_plain(&lines[0]), "foo");
			assert_eq!(osc8_uris(&lines[0]), vec![url.to_string()]);
			for line in &lines[1..] {
				assert!(
					osc8_uris(line).is_empty(),
					"stale open at width {width}: {:?}",
					String::from_utf16_lossy(line)
				);
			}
		}
	}

	#[test]
	fn test_wrap_closes_unterminated_osc8_on_no_wrap_fast_path() {
		// #4711 review P2: a link that fits on one row must still self-close,
		// or it leaks into caller-appended margins/padding and beyond.
		let url = "https://x.test/";
		let data = to_u16(&format!("{}foo", osc8_open(url)));
		let lines = wrap_text_with_ansi_impl(&data, 40, DEFAULT_TAB_WIDTH);
		assert_eq!(lines.len(), 1);
		assert_eq!(osc8_uris(&lines[0]), vec![url.to_string()]);
		assert!(String::from_utf16_lossy(&lines[0]).ends_with(OSC8_CLOSE));

		// Already-terminated input is not double-closed; plain text untouched.
		let closed = to_u16(&format!("{}foo{}", osc8_open(url), OSC8_CLOSE));
		let closed_lines = wrap_text_with_ansi_impl(&closed, 40, DEFAULT_TAB_WIDTH);
		assert_eq!(closed_lines.len(), 1);
		assert_eq!(visible_plain(&closed_lines[0]), "foo");
		let plain = to_u16("foo bar");
		let plain_lines = wrap_text_with_ansi_impl(&plain, 40, DEFAULT_TAB_WIDTH);
		assert_eq!(plain_lines.len(), 1);
		assert_eq!(plain_lines[0], plain);
	}

	#[test]
	fn test_wrap_trims_final_row_before_synthesized_close() {
		// #4711 review P2: trailing spaces on the final row of an unterminated
		// wrapped link must be trimmed BEFORE the close is appended, or the
		// BEL terminator shields them from the cleanup trim.
		let url = "https://x.test/";
		let data = to_u16(&format!("{}abcdefgh  ", osc8_open(url)));
		let lines = wrap_text_with_ansi_impl(&data, 5, DEFAULT_TAB_WIDTH);
		let last = String::from_utf16_lossy(lines.last().unwrap());
		assert!(last.contains("fgh") && !last.contains("fgh  "), "trailing spaces kept: {last:?}");
		assert!(last.ends_with(OSC8_CLOSE));
		let reassembled: String = lines.iter().map(|line| visible_plain(line)).collect();
		assert_eq!(reassembled, "abcdefgh");
	}

	#[test]
	fn test_wrap_does_not_emit_escape_only_continuation_row() {
		// #4711 review P2: trailing boundary whitespace after an unterminated
		// link must not produce a phantom zero-width (OSC-only) row, which
		// renders as a blank line and stays clickable.
		let url = "https://x.test/";
		for width in [2usize, 3, 5] {
			let data = to_u16(&format!("{}foo ", osc8_open(url)));
			let lines = wrap_text_with_ansi_impl(&data, width, DEFAULT_TAB_WIDTH);
			for line in &lines {
				assert!(
					visible_width_u16(line, DEFAULT_TAB_WIDTH) > 0,
					"escape-only row at width {width}: {:?}",
					String::from_utf16_lossy(line)
				);
			}
			// Width 5 fits "foo " untouched on the fast path; wrapping widths
			// drop the boundary space per the standard whitespace contract.
			let reassembled: String = lines.iter().map(|line| visible_plain(line)).collect();
			assert!(reassembled == "foo" || reassembled == "foo ");
			assert_eq!(osc8_uris(&lines[0]), vec![url.to_string()]);

			// Dropped whitespace before an over-width word (break-long-word
			// path) must not emit an escape-only row either.
			let broken = to_u16(&format!("{}foo longword", osc8_open(url)));
			for line in wrap_text_with_ansi_impl(&broken, width, DEFAULT_TAB_WIDTH) {
				assert!(visible_width_u16(&line, DEFAULT_TAB_WIDTH) > 0);
			}

			// SGR-styled input keeps the same no-phantom-row guarantee.
			let sgr = to_u16("\x1b[31mfoo ");
			for line in wrap_text_with_ansi_impl(&sgr, width, DEFAULT_TAB_WIDTH) {
				assert!(visible_width_u16(&line, DEFAULT_TAB_WIDTH) > 0);
			}
		}
	}

	#[test]
	fn test_wrap_reemits_st_terminated_osc8_open_verbatim() {
		let url = "https://example.com/a/very/long/url/that/wraps/over/two/lines/when/narrow";
		let open_st = format!("\x1b]8;;{url}\x1b\\");
		let close_st = "\x1b]8;;\x1b\\";
		let data = to_u16(&format!("docs {open_st}{url}{close_st} trailing"));
		let lines = wrap_text_with_ansi_impl(&data, 20, DEFAULT_TAB_WIDTH);
		let fragments = &lines[1..lines.len() - 1];
		assert!(fragments.len() >= 2);
		for line in fragments {
			let text = String::from_utf16_lossy(line);
			assert!(text.contains(&open_st), "ST open not verbatim: {text:?}");
		}
	}

	#[test]
	fn test_wrap_keeps_distinct_osc8_targets_for_multiple_urls() {
		let first = "https://a.test/one/long/url/that/wraps/across/rows";
		let second = "https://b.test/two/long/url/that/wraps/across/rows";
		let data = to_u16(&format!(
			"see {}{}, and {}{}.",
			osc8_open(first),
			first,
			osc8_open(second),
			second
		));
		let lines = wrap_text_with_ansi_impl(&data, 20, DEFAULT_TAB_WIDTH);
		let mut seen_first = false;
		let mut seen_second = false;
		for line in &lines {
			for uri in osc8_uris(line) {
				assert!(uri == first || uri == second, "extended uri: {uri:?}");
				if uri == first {
					seen_first = true;
				} else {
					seen_second = true;
				}
			}
		}
		assert!(seen_first && seen_second);
	}

	#[test]
	fn test_wrap_carries_osc8_with_wide_unicode_and_sgr() {
		let url = "https://example.com/a/very/long/url/that/wraps/over/two/lines/when/narrow";
		// Wide Korean text before the link.
		let data = to_u16(&format!("\u{c554}\u{b8e8} {}{}{}", osc8_open(url), url, OSC8_CLOSE));
		let lines = wrap_text_with_ansi_impl(&data, 20, DEFAULT_TAB_WIDTH);
		assert_eq!(visible_plain(&lines[0]), "\u{c554}\u{b8e8}");
		for line in &lines[1..] {
			assert_eq!(osc8_uris(line), vec![url.to_string()]);
		}

		// Underlined link: style restore and link open both continue.
		let styled = to_u16(&format!("see \x1b[4m{}{}\x1b[24m now", osc8_open(url), url));
		let styled_lines = wrap_text_with_ansi_impl(&styled, 20, DEFAULT_TAB_WIDTH);
		for line in &styled_lines {
			if !osc8_uris(line).is_empty() {
				assert!(String::from_utf16_lossy(line).starts_with("\x1b[4m"));
			}
		}
	}

	#[test]
	fn test_wrap_plain_text_has_no_osc8() {
		let data = to_u16("just some words that wrap across rows");
		let lines = wrap_text_with_ansi_impl(&data, 10, DEFAULT_TAB_WIDTH);
		assert!(lines.len() > 1);
		for line in &lines {
			assert!(!String::from_utf16_lossy(line).contains("\x1b]8;"));
		}
	}
	#[test]
	fn osc66_visible_width_wrap_truncate_slice_and_extract() {
		let image = to_u16("\x1b]66;s=2;Hi\x1b\\");
		assert_eq!(visible_width_u16(&image, DEFAULT_TAB_WIDTH), 4);
		assert_eq!(
			osc66_visible_width_u16(&to_u16("\x1b]66;w=5;Hi\x07"), DEFAULT_TAB_WIDTH),
			Some(5)
		);

		let (head, head_width) = slice_with_width_impl(&image, 0, 2, true, DEFAULT_TAB_WIDTH);
		assert_eq!(String::from_utf16_lossy(&head), "H");
		assert_eq!(head_width, 1);
		let (tail, tail_width) = slice_with_width_impl(&image, 2, 2, true, DEFAULT_TAB_WIDTH);
		assert_eq!(String::from_utf16_lossy(&tail), "i");
		assert_eq!(tail_width, 1);

		let (before, before_width, after, after_width) =
			extract_segments_impl(&to_u16("A\x1b]66;s=2;Hi\x1b\\Z"), 1, 3, 2, true, DEFAULT_TAB_WIDTH);
		assert_eq!(String::from_utf16_lossy(&before), "A");
		assert_eq!(before_width, 1);
		assert_eq!(String::from_utf16_lossy(&after), "i");
		assert_eq!(after_width, 1);

		let wrapped =
			wrap_text_with_ansi_impl(&to_u16("A\x1b]66;s=2;Hi\x1b\\Z"), 4, DEFAULT_TAB_WIDTH);
		assert_eq!(wrapped.len(), 3);
		assert!(String::from_utf16_lossy(&wrapped[1]).contains("\x1b]66;s=2;Hi\x1b\\"));
	}

	#[test]
	fn osc66_truncation_preserves_complete_graphic_sequences() {
		let data = to_u16("A\x1b]66;s=2;Hi\x1b\\Z");
		let truncated =
			truncate_to_width_u16_impl(&data, 6, Ellipsis::Omit, false, DEFAULT_TAB_WIDTH);
		assert_eq!(String::from_utf16_lossy(&truncated), "A\x1b]66;s=2;Hi\x1b\\Z");
	}
}
