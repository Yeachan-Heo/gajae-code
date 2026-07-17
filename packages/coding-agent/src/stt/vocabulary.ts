/**
 * Repo-aware vocabulary for speech recognition.
 *
 * Coding sessions are full of identifiers no general acoustic model knows —
 * file names, framework terms, branch names. Both backends accept a domain
 * vocabulary bias: Apple's recognizer via `contextualStrings`, whisper via
 * `initial_prompt`. This module derives that vocabulary from the repository
 * so "useEffect" or "ralplan" transcribe as identifiers, not soundalikes.
 */

const DEFAULT_VOCABULARY_CAP = 100;
const MAX_TERM_LENGTH = 40;
const WHISPER_PROMPT_CHAR_BUDGET = 600;

/** Words too generic to bias recognition with. */
const STOP_TERMS = new Set([
	"index",
	"main",
	"test",
	"tests",
	"src",
	"lib",
	"dist",
	"build",
	"types",
	"utils",
	"readme",
	"license",
	"package",
	"node_modules",
]);

export interface SpeechVocabularyInput {
	/** Repository-relative file paths (e.g. from `git ls-files`). */
	filePaths?: readonly string[];
	/** High-priority terms (branch name, product terms, recent symbols). */
	extraTerms?: readonly string[];
}

function termFromBasename(basename: string): string | undefined {
	// Strip stacked short extensions: "editor.test.ts" → "editor".
	let term = basename.trim();
	let previous = "";
	while (previous !== term) {
		previous = term;
		term = term.replace(/\.[A-Za-z0-9]{1,6}$/, "");
	}
	if (term.length < 3 || term.length > MAX_TERM_LENGTH) return undefined;
	if (STOP_TERMS.has(term.toLowerCase())) return undefined;
	// Skip pure numbers / versions / lockfile-ish noise.
	if (/^v?[\d.-]+$/i.test(term)) return undefined;
	return term;
}

/**
 * Build a deduplicated, capped vocabulary list. Extra terms come first so
 * they survive the cap; order is otherwise input order (deterministic).
 */
export function buildSpeechVocabulary(input: SpeechVocabularyInput, cap = DEFAULT_VOCABULARY_CAP): string[] {
	const seen = new Set<string>();
	const vocabulary: string[] = [];
	const push = (term: string | undefined) => {
		if (!term) return;
		const key = term.toLowerCase();
		if (seen.has(key)) return;
		seen.add(key);
		if (vocabulary.length < cap) vocabulary.push(term);
	};

	for (const term of input.extraTerms ?? []) {
		const trimmed = term.trim();
		if (trimmed.length >= 2 && trimmed.length <= MAX_TERM_LENGTH) push(trimmed);
	}
	for (const path of input.filePaths ?? []) {
		if (vocabulary.length >= cap) break;
		const basename = path.split("/").pop() ?? "";
		push(termFromBasename(basename));
	}
	return vocabulary;
}

/**
 * Fold the vocabulary into a whisper `initial_prompt`. Whisper treats the
 * prompt as preceding transcript, so a plain comma list biases decoding
 * toward these spellings without forcing them into the output.
 */
export function vocabularyToWhisperPrompt(vocabulary: readonly string[]): string {
	if (vocabulary.length === 0) return "";
	const parts: string[] = [];
	let budget = WHISPER_PROMPT_CHAR_BUDGET;
	for (const term of vocabulary) {
		if (term.length + 2 > budget) break;
		parts.push(term);
		budget -= term.length + 2;
	}
	return parts.join(", ");
}

/** Listening start must never wait on vocabulary longer than this. */
const COLLECT_BUDGET_MS = 300;
const VOCABULARY_CACHE_TTL_MS = 5 * 60 * 1000;
const vocabularyCache = new Map<string, { at: number; vocabulary: string[] }>();

/**
 * Collect repo file paths for vocabulary building. Uses `git ls-files`
 * (tracked files only — no directory walking) and fails soft to an empty
 * list outside a git repository.
 *
 * Vocabulary is a bias, not a requirement: the first call in a large repo
 * may return `[]` within the time budget while the collection keeps running
 * in the background and lands in a per-cwd cache for subsequent sessions.
 */
export async function collectRepoVocabulary(cwd: string, cap = DEFAULT_VOCABULARY_CAP): Promise<string[]> {
	const cached = vocabularyCache.get(cwd);
	if (cached && Date.now() - cached.at < VOCABULARY_CACHE_TTL_MS) return cached.vocabulary;

	const collect = (async (): Promise<string[]> => {
		try {
			const proc = Bun.spawn(["git", "ls-files"], { cwd, stdout: "pipe", stderr: "ignore" });
			const exited = await Promise.race([
				proc.exited,
				new Promise<number>(resolve => setTimeout(() => resolve(-1), 10_000)),
			]);
			if (exited !== 0) {
				proc.kill();
				return [];
			}
			const output = await new Response(proc.stdout).text();
			const filePaths = output.split("\n", 4_000).filter(Boolean);
			return buildSpeechVocabulary({ filePaths }, cap);
		} catch {
			return [];
		}
	})();
	void collect.then(vocabulary => vocabularyCache.set(cwd, { at: Date.now(), vocabulary }));

	// Never delay listening start beyond the budget — fall back to no bias.
	return Promise.race([
		collect,
		new Promise<string[]>(resolve => setTimeout(() => resolve([]), COLLECT_BUDGET_MS)),
	]);
}

/** Test hook — reset the per-cwd vocabulary cache. */
export function resetRepoVocabularyCache(): void {
	vocabularyCache.clear();
}
