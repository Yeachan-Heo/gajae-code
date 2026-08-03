const ULTRATEST_TRAILER_PREFIX = "Ultratest-Verified:";
const ULTRATEST_TRAILER = /^Ultratest-Verified: (?:killed \d+ \/ noted \d+|skip\(no assertion change\))$/u;
const GIT_CONTEXT_ENVIRONMENT_NAMES = new Set(["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_COMMON_DIR"]);

const ULTRATEST_BLOCK_MESSAGE = [
	"Ultratest commit gate: staged test changes require mutation verification before an inline commit.",
	"Run `ultratest`, restore every mutation before committing, then end the inline commit message with exactly one of these trailers:",
	"Ultratest-Verified: killed <n> / noted <n>",
	"Ultratest-Verified: skip(no assertion change)",
].join("\n");

export interface UltratestCommitGateInput {
	readonly cwd: string;
	readonly command: string;
}

export interface UltratestCommitGateDecision {
	readonly blocked: boolean;
	readonly message?: string;
	readonly reason?: "ultratest-verification-required";
	readonly command: string;
}

interface ParsedInlineCommit {
	readonly message: string;
	readonly bypass: boolean;
	readonly gitEnvironment: Readonly<Record<string, string>>;
}

interface ShellWords {
	readonly words: string[];
	readonly inspectable: boolean;
}

function gitContextEnvironment(): Record<string, string> {
	const environment: Record<string, string> = {};
	for (const [name, value] of Object.entries(process.env)) {
		if (!name.startsWith("GIT_")) continue;
		if (!GIT_CONTEXT_ENVIRONMENT_NAMES.has(name)) continue;
		if (value !== undefined) environment[name] = value;
	}
	return environment;
}

function shellWords(command: string): ShellWords {
	const words: string[] = [];
	let word = "";
	let started = false;
	let quote: "single" | "double" | null = null;
	let escaped = false;

	for (const character of command) {
		if (escaped) {
			word += character;
			started = true;
			escaped = false;
			continue;
		}
		if (quote === "single") {
			if (character === "'") quote = null;
			else word += character;
			started = true;
			continue;
		}
		if (quote === "double") {
			if (character === '"') quote = null;
			else if (character === "\\") escaped = true;
			else if (character === "$" || character === "`") return { words: [], inspectable: false };
			else word += character;
			started = true;
			continue;
		}
		if (character === "'") {
			quote = "single";
			started = true;
			continue;
		}
		if (character === '"') {
			quote = "double";
			started = true;
			continue;
		}
		if (character === "\\") {
			escaped = true;
			started = true;
			continue;
		}
		if (/\s/u.test(character)) {
			if (started) words.push(word);
			word = "";
			started = false;
			continue;
		}
		if (";&|<>()`$#*?[]{}~".includes(character)) return { words: [], inspectable: false };
		word += character;
		started = true;
	}

	if (escaped || quote !== null) return { words: [], inspectable: false };
	if (started) words.push(word);
	return { words, inspectable: true };
}

function parseInlineCommit(command: string): ParsedInlineCommit | null {
	const parsed = shellWords(command);
	if (!parsed.inspectable) return null;
	const words = [...parsed.words];
	let bypass = false;
	const gitEnvironment = gitContextEnvironment();
	while (words.length > 0 && /^[A-Za-z_][A-Za-z0-9_]*=/u.test(words[0] ?? "")) {
		const assignment = words.shift();
		if (!assignment) return null;
		const separator = assignment.indexOf("=");
		const name = assignment.slice(0, separator);
		const value = assignment.slice(separator + 1);
		if (assignment === "GJC_ALLOW_NO_ULTRATEST=1") bypass = true;
		if (name.startsWith("GIT_") && !GIT_CONTEXT_ENVIRONMENT_NAMES.has(name)) return null;
		if (GIT_CONTEXT_ENVIRONMENT_NAMES.has(name)) gitEnvironment[name] = value;
	}
	if (words.length !== 4) return null;
	if (words[0] !== "git" || words[1] !== "commit") return null;
	if (words[2] !== "-m" && words[2] !== "--message") return null;
	return { message: words[3] ?? "", bypass, gitEnvironment };
}

function isSupportedTestPath(filePath: string): boolean {
	const normalized = filePath.replaceAll("\\", "/");
	const base = normalized.slice(normalized.lastIndexOf("/") + 1);
	if (/\.(?:test|spec)\.[cm]?[jt]sx?$/u.test(base)) return true;
	if (/(?:^|\/)(?:__tests__|tests?)\/.*\.[cm]?[jt]sx?$/u.test(normalized)) return true;
	if (/^(?:test_.+|.+_test)\.py$/u.test(base)) return true;
	if (/(?:^|\/)tests?\/.*\.py$/u.test(normalized)) return true;
	return /_test\.go$/u.test(base);
}

function hasStagedTest(cwd: string, gitEnvironment: Readonly<Record<string, string>>): boolean | null {
	try {
		const environment = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith("GIT_")));
		const result = Bun.spawnSync(
			[
				"git",
				"--no-pager",
				"-c",
				"core.fsmonitor=false",
				"diff",
				"--no-ext-diff",
				"--cached",
				"--name-only",
				"--diff-filter=ACDMRTUXB",
				"-z",
				"--",
			],
			{
				cwd,
				env: { ...environment, ...gitEnvironment },
				stdin: "ignore",
				stdout: "pipe",
				stderr: "ignore",
			},
		);
		if (result.exitCode !== 0) return null;
		return result.stdout.toString().split("\0").filter(Boolean).some(isSupportedTestPath);
	} catch (error) {
		if (error instanceof Error) return null;
		throw error;
	}
}

export function getUltratestCommitGateDecision(input: UltratestCommitGateInput): UltratestCommitGateDecision | null {
	const commit = parseInlineCommit(input.command);
	if (!commit) return null;
	const messageLines = commit.message.split(/\r?\n/u);
	const trailers = messageLines.filter(line => line.startsWith(ULTRATEST_TRAILER_PREFIX));
	const lastNonEmptyLine = messageLines.findLast(line => line.trim().length > 0);
	if (
		commit.bypass ||
		(trailers.length === 1 && trailers[0] === lastNonEmptyLine && ULTRATEST_TRAILER.test(trailers[0] ?? ""))
	) {
		return { blocked: false, command: input.command };
	}
	const stagedTest = hasStagedTest(input.cwd, commit.gitEnvironment);
	if (stagedTest !== true) return { blocked: false, command: input.command };
	return {
		blocked: true,
		message: ULTRATEST_BLOCK_MESSAGE,
		reason: "ultratest-verification-required",
		command: input.command,
	};
}
