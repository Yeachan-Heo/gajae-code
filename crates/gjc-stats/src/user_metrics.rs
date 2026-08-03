//! Behavioral metrics extracted from a single user message.
//!
//! Port of `packages/stats/src/user-metrics.ts`. Pure and side-effect free.
//! Two JS regex constructs are rewritten for the Rust `regex` crate and
//! covered by TS-generated parity vectors (`tests/fixtures`):
//! - `XML_TAG_PAIR_RE` used a backreference; here a manual open/close scan
//! - `BLAME_STOP_RE` used a lookbehind; here the sentence boundary is
//!   consumed by the match (counting semantics are unchanged)

use std::sync::LazyLock;

use regex::Regex;

/// Metrics for one user message (mirrors the TS `UserMessageMetrics`).
#[derive(Clone, Copy, PartialEq, Eq, Debug, Default)]
pub struct UserMessageMetrics {
	pub chars: usize,
	pub words: usize,
	pub yelling: usize,
	pub profanity: usize,
	pub anguish: usize,
	pub negation: usize,
	pub repetition: usize,
	pub blame: usize,
}

const PROFANITY: &[&str] = &[
	// f-word family
	"fuck",
	"fucks",
	"fucked",
	"fucking",
	"fuckin",
	"fucker",
	"fuckers",
	"fuckup",
	"fuckups",
	"fuckhead",
	"fuckheads",
	"fuckface",
	"fuckwit",
	"fuckwits",
	"fucktard",
	"fuckery",
	"fuckoff",
	"motherfucker",
	"motherfuckers",
	"motherfucking",
	"clusterfuck",
	"ratfuck",
	"unfuck",
	// censored / euphemistic f-word
	"fk",
	"fks",
	"fking",
	"fkin",
	"fker",
	"fck",
	"fcks",
	"fcking",
	"fckin",
	"fcker",
	"fuk",
	"fuking",
	"fukin",
	"eff",
	"effs",
	"effed",
	"effing",
	"frick",
	"fricks",
	"fricked",
	"fricking",
	"frickin",
	"freaking",
	"freakin",
	"freaked",
	// s-word family
	"shit",
	"shits",
	"shat",
	"shitty",
	"shittier",
	"shittiest",
	"shite",
	"shites",
	"shited",
	"shitting",
	"shitter",
	"shitters",
	"shithead",
	"shitheads",
	"shitshow",
	"shitstorm",
	"shitstain",
	"shitfaced",
	"shitload",
	"shitbag",
	"shitcan",
	"shitcanned",
	"shitpost",
	"shitposting",
	"bullshit",
	"bullshits",
	"bullshitting",
	"bullshitter",
	"horseshit",
	"batshit",
	"dogshit",
	"dipshit",
	"jackshit",
	"dumbshit",
	"holyshit",
	// mild swears
	"damn",
	"damns",
	"damned",
	"damning",
	"dammit",
	"goddamn",
	"goddamned",
	"goddamnit",
	"goddammit",
	"darn",
	"darns",
	"darned",
	"darnit",
	"dang",
	"danged",
	"dangit",
	"hell",
	"hells",
	"heck",
	"hecks",
	"heckin",
	"gosh",
	"blast",
	"blasted",
	"bloody",
	"bollocks",
	"bollox",
	// crap family
	"crap",
	"craps",
	"crappy",
	"crappier",
	"crappiest",
	"crapped",
	"crapping",
	"crapload",
	"crapshoot",
	"crapola",
	// piss family
	"piss",
	"pisses",
	"pissed",
	"pissing",
	"pisser",
	"pisspoor",
	"pisstake",
	"pisshead",
	// ass family
	"ass",
	"asses",
	"asshole",
	"assholes",
	"asshat",
	"asshats",
	"asswipe",
	"asswipes",
	"assclown",
	"assbag",
	"asskisser",
	"dumbass",
	"dumbasses",
	"jackass",
	"jackasses",
	"smartass",
	"smartasses",
	"badass",
	"badasses",
	"lazyass",
	"fatass",
	"hardass",
	"halfass",
	"halfassed",
	"arse",
	"arsed",
	"arsehole",
	"arseholes",
	"arsewipe",
	// bitch family
	"bitch",
	"bitches",
	"bitched",
	"bitching",
	"bitchy",
	"bitchier",
	"bitchiest",
	"sonofabitch",
	"biatch",
	"biotch",
	// strong vulgarity
	"cunt",
	"cunts",
	"cunty",
	"cuntish",
	"twat",
	"twats",
	"twatty",
	"bastard",
	"bastards",
	// body-part insults
	"dick",
	"dicks",
	"dickhead",
	"dickheads",
	"dickish",
	"dickwad",
	"dickwads",
	"dickface",
	"dickbag",
	"prick",
	"pricks",
	"prickish",
	"cock",
	"cocks",
	"cocky",
	"cockier",
	"cockiest",
	"cockhead",
	"cockblock",
	"cocksucker",
	"cocksuckers",
	"knob",
	"knobhead",
	"knobheads",
	"knobend",
	"wanker",
	"wankers",
	"wankery",
	"tosser",
	"tossers",
	"jerkoff",
	"jerkoffs",
	"douche",
	"douches",
	"douchebag",
	"douchebags",
	"douchey",
	"scumbag",
	"scumbags",
	"scum",
	"sleazebag",
	"sleazeball",
	"slimeball",
	"lowlife",
	"lowlifes",
	"deadbeat",
	// intelligence-based insults
	"idiot",
	"idiots",
	"idiotic",
	"idiocy",
	"stupid",
	"stupider",
	"stupidest",
	"stupidity",
	"moron",
	"morons",
	"moronic",
	"imbecile",
	"imbeciles",
	"retard",
	"retards",
	"retarded",
	"dumb",
	"dumber",
	"dumbest",
	"dumbo",
	"dummy",
	"dummies",
	"fool",
	"fools",
	"foolish",
	"foolery",
	"clown",
	"clowns",
	"clownish",
	"buffoon",
	"buffoons",
	"simpleton",
	"halfwit",
	"halfwits",
	"nitwit",
	"nitwits",
	"dimwit",
	"dimwits",
	"dolt",
	"dolts",
	"doltish",
	"knucklehead",
	"knuckleheads",
	"blockhead",
	"blockheads",
	"lamebrain",
	"airhead",
	"airheads",
	"scatterbrain",
	"numbnuts",
	"numbskull",
	"numpty",
	"numpties",
	"muppet",
	"muppets",
	"pillock",
	"pillocks",
	"plonker",
	"plonkers",
	"prat",
	"prats",
	"berk",
	"berks",
	"ninny",
	"ninnies",
	"dingbat",
	"dingbats",
	"putz",
	"putzes",
	"schmuck",
	"schmucks",
	"jerk",
	"jerks",
	"jerkface",
	"git",
	"gits",
	"sod",
	"sodding",
	"bugger",
	"buggered",
	// generic aggression / dismissal
	"hate",
	"hated",
	"hates",
	"hating",
	"hateful",
	"suck",
	"sucks",
	"sucked",
	"sucking",
	"sucky",
	"suckage",
	"trash",
	"trashy",
	"trashed",
	"garbage",
	"crud",
	"crudded",
	// quality-dismissal
	"useless",
	"pointless",
	"horrible",
	"awful",
	"worthless",
	"ridiculous",
	"nonsense",
	// religious exclamations
	"jesus",
	"christ",
	"jeez",
	"jeezus",
	"sheesh",
	"godsake",
	// chat acronyms
	"wtf",
	"wth",
	"wtaf",
	"stfu",
	"gtfo",
	"omfg",
	"omg",
	"ffs",
	"jfc",
	"kys",
	"fml",
	"smh",
	"smdh",
	"smfh",
	"idgaf",
	"idfc",
	"lmfao",
	"fubar",
	"snafu",
	// frustration interjections
	"ugh",
	"ughh",
	"ughhh",
	"urgh",
	"argh",
	"arghh",
	"arghhh",
	"arrgh",
	"blah",
	"bleh",
	"meh",
	"yikes",
	"yeesh",
	"oof",
	"gah",
	"gahh",
	"grr",
	"grrr",
	"grrrr",
];

const ANGUISH_PATTERNS: &[&str] = &[
	"no{3,}",
	"a+h{2,}",
	"u+g+h{2,}",
	"a+r+g+h+",
	"st+o{3,}p+",
	"w+h+y{3,}",
	"f+u{3,}c*k*",
	"wtf{3,}",
	"o+m+g{2,}",
	"ye+s{3,}",
	"g+o+d{3,}",
	"br+u+h{2,}",
];

const YELLING_MIN_LETTERS: usize = 4;
const YELLING_THRESHOLD: f64 = 0.5;
const MAX_PROSE_LINES: usize = 3;

macro_rules! re {
	($name:ident, $pattern:expr) => {
		static $name: LazyLock<Regex> =
			LazyLock::new(|| Regex::new($pattern).expect("valid pattern"));
	};
}

re!(SENTENCE_RE, r"[^.!?\n]+");
re!(LETTER_RE, r"\p{L}");
re!(UPPER_LETTER_RE, r"\p{Lu}");
re!(DRAMA_RE, r"[!?][!?1]{2,}");
re!(WORD_RE, r"\S+");
re!(DUDE_RE, r"(?i)\bdude\b");
re!(ELLIPSIS_RE, r"\.{2,}");
re!(NEGATION_LEAD_RE, r"(?i)^[ \t]*(?:no|nope|nah|nvm|wrong|incorrect)\b");
re!(
	NEGATION_PHRASE_RE,
	r"(?i)\b(?:that['\u2019]?s\s+not\s+(?:what|right|it)|not\s+what\s+i\s+(?:meant|asked|said|wanted))\b"
);
re!(
	REPETITION_RECALL_RE,
	r"(?i)\b(?:(?:like|as)\s+i\s+(?:said|told\s+you|asked)|i\s+(?:meant|said|told\s+you|asked\s+you|already\s+(?:said|told|did|asked|wrote)))\b"
);
re!(
	REPETITION_STILL_RE,
	r"(?i)\bstill\s+(?:doesn['\u2019]?t|doesnt|isn['\u2019]?t|isnt|not|broken|wrong|fails|failing|the\s+same|same)\b"
);
re!(
	BLAME_YOU_RE,
	r"(?i)\byou\s+(?:didn['\u2019]?t|did\s+not|broke|missed|forgot|keep|always|never|still|ignored)\b"
);
// TS uses a lookbehind for the sentence boundary; consuming it instead
// preserves counting semantics (each imperative still matches once).
re!(BLAME_STOP_RE, r"(?im)(?:^|[.!?\n])\s*stop\s+[0-9A-Za-z_]+ing\b");
re!(FENCED_CODE_RE, r"(?s)```.*?```");
re!(XML_TAG_OPEN_RE, r"<([A-Za-z][\w-]*)\b[^>]*>");
re!(XML_TAG_BARE_RE, r"</?[A-Za-z][\w-]*\b[^>]*/?>");
re!(INLINE_CODE_RE, r"`[^`\n]*`");
re!(URL_RE, r"(?i)\bhttps?://\S+");
re!(FILE_MENTION_RE, r"(^|\s)@[\w./-]+");
re!(QUOTE_LINE_RE, r"(?m)^[ \t]*>.*$");
re!(IMAGE_MARKER_RE, r"\[Image #\d+\]");
re!(ANSI_ESCAPE_RE, r"\x1b\[[0-9;]*[A-Za-z]");

static PROFANITY_RE: LazyLock<Regex> = LazyLock::new(|| {
	Regex::new(&format!(r"(?i)\b(?:{})\b", PROFANITY.join("|"))).expect("valid pattern")
});

static ANGUISH_RE: LazyLock<Regex> = LazyLock::new(|| {
	Regex::new(&format!(r"(?i)\b(?:{})\b", ANGUISH_PATTERNS.join("|"))).expect("valid pattern")
});

fn count_matches(text: &str, re: &Regex) -> usize {
	re.find_iter(text).count()
}

/// Count sentences where uppercase letters exceed the yelling threshold.
fn count_yelling_sentences(text: &str) -> usize {
	SENTENCE_RE
		.find_iter(text)
		.filter(|sentence| {
			let letters = count_matches(sentence.as_str(), &LETTER_RE);
			letters >= YELLING_MIN_LETTERS && {
				let upper = count_matches(sentence.as_str(), &UPPER_LETTER_RE);
				upper as f64 / letters as f64 > YELLING_THRESHOLD
			}
		})
		.count()
}

/// Strip `<tag ...>...</tag>` pairs (TS used a backreference; the manual scan
/// pairs each opening tag with its nearest same-name close, like the
/// non-greedy JS pattern).
fn strip_xml_tag_pairs(text: &str) -> String {
	let mut out = String::with_capacity(text.len());
	let mut rest = text;
	while let Some(open) = XML_TAG_OPEN_RE.captures(rest) {
		let whole = open.get(0).expect("match");
		let name = open.get(1).expect("group").as_str();
		let close_tag = format!("</{name}>");
		let after_open = &rest[whole.end()..];
		if let Some(close_pos) = after_open.find(&close_tag) {
			out.push_str(&rest[..whole.start()]);
			out.push('\n');
			rest = &after_open[close_pos + close_tag.len()..];
		} else {
			// No matching close: keep the opener literally and move past it.
			out.push_str(&rest[..whole.end()]);
			rest = after_open;
		}
	}
	out.push_str(rest);
	out
}

fn strip_structured_content(text: &str) -> String {
	let s = FENCED_CODE_RE.replace_all(text, "\n");
	let s = strip_xml_tag_pairs(&s);
	let s = XML_TAG_BARE_RE.replace_all(&s, " ");
	let s = INLINE_CODE_RE.replace_all(&s, " ");
	let s = URL_RE.replace_all(&s, " ");
	let s = FILE_MENTION_RE.replace_all(&s, "$1 ");
	let s = QUOTE_LINE_RE.replace_all(&s, "");
	let s = IMAGE_MARKER_RE.replace_all(&s, " ");
	ANSI_ESCAPE_RE.replace_all(&s, "").into_owned()
}

fn count_non_empty_lines(text: &str) -> usize {
	text
		.split('\n')
		.filter(|line| !line.trim().is_empty())
		.count()
}

/// Compute behavioral metrics for a user message (TS
/// `computeUserMessageMetrics`). Empty/whitespace input yields all zeros.
pub fn compute_user_message_metrics(text: &str) -> UserMessageMetrics {
	let trimmed = text.trim();
	if trimmed.is_empty() {
		return UserMessageMetrics::default();
	}

	// TS counts UTF-16 code units; chars here counts Unicode scalars, which
	// agrees for all BMP text (astral characters differ by design).
	let chars = trimmed.chars().count();
	let words = count_matches(trimmed, &WORD_RE);

	let prose = strip_structured_content(trimmed);
	let prose = prose.trim();
	if prose.is_empty() || count_non_empty_lines(prose) >= MAX_PROSE_LINES {
		return UserMessageMetrics { chars, words, ..Default::default() };
	}

	let anguish = count_matches(prose, &DRAMA_RE)
		+ count_matches(prose, &ANGUISH_RE)
		+ count_matches(prose, &DUDE_RE)
		+ count_matches(prose, &ELLIPSIS_RE);
	let negation =
		count_matches(prose, &NEGATION_LEAD_RE) + count_matches(prose, &NEGATION_PHRASE_RE);
	let repetition =
		count_matches(prose, &REPETITION_RECALL_RE) + count_matches(prose, &REPETITION_STILL_RE);
	let blame = count_matches(prose, &BLAME_YOU_RE) + count_matches(prose, &BLAME_STOP_RE);

	UserMessageMetrics {
		chars,
		words,
		yelling: count_yelling_sentences(prose),
		profanity: count_matches(prose, &PROFANITY_RE),
		anguish,
		negation,
		repetition,
		blame,
	}
}

#[cfg(test)]
mod tests {
	use super::*;

	#[test]
	fn empty_is_all_zeros() {
		assert_eq!(compute_user_message_metrics(""), UserMessageMetrics::default());
		assert_eq!(compute_user_message_metrics("   \n "), UserMessageMetrics::default());
	}

	#[test]
	fn xml_pair_stripping_matches_non_greedy_semantics() {
		let stripped = strip_xml_tag_pairs("a <b>inner</b> c <d attr=\"x\">y</d> e");
		assert_eq!(stripped, "a \n c \n e");
		// Unclosed tag survives literally.
		let stripped = strip_xml_tag_pairs("keep <open> this");
		assert_eq!(stripped, "keep <open> this");
	}
}
