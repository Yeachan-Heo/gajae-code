//! Native hashline formatting compatible with
//! `packages/coding-agent/src/hashline/hash.ts`.

use napi::{JsString, bindgen_prelude::*};
use napi_derive::napi;
use xxhash_rust::xxh32::xxh32;

const HL_BODY_SEP: u16 = b'|' as u16;
const LF: u16 = b'\n' as u16;
const CR: u16 = b'\r' as u16;

const HL_BIGRAMS: [&str; 647] = [
	"aa", "ab", "ac", "ad", "ae", "af", "ag", "ah", "ai", "aj", "ak", "al", "am", "an", "ao", "ap",
	"aq", "ar", "as", "at", "au", "av", "aw", "ax", "ay", "az", "ba", "bb", "bc", "bd", "be", "bf",
	"bg", "bh", "bi", "bj", "bk", "bl", "bm", "bn", "bo", "bp", "br", "bs", "bt", "bu", "bv", "bw",
	"bx", "by", "bz", "ca", "cb", "cc", "cd", "ce", "cf", "cg", "ch", "ci", "cj", "ck", "cl", "cm",
	"cn", "co", "cp", "cq", "cr", "cs", "ct", "cu", "cv", "cw", "cx", "cy", "cz", "da", "db", "dc",
	"dd", "de", "df", "dg", "dh", "di", "dj", "dk", "dl", "dm", "dn", "do", "dp", "dq", "dr", "ds",
	"dt", "du", "dv", "dw", "dx", "dy", "dz", "ea", "eb", "ec", "ed", "ee", "ef", "eg", "eh", "ei",
	"ej", "ek", "el", "em", "en", "eo", "ep", "eq", "er", "es", "et", "eu", "ev", "ew", "ex", "ey",
	"ez", "fa", "fb", "fc", "fd", "fe", "ff", "fg", "fh", "fi", "fj", "fk", "fl", "fm", "fn", "fo",
	"fp", "fq", "fr", "fs", "ft", "fu", "fv", "fw", "fx", "fy", "fz", "ga", "gb", "gc", "gd", "ge",
	"gf", "gg", "gh", "gi", "gj", "gl", "gm", "gn", "go", "gp", "gr", "gs", "gt", "gu", "gv", "gw",
	"gx", "gy", "gz", "ha", "hb", "hc", "hd", "he", "hf", "hg", "hh", "hi", "hj", "hk", "hl", "hm",
	"hn", "ho", "hp", "hq", "hr", "hs", "ht", "hu", "hv", "hw", "hx", "hy", "hz", "ia", "ib", "ic",
	"id", "ie", "if", "ig", "ih", "ii", "ij", "ik", "il", "im", "in", "io", "ip", "iq", "ir", "is",
	"it", "iu", "iv", "iw", "ix", "iy", "iz", "ja", "jb", "jc", "jd", "je", "jf", "jg", "jh", "ji",
	"jj", "jk", "jl", "jm", "jn", "jo", "jp", "jq", "jr", "js", "jt", "ju", "jw", "jx", "jy", "ka",
	"kb", "kc", "kd", "ke", "kf", "kg", "kh", "ki", "kj", "kk", "kl", "km", "kn", "ko", "kp", "kr",
	"ks", "kt", "ku", "kv", "kw", "kx", "ky", "la", "lb", "lc", "ld", "le", "lf", "lg", "lh", "li",
	"lj", "lk", "ll", "lm", "ln", "lo", "lp", "lr", "ls", "lt", "lu", "lv", "lw", "lx", "ly", "lz",
	"ma", "mb", "mc", "md", "me", "mf", "mg", "mh", "mi", "mj", "mk", "ml", "mm", "mn", "mo", "mp",
	"mq", "mr", "ms", "mt", "mu", "mv", "mw", "mx", "my", "mz", "na", "nb", "nc", "nd", "ne", "nf",
	"ng", "nh", "ni", "nj", "nk", "nl", "nm", "nn", "no", "np", "nr", "ns", "nt", "nu", "nv", "nw",
	"nx", "ny", "nz", "oa", "ob", "oc", "od", "oe", "of", "og", "oh", "oi", "oj", "ok", "ol", "om",
	"on", "oo", "op", "oq", "or", "os", "ot", "ou", "ov", "ow", "ox", "oy", "oz", "pa", "pb", "pc",
	"pd", "pe", "pf", "pg", "ph", "pi", "pj", "pk", "pl", "pm", "pn", "po", "pp", "pq", "pr", "ps",
	"pt", "pu", "pv", "pw", "px", "py", "pz", "qa", "qb", "qc", "qd", "qe", "qh", "qi", "ql", "qm",
	"qn", "qo", "qp", "qq", "qr", "qs", "qt", "qu", "qw", "qx", "qy", "ra", "rb", "rc", "rd", "re",
	"rf", "rg", "rh", "ri", "rk", "rl", "rm", "rn", "ro", "rp", "rq", "rr", "rs", "rt", "ru", "rv",
	"rw", "rx", "ry", "rz", "sa", "sb", "sc", "sd", "se", "sf", "sg", "sh", "si", "sj", "sk", "sl",
	"sm", "sn", "so", "sp", "sq", "sr", "ss", "st", "su", "sv", "sw", "sx", "sy", "sz", "ta", "tb",
	"tc", "td", "te", "tf", "tg", "th", "ti", "tj", "tk", "tl", "tm", "tn", "to", "tp", "tr", "ts",
	"tt", "tu", "tv", "tw", "tx", "ty", "tz", "ua", "ub", "uc", "ud", "ue", "uf", "ug", "uh", "ui",
	"uj", "uk", "ul", "um", "un", "uo", "up", "uq", "ur", "us", "ut", "uu", "uv", "uw", "ux", "uy",
	"uz", "va", "vb", "vc", "vd", "ve", "vf", "vg", "vh", "vi", "vj", "vk", "vl", "vm", "vn", "vo",
	"vp", "vq", "vr", "vs", "vt", "vu", "vv", "vw", "vx", "vy", "vz", "wa", "wb", "wc", "wd", "we",
	"wf", "wg", "wh", "wi", "wj", "wk", "wl", "wm", "wn", "wo", "wp", "wr", "ws", "wt", "wu", "wv",
	"ww", "wx", "wy", "xa", "xb", "xc", "xd", "xe", "xf", "xh", "xi", "xl", "xm", "xn", "xo", "xp",
	"xr", "xs", "xt", "xu", "xx", "xy", "xz", "ya", "yb", "yc", "yd", "ye", "yf", "yg", "yh", "yi",
	"yj", "yk", "yl", "ym", "yn", "yo", "yp", "yr", "ys", "yt", "yu", "yv", "yw", "yx", "yy", "yz",
	"za", "zb", "zc", "zd", "ze", "zf", "zg", "zh", "zi", "zk", "zl", "zm", "zn", "zo", "zp", "zr",
	"zs", "zt", "zu", "zw", "zx", "zy", "zz",
];

#[inline]
const fn is_js_trim_end_whitespace(unit: u16) -> bool {
	matches!(
		unit,
		0x0009 | 0x000a | 0x000b | 0x000c | 0x000d | 0x0020 | 0x00a0 | 0x1680 | 0x2000
			..=0x200a | 0x2028 | 0x2029 | 0x202f | 0x205f | 0x3000 | 0xfeff
	)
}

#[inline]
fn push_utf8_code_unit(bytes: &mut Vec<u8>, unit: u16) {
	if unit < 0x80 {
		bytes.push(unit as u8);
	} else if unit < 0x800 {
		bytes.push((0xc0 | (unit >> 6)) as u8);
		bytes.push((0x80 | (unit & 0x3f)) as u8);
	} else {
		bytes.push((0xe0 | (unit >> 12)) as u8);
		bytes.push((0x80 | ((unit >> 6) & 0x3f)) as u8);
		bytes.push((0x80 | (unit & 0x3f)) as u8);
	}
}

fn push_js_utf8_without_cr(bytes: &mut Vec<u8>, line: &[u16]) {
	let mut i = 0;
	while i < line.len() {
		let unit = line[i];
		if unit == CR {
			i += 1;
			continue;
		}
		if (0xd800..=0xdbff).contains(&unit) && i + 1 < line.len() {
			let next = line[i + 1];
			if (0xdc00..=0xdfff).contains(&next) {
				let scalar = 0x10000 + ((((unit - 0xd800) as u32) << 10) | ((next - 0xdc00) as u32));
				bytes.push((0xf0 | (scalar >> 18)) as u8);
				bytes.push((0x80 | ((scalar >> 12) & 0x3f)) as u8);
				bytes.push((0x80 | ((scalar >> 6) & 0x3f)) as u8);
				bytes.push((0x80 | (scalar & 0x3f)) as u8);
				i += 2;
				continue;
			}
		}
		if (0xd800..=0xdfff).contains(&unit) {
			bytes.extend_from_slice(&[0xef, 0xbf, 0xbd]);
		} else {
			push_utf8_code_unit(bytes, unit);
		}
		i += 1;
	}
}

#[inline]
fn hash_line(line: &[u16], scratch: &mut Vec<u8>) -> &'static str {
	let mut end = line.len();
	while end > 0 && is_js_trim_end_whitespace(line[end - 1]) {
		end -= 1;
	}
	scratch.clear();
	push_js_utf8_without_cr(scratch, &line[..end]);
	HL_BIGRAMS[(xxh32(scratch, 0) as usize) % HL_BIGRAMS.len()]
}

#[inline]
fn push_decimal(out: &mut Vec<u16>, mut value: u32) {
	let mut buf = [0u16; 10];
	let mut len = 0;
	loop {
		buf[len] = b'0' as u16 + (value % 10) as u16;
		len += 1;
		value /= 10;
		if value == 0 {
			break;
		}
	}
	for digit in buf[..len].iter().rev() {
		out.push(*digit);
	}
}

#[inline]
fn push_hashline(out: &mut Vec<u16>, line_number: u32, line: &[u16], hash_scratch: &mut Vec<u8>) {
	push_decimal(out, line_number);
	let hash = hash_line(line, hash_scratch).as_bytes();
	out.push(hash[0] as u16);
	out.push(hash[1] as u16);
	out.push(HL_BODY_SEP);
	out.extend_from_slice(line);
}

fn build_utf16_string(data: Vec<u16>) -> Utf16String {
	// We construct `data` ourselves and never append a NUL terminator, so any
	// trailing U+0000 here is legitimate JS string content and must be kept.
	// SAFETY: napi-rs represents Utf16String as a Vec<u16> newtype.
	unsafe { std::mem::transmute(data) }
}

#[napi]
pub fn h06_format_hash_lines(text: JsString, start_line: Option<u32>) -> Result<Utf16String> {
	let text_u16 = text.into_utf16()?;
	let mut text = text_u16.as_slice();
	// napi-rs `into_utf16()` exposes `utf16_len() + 1` units with one synthetic
	// trailing NUL. Strip exactly that one terminator; a legitimate trailing
	// U+0000 in the JS string is preserved (matches TS, which hashes/displays it).
	if text.last() == Some(&0) {
		text = &text[..text.len() - 1];
	}
	let mut line_number = start_line.unwrap_or(1);
	let mut line_start = 0usize;
	let mut out = Vec::with_capacity(text.len().saturating_add(12));
	let mut hash_scratch = Vec::with_capacity(256);

	for (index, unit) in text.iter().enumerate() {
		if *unit == LF {
			push_hashline(&mut out, line_number, &text[line_start..index], &mut hash_scratch);
			out.push(LF);
			line_number = line_number.saturating_add(1);
			line_start = index + 1;
		}
	}

	push_hashline(&mut out, line_number, &text[line_start..], &mut hash_scratch);
	Ok(build_utf16_string(out))
}
