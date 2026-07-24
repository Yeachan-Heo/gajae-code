//! Line-level diff — a faithful, byte-identical Rust port of jsdiff v9's
//! `Diff.diffLines(oldStr, newStr)` with default options, used by the edit
//! tool's `generateDiffString`.
//!
//! Parity is achieved by transliterating jsdiff's exact algorithm (the Myers
//! variant in `diff/base.js` plus the line tokenizer in `diff/line.js`) rather
//! than substituting a different diff implementation, so the emitted
//! `{added, removed, value}` parts are identical to jsdiff for any input.
//! A JS-side harness asserts byte-identical output across a corpus.
//!
//! Default options only (matches the call site `Diff.diffLines(a, b)`):
//! no `ignoreWhitespace`, no `ignoreCase`, no `newlineIsToken`,
//! no `stripTrailingCr`, no `oneChangePerToken`, exact `===` token equality.

use napi_derive::napi;

/// One diff component, mirroring jsdiff's change object (sans `count`, which
/// the TS `generateDiffString` formatter does not consume).
#[napi(object)]
pub struct LineDiffPart {
	pub added: bool,
	pub removed: bool,
	pub value: String,
}

/// jsdiff line tokenizer (default options). Returns byte ranges into `value`;
/// each token is a line's content merged with its trailing line separator.
fn tokenize_ranges(value: &str) -> Vec<(usize, usize)> {
	let bytes = value.as_bytes();
	let n = bytes.len();

	// `value.split(/(\n|\r\n)/)`: alternating content/separator segments.
	// `\n` is tried before `\r\n`, so a lone `\n` is a 1-char separator and
	// `\r\n` is a 2-char separator; a bare `\r` is ordinary content.
	let mut split: Vec<(usize, usize)> = Vec::new();
	let mut last = 0usize;
	let mut i = 0usize;
	while i < n {
		let sep_len = if bytes[i] == b'\n' {
			1
		} else if bytes[i] == b'\r' && i + 1 < n && bytes[i + 1] == b'\n' {
			2
		} else {
			0
		};
		if sep_len > 0 {
			split.push((last, i));
			split.push((i, i + sep_len));
			i += sep_len;
			last = i;
		} else {
			i += 1;
		}
	}
	split.push((last, n));

	// Ignore the final empty token if the string ends with a newline.
	if let Some(&(s, e)) = split.last()
		&& s == e
	{
		split.pop();
	}

	// Merge each separator (odd index) into the preceding content token.
	let mut ret: Vec<(usize, usize)> = Vec::with_capacity(split.len());
	for (idx, &(s, e)) in split.iter().enumerate() {
		if idx % 2 == 1 {
			if let Some(last) = ret.last_mut() {
				last.1 = e;
			} else {
				ret.push((s, e));
			}
		} else {
			ret.push((s, e));
		}
	}

	// removeEmpty: drop zero-length tokens.
	ret.retain(|&(s, e)| s != e);
	ret
}

#[derive(Clone, Copy)]
struct PathNode {
	old_pos: isize,
	last: Option<usize>,
}

struct Comp {
	count: usize,
	added: bool,
	removed: bool,
	prev: Option<usize>,
}

/// jsdiff `addToPath` (with `oneChangePerToken` = false).
fn add_to_path(
	comps: &mut Vec<Comp>,
	path: PathNode,
	added: bool,
	removed: bool,
	old_pos_inc: isize,
) -> PathNode {
	let merge = match path.last {
		Some(li) => comps[li].added == added && comps[li].removed == removed,
		None => false,
	};
	let comp = if merge {
		let li = path.last.expect("merge implies a last component");
		Comp { count: comps[li].count + 1, added, removed, prev: comps[li].prev }
	} else {
		Comp { count: 1, added, removed, prev: path.last }
	};
	comps.push(comp);
	PathNode { old_pos: path.old_pos + old_pos_inc, last: Some(comps.len() - 1) }
}

/// jsdiff `extractCommon` (with `oneChangePerToken` = false). Returns newPos.
fn extract_common(
	comps: &mut Vec<Comp>,
	path: &mut PathNode,
	new_toks: &[&str],
	old_toks: &[&str],
	diagonal: isize,
) -> isize {
	let new_len = new_toks.len() as isize;
	let old_len = old_toks.len() as isize;
	let mut old_pos = path.old_pos;
	let mut new_pos = old_pos - diagonal;
	let mut common = 0usize;
	while new_pos + 1 < new_len
		&& old_pos + 1 < old_len
		&& old_toks[(old_pos + 1) as usize] == new_toks[(new_pos + 1) as usize]
	{
		new_pos += 1;
		old_pos += 1;
		common += 1;
	}
	if common > 0 {
		let comp = Comp { count: common, added: false, removed: false, prev: path.last };
		comps.push(comp);
		path.last = Some(comps.len() - 1);
	}
	path.old_pos = old_pos;
	new_pos
}

/// Reconstruct ordered components into parts (jsdiff `buildValues`,
/// `useLongestToken` = false).
fn build_values(
	last: Option<usize>,
	comps: &[Comp],
	old_toks: &[&str],
	new_toks: &[&str],
) -> Vec<LineDiffPart> {
	let mut order: Vec<usize> = Vec::new();
	let mut cur = last;
	while let Some(ci) = cur {
		order.push(ci);
		cur = comps[ci].prev;
	}
	order.reverse();

	let mut parts: Vec<LineDiffPart> = Vec::with_capacity(order.len());
	let mut new_pos = 0usize;
	let mut old_pos = 0usize;
	for &ci in &order {
		let c = &comps[ci];
		let value = if c.removed {
			let v = old_toks[old_pos..old_pos + c.count].concat();
			old_pos += c.count;
			v
		} else {
			let v = new_toks[new_pos..new_pos + c.count].concat();
			new_pos += c.count;
			if !c.added {
				old_pos += c.count;
			}
			v
		};
		parts.push(LineDiffPart { added: c.added, removed: c.removed, value });
	}
	parts
}

/// Faithful port of jsdiff's `Diff.diff` core for line tokens (default opts).
fn diff_tokens(old_toks: &[&str], new_toks: &[&str]) -> Vec<LineDiffPart> {
	let new_len = new_toks.len() as isize;
	let old_len = old_toks.len() as isize;
	let max_edit = new_len + old_len;

	let mut comps: Vec<Comp> = Vec::new();

	// bestPath keyed by (possibly negative) diagonal; offset into a Vec.
	let off = (max_edit + 2) as usize;
	let size = 2 * off + 1;
	let mut best: Vec<Option<PathNode>> = vec![None; size];
	let idx = |d: isize| -> usize { (d + off as isize) as usize };

	// Seed editLength = 0.
	let mut seed = PathNode { old_pos: -1, last: None };
	let new_pos = extract_common(&mut comps, &mut seed, new_toks, old_toks, 0);
	if seed.old_pos + 1 >= old_len && new_pos + 1 >= new_len {
		return build_values(seed.last, &comps, old_toks, new_toks);
	}
	best[idx(0)] = Some(seed);

	let mut min_diag = isize::MIN;
	let mut max_diag = isize::MAX;
	let mut edit_length: isize = 1;
	while edit_length <= max_edit {
		let lo = std::cmp::max(min_diag, -edit_length);
		let hi = std::cmp::min(max_diag, edit_length);
		let mut diag = lo;
		while diag <= hi {
			// jsdiff reads removePath (diag-1) and addPath (diag+1), then clears
			// removePath's slot. `take` reads-and-clears diag-1; diag+1 is peeked.
			let remove_path = best[idx(diag - 1)].take();
			let add_path = best[idx(diag + 1)];

			let can_add = if let Some(ap) = add_path {
				let add_new_pos = ap.old_pos - diag;
				(0..new_len).contains(&add_new_pos)
			} else {
				false
			};
			let can_remove = match remove_path {
				Some(rp) => rp.old_pos + 1 < old_len,
				None => false,
			};

			if !can_add && !can_remove {
				best[idx(diag)] = None;
				diag += 2;
				continue;
			}

			let base_take_from_add = !can_remove
				|| (can_add
					&& remove_path.expect("can_remove implies removePath").old_pos
						< add_path.expect("can_add implies addPath").old_pos);

			let mut base_path = if base_take_from_add {
				add_to_path(&mut comps, add_path.expect("addPath present"), true, false, 0)
			} else {
				add_to_path(&mut comps, remove_path.expect("removePath present"), false, true, 1)
			};

			let new_pos = extract_common(&mut comps, &mut base_path, new_toks, old_toks, diag);

			if base_path.old_pos + 1 >= old_len && new_pos + 1 >= new_len {
				return build_values(base_path.last, &comps, old_toks, new_toks);
			}
			best[idx(diag)] = Some(base_path);
			if base_path.old_pos + 1 >= old_len {
				max_diag = std::cmp::min(max_diag, diag - 1);
			}
			if new_pos + 1 >= new_len {
				min_diag = std::cmp::max(min_diag, diag + 1);
			}
			diag += 2;
		}
		edit_length += 1;
	}

	// Unreachable for finite input (an edit path always exists within max_edit).
	Vec::new()
}

/// Compute a line-level diff byte-identical to jsdiff `Diff.diffLines(old,
/// new)` with default options. Returns ordered `{added, removed, value}` parts.
#[napi]
pub fn diff_lines(old_str: String, new_str: String) -> Vec<LineDiffPart> {
	let old_ranges = tokenize_ranges(&old_str);
	let new_ranges = tokenize_ranges(&new_str);
	let old_toks: Vec<&str> = old_ranges.iter().map(|&(s, e)| &old_str[s..e]).collect();
	let new_toks: Vec<&str> = new_ranges.iter().map(|&(s, e)| &new_str[s..e]).collect();
	diff_tokens(&old_toks, &new_toks)
}
