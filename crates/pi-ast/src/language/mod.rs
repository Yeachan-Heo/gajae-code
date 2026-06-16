//! Vendored and extended language definitions for ast-grep integration.
//!
//! Originally derived from `ast-grep-language` v0.39.9, stripped of
//! serde/ignore machinery, and extended with additional languages.

mod parsers;

use std::{borrow::Cow, collections::HashMap, fmt, path::Path, sync::LazyLock};

use ast_grep_core::{
	Doc, Language, Node,
	matcher::{KindMatcher, Pattern, PatternBuilder, PatternError},
	meta_var::MetaVariable,
	tree_sitter::{LanguageExt, StrDoc, TSLanguage, TSRange},
};
use phf::phf_map;

/// Implements a stub language (no expando / `pre_process_pattern` needed).
/// Use when the language grammar accepts `$VAR` as valid identifiers.
macro_rules! impl_lang {
	($lang:ident, $func:ident) => {
		#[derive(Clone, Copy, Debug)]
		pub struct $lang;
		impl Language for $lang {
			fn kind_to_id(&self, kind: &str) -> u16 {
				self.get_ts_language().id_for_node_kind(kind, true)
			}

			fn field_to_id(&self, field: &str) -> Option<u16> {
				self
					.get_ts_language()
					.field_id_for_name(field)
					.map(|f| f.get())
			}

			fn build_pattern(&self, builder: &PatternBuilder) -> Result<Pattern, PatternError> {
				builder.build(|src| StrDoc::try_new(src, *self))
			}
		}
		impl LanguageExt for $lang {
			fn get_ts_language(&self) -> TSLanguage {
				parsers::$func().into()
			}
		}
	};
}

fn pre_process_pattern(expando: char, query: &str) -> Cow<'_, str> {
	let mut ret = Vec::with_capacity(query.len());
	let mut dollar_count = 0;
	for c in query.chars() {
		if c == '$' {
			dollar_count += 1;
			continue;
		}
		let need_replace = matches!(c, 'A'..='Z' | '_') || dollar_count == 3;
		let sigil = if need_replace { expando } else { '$' };
		ret.extend(std::iter::repeat_n(sigil, dollar_count));
		dollar_count = 0;
		ret.push(c);
	}
	let sigil = if dollar_count == 3 { expando } else { '$' };
	ret.extend(std::iter::repeat_n(sigil, dollar_count));
	Cow::Owned(ret.into_iter().collect())
}

/// Implements a language with `expando_char` / `pre_process_pattern`.
/// Use when the language does NOT accept `$` as a valid identifier character.
macro_rules! impl_lang_expando {
	($lang:ident, $func:ident, $char:expr) => {
		#[derive(Clone, Copy, Debug)]
		pub struct $lang;
		impl Language for $lang {
			fn kind_to_id(&self, kind: &str) -> u16 {
				self.get_ts_language().id_for_node_kind(kind, true)
			}

			fn field_to_id(&self, field: &str) -> Option<u16> {
				self
					.get_ts_language()
					.field_id_for_name(field)
					.map(|f| f.get())
			}

			fn expando_char(&self) -> char {
				$char
			}

			fn pre_process_pattern<'q>(&self, query: &'q str) -> Cow<'q, str> {
				pre_process_pattern(self.expando_char(), query)
			}

			fn build_pattern(&self, builder: &PatternBuilder) -> Result<Pattern, PatternError> {
				builder.build(|src| StrDoc::try_new(src, *self))
			}
		}
		impl LanguageExt for $lang {
			fn get_ts_language(&self) -> TSLanguage {
				parsers::$func().into()
			}
		}
	};
}

// ── Customized languages with expando_char ──────────────────────────────

impl_lang_expando!(C, language_c, '𐀀');
impl_lang_expando!(Cpp, language_cpp, '𐀀');
impl_lang_expando!(CSharp, language_c_sharp, 'µ');
#[cfg(feature = "full-langs")]
impl_lang_expando!(Cmake, language_cmake, 'µ');
impl_lang_expando!(Css, language_css, '_');
#[cfg(feature = "full-langs")]
impl_lang_expando!(Dockerfile, language_dockerfile, 'µ');
#[cfg(feature = "full-langs")]
impl_lang_expando!(Elixir, language_elixir, 'µ');
#[cfg(feature = "full-langs")]
impl_lang_expando!(Erlang, language_erlang, 'µ');
impl_lang_expando!(Go, language_go, 'µ');
#[cfg(feature = "full-langs")]
impl_lang!(Graphql, language_graphql);
#[cfg(feature = "full-langs")]
impl_lang_expando!(Haskell, language_haskell, 'µ');
#[cfg(feature = "full-langs")]
impl_lang_expando!(Hcl, language_hcl, 'µ');
#[cfg(feature = "full-langs")]
impl_lang_expando!(Ini, language_ini, 'µ');
#[cfg(feature = "full-langs")]
impl_lang_expando!(Just, language_just, 'µ');
#[cfg(feature = "full-langs")]
impl_lang_expando!(Kotlin, language_kotlin, 'µ');
#[cfg(feature = "full-langs")]
impl_lang_expando!(Nix, language_nix, '_');
#[cfg(feature = "full-langs")]
impl_lang_expando!(Ocaml, language_ocaml, 'µ');
#[cfg(feature = "full-langs")]
impl_lang_expando!(Perl, language_perl, 'µ');
impl_lang_expando!(Php, language_php, 'µ');
#[cfg(feature = "full-langs")]
impl_lang_expando!(Powershell, language_powershell, 'µ');
#[cfg(feature = "full-langs")]
impl_lang_expando!(Proto, language_proto, 'µ');
impl_lang_expando!(Python, language_python, 'µ');
#[cfg(feature = "full-langs")]
impl_lang_expando!(R, language_r, 'µ');
impl_lang_expando!(Ruby, language_ruby, 'µ');
impl_lang_expando!(Rust, language_rust, 'µ');
#[cfg(feature = "full-langs")]
impl_lang_expando!(Sql, language_sql, 'µ');
#[cfg(feature = "full-langs")]
impl_lang_expando!(Swift, language_swift, 'µ');

// New expando languages
#[cfg(feature = "full-langs")]
impl_lang_expando!(Make, language_make, 'µ');
#[cfg(feature = "full-langs")]
impl_lang_expando!(ObjC, language_objc, '𐀀');
#[cfg(feature = "full-langs")]
impl_lang_expando!(Starlark, language_starlark, 'µ');
#[cfg(feature = "full-langs")]
impl_lang_expando!(Odin, language_odin, 'µ');
#[cfg(feature = "full-langs")]
impl_lang_expando!(Julia, language_julia, 'µ');
#[cfg(feature = "full-langs")]
impl_lang_expando!(Verilog, language_verilog, 'µ');
#[cfg(feature = "full-langs")]
impl_lang_expando!(Zig, language_zig, 'µ');
#[cfg(feature = "full-langs")]
impl_lang_expando!(Tlaplus, language_tlaplus, 'µ');

// ── Stub languages ($ accepted in grammar) ──────────────────────────────

#[cfg(feature = "full-langs")]
impl_lang!(Astro, language_astro);
impl_lang!(Bash, language_bash);
#[cfg(feature = "full-langs")]
impl_lang!(Clojure, language_clojure);
impl_lang!(Java, language_java);
impl_lang!(JavaScript, language_javascript);
impl_lang!(Json, language_json);
#[cfg(feature = "full-langs")]
impl_lang!(Lua, language_lua);
#[cfg(feature = "full-langs")]
impl_lang!(Scala, language_scala);
#[cfg(feature = "full-langs")]
impl_lang!(Solidity, language_solidity);
#[cfg(feature = "full-langs")]
impl_lang!(Svelte, language_svelte);
impl_lang!(Tsx, language_tsx);
impl_lang!(TypeScript, language_typescript);
#[cfg(feature = "full-langs")]
impl_lang!(Vue, language_vue);
impl_lang!(Yaml, language_yaml);

// New stub languages
impl_lang!(Markdown, language_markdown);
impl_lang!(Toml, language_toml);
#[cfg(feature = "full-langs")]
impl_lang!(Diff, language_diff);
#[cfg(feature = "full-langs")]
impl_lang!(Xml, language_xml);
#[cfg(feature = "full-langs")]
impl_lang!(Regex, language_regex);
#[cfg(feature = "full-langs")]
impl_lang!(Dart, language_dart);

// ── Html (custom implementation with injection support) ──────────────────

#[derive(Clone, Copy, Debug)]
pub struct Html;

impl Language for Html {
	fn expando_char(&self) -> char {
		'z'
	}

	fn pre_process_pattern<'q>(&self, query: &'q str) -> Cow<'q, str> {
		pre_process_pattern(self.expando_char(), query)
	}

	fn kind_to_id(&self, kind: &str) -> u16 {
		self.get_ts_language().id_for_node_kind(kind, true)
	}

	fn field_to_id(&self, field: &str) -> Option<u16> {
		self
			.get_ts_language()
			.field_id_for_name(field)
			.map(|f| f.get())
	}

	fn build_pattern(&self, builder: &PatternBuilder) -> Result<Pattern, PatternError> {
		builder.build(|src| StrDoc::try_new(src, *self))
	}
}

impl LanguageExt for Html {
	fn get_ts_language(&self) -> TSLanguage {
		parsers::language_html()
	}

	fn injectable_languages(&self) -> Option<&'static [&'static str]> {
		Some(&["css", "js", "ts", "tsx", "scss", "less", "stylus", "coffee"])
	}

	fn extract_injections<L: LanguageExt>(
		&self,
		root: Node<StrDoc<L>>,
	) -> HashMap<String, Vec<TSRange>> {
		let lang = root.lang();
		let mut map = HashMap::new();
		let matcher = KindMatcher::new("script_element", lang.clone());
		for script in root.find_all(matcher) {
			let injected = find_html_lang(&script).unwrap_or_else(|| "js".into());
			let content = script.children().find(|c| c.kind() == "raw_text");
			if let Some(content) = content {
				map.entry(injected)
					.or_insert_with(Vec::new)
					.push(node_to_range(&content));
			}
		}
		let matcher = KindMatcher::new("style_element", lang.clone());
		for style in root.find_all(matcher) {
			let injected = find_html_lang(&style).unwrap_or_else(|| "css".into());
			let content = style.children().find(|c| c.kind() == "raw_text");
			if let Some(content) = content {
				map.entry(injected)
					.or_insert_with(Vec::new)
					.push(node_to_range(&content));
			}
		}
		map
	}
}

fn find_html_lang<D: Doc>(node: &Node<D>) -> Option<String> {
	let html = node.lang();
	let attr_matcher = KindMatcher::new("attribute", html.clone());
	let name_matcher = KindMatcher::new("attribute_name", html.clone());
	let val_matcher = KindMatcher::new("attribute_value", html.clone());
	node.find_all(attr_matcher).find_map(|attr| {
		let name = attr.find(&name_matcher)?;
		if name.text() != "lang" {
			return None;
		}
		let val = attr.find(&val_matcher)?;
		Some(val.text().to_string())
	})
}

fn node_to_range<D: Doc>(node: &Node<D>) -> TSRange {
	let r = node.range();
	let start = node.start_pos();
	let sp = start.byte_point();
	let sp = tree_sitter::Point::new(sp.0, sp.1);
	let end = node.end_pos();
	let ep = end.byte_point();
	let ep = tree_sitter::Point::new(ep.0, ep.1);
	TSRange { start_byte: r.start, end_byte: r.end, start_point: sp, end_point: ep }
}

// ── SupportLang enum ────────────────────────────────────────────────────

/// All supported languages for ast-grep structural search/replace.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum SupportLang {
	#[cfg(feature = "full-langs")]
	Astro,
	Bash,
	C,
	#[cfg(feature = "full-langs")]
	Cmake,
	Cpp,
	CSharp,
	#[cfg(feature = "full-langs")]
	Dart,
	#[cfg(feature = "full-langs")]
	Clojure,
	Css,
	#[cfg(feature = "full-langs")]
	Diff,
	#[cfg(feature = "full-langs")]
	Dockerfile,
	#[cfg(feature = "full-langs")]
	Elixir,
	#[cfg(feature = "full-langs")]
	Erlang,
	Go,
	#[cfg(feature = "full-langs")]
	Graphql,
	#[cfg(feature = "full-langs")]
	Haskell,
	#[cfg(feature = "full-langs")]
	Hcl,
	Html,
	#[cfg(feature = "full-langs")]
	Ini,
	Java,
	JavaScript,
	Json,
	#[cfg(feature = "full-langs")]
	Just,
	#[cfg(feature = "full-langs")]
	Julia,
	#[cfg(feature = "full-langs")]
	Kotlin,
	#[cfg(feature = "full-langs")]
	Lua,
	#[cfg(feature = "full-langs")]
	Make,
	Markdown,
	#[cfg(feature = "full-langs")]
	Nix,
	#[cfg(feature = "full-langs")]
	ObjC,
	#[cfg(feature = "full-langs")]
	Ocaml,
	#[cfg(feature = "full-langs")]
	Odin,
	#[cfg(feature = "full-langs")]
	Perl,
	Php,
	#[cfg(feature = "full-langs")]
	Powershell,
	#[cfg(feature = "full-langs")]
	Proto,
	Python,
	#[cfg(feature = "full-langs")]
	R,
	#[cfg(feature = "full-langs")]
	Regex,
	Ruby,
	Rust,
	#[cfg(feature = "full-langs")]
	Scala,
	#[cfg(feature = "full-langs")]
	Solidity,
	#[cfg(feature = "full-langs")]
	Sql,
	#[cfg(feature = "full-langs")]
	Starlark,
	#[cfg(feature = "full-langs")]
	Svelte,
	#[cfg(feature = "full-langs")]
	Swift,
	Toml,
	#[cfg(feature = "full-langs")]
	Tlaplus,
	Tsx,
	TypeScript,
	#[cfg(feature = "full-langs")]
	Verilog,
	#[cfg(feature = "full-langs")]
	Vue,
	#[cfg(feature = "full-langs")]
	Xml,
	Yaml,
	#[cfg(feature = "full-langs")]
	Zig,
}

#[cfg(not(feature = "full-langs"))]
const ALL_LANGS_DEFAULT: [SupportLang; 19] = [
	SupportLang::TypeScript,
	SupportLang::Tsx,
	SupportLang::JavaScript,
	SupportLang::Python,
	SupportLang::Rust,
	SupportLang::Go,
	SupportLang::Java,
	SupportLang::C,
	SupportLang::Cpp,
	SupportLang::CSharp,
	SupportLang::Ruby,
	SupportLang::Php,
	SupportLang::Bash,
	SupportLang::Json,
	SupportLang::Yaml,
	SupportLang::Toml,
	SupportLang::Markdown,
	SupportLang::Html,
	SupportLang::Css,
];

#[cfg(feature = "full-langs")]
const ALL_LANGS_FULL: [SupportLang; 56] = [
	SupportLang::Astro,
	SupportLang::Bash,
	SupportLang::C,
	SupportLang::Cmake,
	SupportLang::Cpp,
	SupportLang::CSharp,
	SupportLang::Dart,
	SupportLang::Clojure,
	SupportLang::Css,
	SupportLang::Diff,
	SupportLang::Dockerfile,
	SupportLang::Elixir,
	SupportLang::Erlang,
	SupportLang::Go,
	SupportLang::Graphql,
	SupportLang::Haskell,
	SupportLang::Hcl,
	SupportLang::Html,
	SupportLang::Ini,
	SupportLang::Java,
	SupportLang::JavaScript,
	SupportLang::Json,
	SupportLang::Just,
	SupportLang::Julia,
	SupportLang::Kotlin,
	SupportLang::Lua,
	SupportLang::Make,
	SupportLang::Markdown,
	SupportLang::Nix,
	SupportLang::ObjC,
	SupportLang::Ocaml,
	SupportLang::Odin,
	SupportLang::Perl,
	SupportLang::Php,
	SupportLang::Powershell,
	SupportLang::Proto,
	SupportLang::Python,
	SupportLang::R,
	SupportLang::Regex,
	SupportLang::Ruby,
	SupportLang::Rust,
	SupportLang::Scala,
	SupportLang::Solidity,
	SupportLang::Sql,
	SupportLang::Starlark,
	SupportLang::Svelte,
	SupportLang::Swift,
	SupportLang::Toml,
	SupportLang::Tlaplus,
	SupportLang::Tsx,
	SupportLang::TypeScript,
	SupportLang::Verilog,
	SupportLang::Vue,
	SupportLang::Xml,
	SupportLang::Yaml,
	SupportLang::Zig,
];

static SORTED_ALIASES: LazyLock<Box<[&'static str]>> = LazyLock::new(|| {
	let aliases = CORE_LANG_ALIASES.keys().copied().collect::<Vec<_>>();
	#[cfg(feature = "full-langs")]
	let mut aliases = aliases;
	#[cfg(feature = "full-langs")]
	aliases.extend(LONG_TAIL_LANG_ALIASES.keys().copied());
	let mut aliases = aliases.into_boxed_slice();
	aliases.sort_unstable();
	aliases
});

impl SupportLang {
	pub const fn all_langs() -> &'static [Self] {
		#[cfg(feature = "full-langs")]
		{
			&ALL_LANGS_FULL
		}
		#[cfg(not(feature = "full-langs"))]
		{
			&ALL_LANGS_DEFAULT
		}
	}

	/// The canonical lowercase name used as a stable key in alias maps,
	/// file-type inference results, and error messages.
	pub const fn canonical_name(self) -> &'static str {
		match self {
			#[cfg(feature = "full-langs")]
			Self::Astro => "astro",
			Self::Bash => "bash",
			Self::C => "c",
			#[cfg(feature = "full-langs")]
			Self::Cmake => "cmake",
			Self::Cpp => "cpp",
			Self::CSharp => "csharp",
			#[cfg(feature = "full-langs")]
			Self::Dart => "dart",
			#[cfg(feature = "full-langs")]
			Self::Clojure => "clojure",
			Self::Css => "css",
			#[cfg(feature = "full-langs")]
			Self::Diff => "diff",
			#[cfg(feature = "full-langs")]
			Self::Dockerfile => "dockerfile",
			#[cfg(feature = "full-langs")]
			Self::Elixir => "elixir",
			#[cfg(feature = "full-langs")]
			Self::Erlang => "erlang",
			Self::Go => "go",
			#[cfg(feature = "full-langs")]
			Self::Graphql => "graphql",
			#[cfg(feature = "full-langs")]
			Self::Haskell => "haskell",
			#[cfg(feature = "full-langs")]
			Self::Hcl => "hcl",
			Self::Html => "html",
			#[cfg(feature = "full-langs")]
			Self::Ini => "ini",
			Self::Java => "java",
			Self::JavaScript => "javascript",
			Self::Json => "json",
			#[cfg(feature = "full-langs")]
			Self::Just => "just",
			#[cfg(feature = "full-langs")]
			Self::Julia => "julia",
			#[cfg(feature = "full-langs")]
			Self::Kotlin => "kotlin",
			#[cfg(feature = "full-langs")]
			Self::Lua => "lua",
			#[cfg(feature = "full-langs")]
			Self::Make => "make",
			Self::Markdown => "markdown",
			#[cfg(feature = "full-langs")]
			Self::Nix => "nix",
			#[cfg(feature = "full-langs")]
			Self::ObjC => "objc",
			#[cfg(feature = "full-langs")]
			Self::Ocaml => "ocaml",
			#[cfg(feature = "full-langs")]
			Self::Odin => "odin",
			#[cfg(feature = "full-langs")]
			Self::Perl => "perl",
			Self::Php => "php",
			#[cfg(feature = "full-langs")]
			Self::Powershell => "powershell",
			#[cfg(feature = "full-langs")]
			Self::Proto => "protobuf",
			Self::Python => "python",
			#[cfg(feature = "full-langs")]
			Self::R => "r",
			#[cfg(feature = "full-langs")]
			Self::Regex => "regex",
			Self::Ruby => "ruby",
			Self::Rust => "rust",
			#[cfg(feature = "full-langs")]
			Self::Scala => "scala",
			#[cfg(feature = "full-langs")]
			Self::Solidity => "solidity",
			#[cfg(feature = "full-langs")]
			Self::Sql => "sql",
			#[cfg(feature = "full-langs")]
			Self::Starlark => "starlark",
			#[cfg(feature = "full-langs")]
			Self::Svelte => "svelte",
			#[cfg(feature = "full-langs")]
			Self::Swift => "swift",
			Self::Toml => "toml",
			#[cfg(feature = "full-langs")]
			Self::Tlaplus => "tlaplus",
			Self::Tsx => "tsx",
			Self::TypeScript => "typescript",
			#[cfg(feature = "full-langs")]
			Self::Verilog => "verilog",
			#[cfg(feature = "full-langs")]
			Self::Vue => "vue",
			#[cfg(feature = "full-langs")]
			Self::Xml => "xml",
			Self::Yaml => "yaml",
			#[cfg(feature = "full-langs")]
			Self::Zig => "zig",
		}
	}

	pub fn from_alias(value: &str) -> Option<Self> {
		let lowered = value.trim().to_ascii_lowercase();
		let core = CORE_LANG_ALIASES.get(lowered.as_str()).copied();
		#[cfg(feature = "full-langs")]
		{
			core.or_else(|| LONG_TAIL_LANG_ALIASES.get(lowered.as_str()).copied())
		}
		#[cfg(not(feature = "full-langs"))]
		{
			core
		}
	}

	pub fn from_path(path: &Path) -> Option<Self> {
		from_extension(path)
	}

	pub fn sorted_aliases() -> &'static [&'static str] {
		&SORTED_ALIASES
	}
}

impl fmt::Display for SupportLang {
	fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
		write!(f, "{self:?}")
	}
}

// ── Dispatch macro ──────────────────────────────────────────────────────

macro_rules! execute_lang_method {
	($me:expr, $method:ident, $($pname:tt),*) => {
		use SupportLang as S;
		match *$me {
			#[cfg(feature = "full-langs")]
			S::Astro => Astro.$method($($pname,)*),
			S::Bash => Bash.$method($($pname,)*),
			S::C => C.$method($($pname,)*),
			#[cfg(feature = "full-langs")]
			S::Cmake => Cmake.$method($($pname,)*),
			S::Cpp => Cpp.$method($($pname,)*),
			S::CSharp => CSharp.$method($($pname,)*),
			#[cfg(feature = "full-langs")]
			S::Dart => Dart.$method($($pname,)*),
			#[cfg(feature = "full-langs")]
			S::Clojure => Clojure.$method($($pname,)*),
			S::Css => Css.$method($($pname,)*),
			#[cfg(feature = "full-langs")]
			S::Diff => Diff.$method($($pname,)*),
			#[cfg(feature = "full-langs")]
			S::Dockerfile => Dockerfile.$method($($pname,)*),
			#[cfg(feature = "full-langs")]
			S::Elixir => Elixir.$method($($pname,)*),
			#[cfg(feature = "full-langs")]
			S::Erlang => Erlang.$method($($pname,)*),
			S::Go => Go.$method($($pname,)*),
			#[cfg(feature = "full-langs")]
			S::Graphql => Graphql.$method($($pname,)*),
			#[cfg(feature = "full-langs")]
			S::Haskell => Haskell.$method($($pname,)*),
			#[cfg(feature = "full-langs")]
			S::Hcl => Hcl.$method($($pname,)*),
			S::Html => Html.$method($($pname,)*),
			#[cfg(feature = "full-langs")]
			S::Ini => Ini.$method($($pname,)*),
			S::Java => Java.$method($($pname,)*),
			S::JavaScript => JavaScript.$method($($pname,)*),
			S::Json => Json.$method($($pname,)*),
			#[cfg(feature = "full-langs")]
			S::Just => Just.$method($($pname,)*),
			#[cfg(feature = "full-langs")]
			S::Julia => Julia.$method($($pname,)*),
			#[cfg(feature = "full-langs")]
			S::Kotlin => Kotlin.$method($($pname,)*),
			#[cfg(feature = "full-langs")]
			S::Lua => Lua.$method($($pname,)*),
			#[cfg(feature = "full-langs")]
			S::Make => Make.$method($($pname,)*),
			S::Markdown => Markdown.$method($($pname,)*),
			#[cfg(feature = "full-langs")]
			S::Nix => Nix.$method($($pname,)*),
			#[cfg(feature = "full-langs")]
			S::ObjC => ObjC.$method($($pname,)*),
			#[cfg(feature = "full-langs")]
			S::Ocaml => Ocaml.$method($($pname,)*),
			#[cfg(feature = "full-langs")]
			S::Odin => Odin.$method($($pname,)*),
			#[cfg(feature = "full-langs")]
			S::Perl => Perl.$method($($pname,)*),
			S::Php => Php.$method($($pname,)*),
			#[cfg(feature = "full-langs")]
			S::Powershell => Powershell.$method($($pname,)*),
			#[cfg(feature = "full-langs")]
			S::Proto => Proto.$method($($pname,)*),
			S::Python => Python.$method($($pname,)*),
			#[cfg(feature = "full-langs")]
			S::R => R.$method($($pname,)*),
			#[cfg(feature = "full-langs")]
			S::Regex => Regex.$method($($pname,)*),
			S::Ruby => Ruby.$method($($pname,)*),
			S::Rust => Rust.$method($($pname,)*),
			#[cfg(feature = "full-langs")]
			S::Scala => Scala.$method($($pname,)*),
			#[cfg(feature = "full-langs")]
			S::Solidity => Solidity.$method($($pname,)*),
			#[cfg(feature = "full-langs")]
			S::Sql => Sql.$method($($pname,)*),
			#[cfg(feature = "full-langs")]
			S::Starlark => Starlark.$method($($pname,)*),
			#[cfg(feature = "full-langs")]
			S::Svelte => Svelte.$method($($pname,)*),
			#[cfg(feature = "full-langs")]
			S::Swift => Swift.$method($($pname,)*),
			S::Toml => Toml.$method($($pname,)*),
			#[cfg(feature = "full-langs")]
			S::Tlaplus => Tlaplus.$method($($pname,)*),
			S::Tsx => Tsx.$method($($pname,)*),
			S::TypeScript => TypeScript.$method($($pname,)*),
			#[cfg(feature = "full-langs")]
			S::Verilog => Verilog.$method($($pname,)*),
			#[cfg(feature = "full-langs")]
			S::Vue => Vue.$method($($pname,)*),
			#[cfg(feature = "full-langs")]
			S::Xml => Xml.$method($($pname,)*),
			S::Yaml => Yaml.$method($($pname,)*),
			#[cfg(feature = "full-langs")]
			S::Zig => Zig.$method($($pname,)*),
		}
	};
}

macro_rules! impl_lang_method {
	($method:ident, ($($pname:tt: $ptype:ty),*) => $return_type:ty) => {
		#[inline]
		fn $method(&self, $($pname: $ptype),*) -> $return_type {
			execute_lang_method! { self, $method, $($pname),* }
		}
	};
}

impl Language for SupportLang {
	impl_lang_method!(kind_to_id, (kind: &str) => u16);

	impl_lang_method!(field_to_id, (field: &str) => Option<u16>);

	impl_lang_method!(meta_var_char, () => char);

	impl_lang_method!(expando_char, () => char);

	impl_lang_method!(extract_meta_var, (source: &str) => Option<MetaVariable>);

	impl_lang_method!(build_pattern, (builder: &PatternBuilder) => Result<Pattern, PatternError>);

	fn pre_process_pattern<'q>(&self, query: &'q str) -> Cow<'q, str> {
		execute_lang_method! { self, pre_process_pattern, query }
	}

	fn from_path<P: AsRef<Path>>(path: P) -> Option<Self> {
		from_extension(path.as_ref())
	}
}

impl LanguageExt for SupportLang {
	impl_lang_method!(get_ts_language, () => TSLanguage);

	impl_lang_method!(injectable_languages, () => Option<&'static [&'static str]>);

	fn extract_injections<L: LanguageExt>(
		&self,
		root: Node<StrDoc<L>>,
	) -> HashMap<String, Vec<TSRange>> {
		match self {
			Self::Html => Html.extract_injections(root),
			_ => HashMap::new(),
		}
	}
}

// ── File extension mapping ──────────────────────────────────────────────

const fn extensions(lang: SupportLang) -> &'static [&'static str] {
	use SupportLang::*;
	match lang {
		#[cfg(feature = "full-langs")]
		Astro => &["astro"],
		Bash => {
			&["bash", "bats", "cgi", "command", "env", "fcgi", "ksh", "sh", "tmux", "tool", "zsh"]
		},
		C => &["c", "h"],
		#[cfg(feature = "full-langs")]
		Cmake => &["cmake"],
		Cpp => &["cc", "hpp", "cpp", "c++", "hh", "cxx", "cu", "ino"],
		CSharp => &["cs"],
		#[cfg(feature = "full-langs")]
		Dart => &["dart"],
		#[cfg(feature = "full-langs")]
		Clojure => &["clj", "cljs", "cljc", "edn"],
		Css => &["css", "scss"],
		#[cfg(feature = "full-langs")]
		Diff => &["diff", "patch"],
		#[cfg(feature = "full-langs")]
		Dockerfile => &["dockerfile"],
		#[cfg(feature = "full-langs")]
		Elixir => &["ex", "exs"],
		#[cfg(feature = "full-langs")]
		Erlang => &["erl", "hrl"],
		Go => &["go"],
		#[cfg(feature = "full-langs")]
		Graphql => &["graphql", "gql"],
		#[cfg(feature = "full-langs")]
		Haskell => &["hs"],
		#[cfg(feature = "full-langs")]
		Hcl => &["hcl", "tf", "tfvars"],
		Html => &["html", "htm", "xhtml"],
		#[cfg(feature = "full-langs")]
		Ini => &["ini", "cfg", "conf", "properties"],
		Java => &["java"],
		JavaScript => &["cjs", "js", "mjs", "jsx"],
		Json => &["json"],
		#[cfg(feature = "full-langs")]
		Just => &[],
		#[cfg(feature = "full-langs")]
		Julia => &["jl"],
		#[cfg(feature = "full-langs")]
		Kotlin => &["kt", "ktm", "kts"],
		#[cfg(feature = "full-langs")]
		Lua => &["lua"],
		#[cfg(feature = "full-langs")]
		Make => &["mk", "mak"],
		Markdown => &["md", "markdown", "mdx"],
		#[cfg(feature = "full-langs")]
		Nix => &["nix"],
		#[cfg(feature = "full-langs")]
		ObjC => &["m"],
		#[cfg(feature = "full-langs")]
		Ocaml => &["ml"],
		#[cfg(feature = "full-langs")]
		Odin => &["odin"],
		#[cfg(feature = "full-langs")]
		Perl => &["pl", "pm"],
		Php => &["php"],
		#[cfg(feature = "full-langs")]
		Powershell => &["ps1", "psm1"],
		#[cfg(feature = "full-langs")]
		Proto => &["proto"],
		Python => &["py", "py3", "pyi"],
		#[cfg(feature = "full-langs")]
		R => &["r"],
		#[cfg(feature = "full-langs")]
		Regex => &[],
		Ruby => &["rb", "rbw", "gemspec"],
		Rust => &["rs"],
		#[cfg(feature = "full-langs")]
		Scala => &["scala", "sc", "sbt"],
		#[cfg(feature = "full-langs")]
		Solidity => &["sol"],
		#[cfg(feature = "full-langs")]
		Sql => &["sql"],
		#[cfg(feature = "full-langs")]
		Starlark => &["star", "bzl"],
		#[cfg(feature = "full-langs")]
		Svelte => &["svelte"],
		#[cfg(feature = "full-langs")]
		Swift => &["swift"],
		Toml => &["toml"],
		#[cfg(feature = "full-langs")]
		Tlaplus => &["tla"],
		Tsx => &["tsx"],
		TypeScript => &["ts", "cts", "mts"],
		#[cfg(feature = "full-langs")]
		Verilog => &["v", "sv", "svh", "vh"],
		#[cfg(feature = "full-langs")]
		Vue => &["vue"],
		#[cfg(feature = "full-langs")]
		Xml => &["xml", "xsl", "xslt", "svg", "plist"],
		Yaml => &["yaml", "yml"],
		#[cfg(feature = "full-langs")]
		Zig => &["zig"],
	}
}

/// Guess language from file extension.
fn from_extension(path: &Path) -> Option<SupportLang> {
	#[cfg(feature = "full-langs")]
	let name = path.file_name()?.to_str()?;
	#[cfg(feature = "full-langs")]
	if name == "Makefile" || name == "makefile" || name == "GNUmakefile" {
		return Some(SupportLang::Make);
	}
	#[cfg(feature = "full-langs")]
	if name == "Justfile" || name == "justfile" {
		return Some(SupportLang::Just);
	}
	#[cfg(feature = "full-langs")]
	if name == "CMakeLists.txt" {
		return Some(SupportLang::Cmake);
	}
	#[cfg(feature = "full-langs")]
	if name == "Dockerfile"
		|| name == "dockerfile"
		|| name.starts_with("Dockerfile.")
		|| name.starts_with("dockerfile.")
		|| name == "Containerfile"
		|| name == "containerfile"
	{
		return Some(SupportLang::Dockerfile);
	}

	let ext = path.extension()?.to_str()?;
	SupportLang::all_langs()
		.iter()
		.copied()
		.find(|&l| extensions(l).contains(&ext))
}

static CORE_LANG_ALIASES: phf::Map<&'static str, SupportLang> = phf_map! {
"bash"           => SupportLang::Bash,
"sh"             => SupportLang::Bash,
"zsh"            => SupportLang::Bash,
"ksh"            => SupportLang::Bash,
"bats"           => SupportLang::Bash,
"c"              => SupportLang::C,
"h"              => SupportLang::C,
"cpp"            => SupportLang::Cpp,
"c++"            => SupportLang::Cpp,
"cc"             => SupportLang::Cpp,
"cxx"            => SupportLang::Cpp,
"hh"             => SupportLang::Cpp,
"hpp"            => SupportLang::Cpp,
"cu"             => SupportLang::Cpp,
"ino"            => SupportLang::Cpp,
"csharp"         => SupportLang::CSharp,
"c#"             => SupportLang::CSharp,
"cs"             => SupportLang::CSharp,
"css"            => SupportLang::Css,
"go"             => SupportLang::Go,
"golang"         => SupportLang::Go,
"html"           => SupportLang::Html,
"htm"            => SupportLang::Html,
"xhtml"          => SupportLang::Html,
"java"           => SupportLang::Java,
"javascript"     => SupportLang::JavaScript,
"js"             => SupportLang::JavaScript,
"jsx"            => SupportLang::JavaScript,
"mjs"            => SupportLang::JavaScript,
"cjs"            => SupportLang::JavaScript,
"json"           => SupportLang::Json,
"markdown"       => SupportLang::Markdown,
"md"             => SupportLang::Markdown,
"mdx"            => SupportLang::Markdown,
"php"            => SupportLang::Php,
"python"         => SupportLang::Python,
"py"             => SupportLang::Python,
"py3"            => SupportLang::Python,
"pyi"            => SupportLang::Python,
"ruby"           => SupportLang::Ruby,
"rb"             => SupportLang::Ruby,
"rbw"            => SupportLang::Ruby,
"gemspec"        => SupportLang::Ruby,
"rust"           => SupportLang::Rust,
"rs"             => SupportLang::Rust,
"toml"           => SupportLang::Toml,
"tsx"            => SupportLang::Tsx,
"typescript"     => SupportLang::TypeScript,
"ts"             => SupportLang::TypeScript,
"mts"            => SupportLang::TypeScript,
"cts"            => SupportLang::TypeScript,
"yaml"           => SupportLang::Yaml,
"yml"            => SupportLang::Yaml,
};

#[cfg(feature = "full-langs")]
static LONG_TAIL_LANG_ALIASES: phf::Map<&'static str, SupportLang> = phf_map! {
"astro"          => SupportLang::Astro,
"cmake"          => SupportLang::Cmake,
"dart"           => SupportLang::Dart,
"clj"            => SupportLang::Clojure,
"cljc"           => SupportLang::Clojure,
"cljs"           => SupportLang::Clojure,
"clojure"        => SupportLang::Clojure,
"clojurescript"  => SupportLang::Clojure,
"edn"            => SupportLang::Clojure,
"diff"           => SupportLang::Diff,
"patch"          => SupportLang::Diff,
"docker"         => SupportLang::Dockerfile,
"dockerfile"     => SupportLang::Dockerfile,
"containerfile"  => SupportLang::Dockerfile,
"elixir"         => SupportLang::Elixir,
"ex"             => SupportLang::Elixir,
"exs"            => SupportLang::Elixir,
"erlang"         => SupportLang::Erlang,
"erl"            => SupportLang::Erlang,
"hrl"            => SupportLang::Erlang,
"graphql"        => SupportLang::Graphql,
"gql"            => SupportLang::Graphql,
"haskell"        => SupportLang::Haskell,
"hs"             => SupportLang::Haskell,
"hcl"            => SupportLang::Hcl,
"tf"             => SupportLang::Hcl,
"tfvars"         => SupportLang::Hcl,
"terraform"      => SupportLang::Hcl,
"ini"            => SupportLang::Ini,
"cfg"            => SupportLang::Ini,
"conf"           => SupportLang::Ini,
"config"         => SupportLang::Ini,
"properties"     => SupportLang::Ini,
"just"           => SupportLang::Just,
"justfile"       => SupportLang::Just,
"julia"          => SupportLang::Julia,
"jl"             => SupportLang::Julia,
"kotlin"         => SupportLang::Kotlin,
"kt"             => SupportLang::Kotlin,
"kts"            => SupportLang::Kotlin,
"ktm"            => SupportLang::Kotlin,
"lua"            => SupportLang::Lua,
"make"           => SupportLang::Make,
"makefile"       => SupportLang::Make,
"gnumake"        => SupportLang::Make,
"mk"             => SupportLang::Make,
"mak"            => SupportLang::Make,
"nix"            => SupportLang::Nix,
"objc"           => SupportLang::ObjC,
"obj-c"          => SupportLang::ObjC,
"objective-c"    => SupportLang::ObjC,
"m"              => SupportLang::ObjC,
"mm"             => SupportLang::ObjC,
"ocaml"          => SupportLang::Ocaml,
"ml"             => SupportLang::Ocaml,
"odin"           => SupportLang::Odin,
"perl"           => SupportLang::Perl,
"pl"             => SupportLang::Perl,
"pm"             => SupportLang::Perl,
"powershell"     => SupportLang::Powershell,
"ps1"            => SupportLang::Powershell,
"psm1"           => SupportLang::Powershell,
"protobuf"       => SupportLang::Proto,
"proto"          => SupportLang::Proto,
"r"              => SupportLang::R,
"regex"          => SupportLang::Regex,
"re"             => SupportLang::Regex,
"scala"          => SupportLang::Scala,
"sc"             => SupportLang::Scala,
"sbt"            => SupportLang::Scala,
"solidity"       => SupportLang::Solidity,
"sol"            => SupportLang::Solidity,
"sql"            => SupportLang::Sql,
"starlark"       => SupportLang::Starlark,
"star"           => SupportLang::Starlark,
"bzl"            => SupportLang::Starlark,
"bazel"          => SupportLang::Starlark,
"skylark"        => SupportLang::Starlark,
"svelte"         => SupportLang::Svelte,
"swift"          => SupportLang::Swift,
"tla"            => SupportLang::Tlaplus,
"tla+"           => SupportLang::Tlaplus,
"tlaplus"        => SupportLang::Tlaplus,
"pluscal"        => SupportLang::Tlaplus,
"pcal"           => SupportLang::Tlaplus,
"verilog"        => SupportLang::Verilog,
"systemverilog"  => SupportLang::Verilog,
"sv"             => SupportLang::Verilog,
"svh"            => SupportLang::Verilog,
"vh"             => SupportLang::Verilog,
"v"              => SupportLang::Verilog,
"vue"            => SupportLang::Vue,
"xml"            => SupportLang::Xml,
"xsl"            => SupportLang::Xml,
"xslt"           => SupportLang::Xml,
"svg"            => SupportLang::Xml,
"plist"          => SupportLang::Xml,
"zig"            => SupportLang::Zig,
};

pub const KNOWN_LONG_TAIL_ALIASES: &[&str] = &[
	"astro",
	"cmake",
	"dart",
	"clj",
	"cljc",
	"cljs",
	"clojure",
	"clojurescript",
	"edn",
	"diff",
	"patch",
	"docker",
	"dockerfile",
	"containerfile",
	"elixir",
	"ex",
	"exs",
	"erlang",
	"erl",
	"hrl",
	"graphql",
	"gql",
	"haskell",
	"hs",
	"hcl",
	"tf",
	"tfvars",
	"terraform",
	"ini",
	"cfg",
	"conf",
	"config",
	"properties",
	"just",
	"justfile",
	"julia",
	"jl",
	"kotlin",
	"kt",
	"kts",
	"ktm",
	"lua",
	"make",
	"makefile",
	"gnumake",
	"mk",
	"mak",
	"nix",
	"objc",
	"obj-c",
	"objective-c",
	"m",
	"mm",
	"ocaml",
	"ml",
	"odin",
	"perl",
	"pl",
	"pm",
	"powershell",
	"ps1",
	"psm1",
	"protobuf",
	"proto",
	"r",
	"regex",
	"re",
	"scala",
	"sc",
	"sbt",
	"solidity",
	"sol",
	"sql",
	"starlark",
	"star",
	"bzl",
	"bazel",
	"skylark",
	"svelte",
	"swift",
	"tla",
	"tla+",
	"tlaplus",
	"pluscal",
	"pcal",
	"verilog",
	"systemverilog",
	"sv",
	"svh",
	"vh",
	"v",
	"vue",
	"xml",
	"xsl",
	"xslt",
	"svg",
	"plist",
	"zig",
];

#[cfg(test)]
mod tests {
	use std::path::Path;

	use ast_grep_core::{matcher::KindMatcher, tree_sitter::LanguageExt};

	use super::SupportLang;

	#[test]
	fn all_langs_matches_locked_registry() {
		let langs = SupportLang::all_langs();
		#[cfg(not(feature = "full-langs"))]
		assert_eq!(langs, &[
			SupportLang::TypeScript,
			SupportLang::Tsx,
			SupportLang::JavaScript,
			SupportLang::Python,
			SupportLang::Rust,
			SupportLang::Go,
			SupportLang::Java,
			SupportLang::C,
			SupportLang::Cpp,
			SupportLang::CSharp,
			SupportLang::Ruby,
			SupportLang::Php,
			SupportLang::Bash,
			SupportLang::Json,
			SupportLang::Yaml,
			SupportLang::Toml,
			SupportLang::Markdown,
			SupportLang::Html,
			SupportLang::Css,
		],);

		#[cfg(feature = "full-langs")]
		{
			assert_eq!(langs.len(), 56);
			assert!(langs.contains(&SupportLang::Starlark));
			assert!(langs.contains(&SupportLang::Swift));
		}
	}

	#[test]
	fn bzl_extension_inference_matches_language_set() {
		let inferred = SupportLang::from_path(Path::new("x.bzl"));
		#[cfg(not(feature = "full-langs"))]
		assert_eq!(inferred, None);
		#[cfg(feature = "full-langs")]
		assert_eq!(inferred, Some(SupportLang::Starlark));
	}

	#[test]
	fn html_script_injection_range_is_available_in_default_registry() {
		let html = SupportLang::Html;
		let ast = html.ast_grep("<html><script>const x=1</script></html>");
		let injections = html.extract_injections(ast.root());
		let ranges = injections
			.get("js")
			.expect("script should inject JavaScript");
		let range = ranges.first().expect("script should expose raw text range");
		assert_eq!(&ast.root().text().as_ref()[range.start_byte..range.end_byte], "const x=1");

		let matcher = KindMatcher::new("script_element", html);
		assert!(ast.root().find(matcher).is_some());
	}
}
