import { isComposerHarnessModel } from "@gajae-code/ai/providers/composer-discipline";

export const COMPOSER_BASH_POLICY_ERROR =
	"Composer bash policy blocked repository file I/O. Use find, search, read, and edit tools for file discovery, file inspection, and file mutation.";

type ComposerBashPolicyResult =
	| { allowed: true }
	| {
			allowed: false;
			reason: string;
			message: string;
	  };

const BLOCK_PATTERNS: Array<{ id: string; pattern: RegExp }> = [
	{ id: "pipe", pattern: /\|/ },
	{ id: "process-substitution", pattern: /<[>(]/ },
	{ id: "heredoc", pattern: /<<[-~]?/ },
	{ id: "command-substitution", pattern: /\$\(|`/ },
	{ id: "redirection", pattern: /(^|[^<>])(?:>>?|<)(?!=)/ },
	{ id: "tee", pattern: /(?:^|[;&|\s])tee(?:\s|$)/ },
	{
		id: "shell-file-read-discovery",
		pattern: /(?:^|[;&|()\s])(?:\S*\/)?(?:cat|head|tail|less|more|grep|rg|find|fd|tree|ls)\b/,
	},
	{
		id: "shell-file-mutation",
		pattern: /(?:^|[;&|()\s])(?:\S*\/)?(?:cp|mv|rm|touch|mkdir|chmod|chown|ln)\b/,
	},
	{ id: "sed-print", pattern: /(?:^|[;&|()\s])sed\s+(?:-[^\s]*n\b|.*\bp\b)/ },
	{ id: "awk-print", pattern: /(?:^|[;&|()\s])awk\b/ },
	{ id: "git-ls-files", pattern: /(?:^|[;&|()\s])git(?:\s+-C\s+\S+)?\s+ls-files\b/ },
	{ id: "git-grep", pattern: /(?:^|[;&|()\s])git(?:\s+-C\s+\S+)?\s+grep\b/ },
	{ id: "git-show-path", pattern: /(?:^|[;&|()\s])git(?:\s+-C\s+\S+)?\s+show\s+\S+:\S+/ },
	{ id: "git-diff", pattern: /(?:^|[;&|()\s])git(?:\s+-C\s+\S+)?\s+diff(?:\s|$)/ },
	{ id: "git-cat-file", pattern: /(?:^|[;&|()\s])git(?:\s+-C\s+\S+)?\s+cat-file\b/ },
	{
		id: "git-show-discovery",
		pattern: /(?:^|[;&|()\s])git(?:\s+-C\s+\S+)?\s+show\b.*(?:--name-only|--name-status|--stat)/,
	},
	{
		id: "git-log-path-discovery",
		pattern: /(?:^|[;&|()\s])git(?:\s+-C\s+\S+)?\s+log\b.*(?:--name-only|--name-status|--stat)/,
	},
	{ id: "sed-in-place", pattern: /(?:^|[;&|()\s])sed\s+-[^\s]*i\b/ },
	{ id: "perl-in-place", pattern: /(?:^|[;&|()\s])perl\s+-[^\s]*p[^\s]*i\b/ },
	{
		id: "script-file-io",
		pattern:
			/(?:^|[;&|()\s])(?:python3?|node|bun)\s+(?:-\s*<<|-c\b|-e\b|--eval\b).*?(?:read_text|read_bytes|write_text|iterdir|listdir|glob\.glob|readFile|readFileSync|writeFile|writeFileSync|readdir|readdirSync|stat|statSync|cpSync|rmSync|mkdirSync|createReadStream|createWriteStream|Bun\.file|Bun\.write|fs\.readFile|fs\.writeFile|fs\.readdir|fs\.stat|fs\.cp|fs\.rm|fs\.mkdir|open\s*\()/s,
	},
	{
		id: "contaminated-command",
		pattern: /```|^\s*(?:I\s+(?:will|need|am going)|We\s+(?:need|will)|First[, ]|Now[, ]|Let's)\b/im,
	},
];

const ALLOWED_TERMINAL_PATTERNS: RegExp[] = [
	/^bun\s+test(?:\s+[\w./:@=-]+)*$/,
	/^bun\s+run\s+(?:check(?::[\w-]+)?|test(?::[\w-]+)?|build(?::[\w-]+)?)(?:\s+[\w./:@=-]+)*$/,
	/^bun\s+--version$/,
	/^mise\s+x\s+bun@\d+\.\d+\.\d+\s+--\s+bun\s+test(?:\s+[\w./:@=-]+)*$/,
	/^mise\s+x\s+bun@\d+\.\d+\.\d+\s+--\s+bun\s+run\s+(?:check(?::[\w-]+)?|test(?::[\w-]+)?|build(?::[\w-]+)?)(?:\s+[\w./:@=-]+)*$/,
	/^cargo\s+(?:test|check|build)(?:\s+[\w./:@=-]+)*$/,
	/^git\s+status(?:\s+--short)?(?:\s+--branch)?$/,
	/^git\s+rev-parse\s+HEAD$/,
	/^npm\s+--version$/,
	/^pnpm\s+--version$/,
	/^yarn\s+--version$/,
];

function isAllowedComposerTerminalCommand(command: string): boolean {
	const normalized = command.trim().replace(/\s+/g, " ");
	return ALLOWED_TERMINAL_PATTERNS.some(pattern => pattern.test(normalized));
}

export function isComposerBashPolicyModel(modelId: string | undefined): boolean {
	return Boolean(modelId && isComposerHarnessModel(modelId));
}

export function checkComposerBashPolicy(input: {
	modelId?: string;
	commands: readonly string[];
}): ComposerBashPolicyResult {
	if (!isComposerBashPolicyModel(input.modelId)) return { allowed: true };
	for (const command of input.commands) {
		for (const block of BLOCK_PATTERNS) {
			if (block.pattern.test(command)) {
				return { allowed: false, reason: block.id, message: COMPOSER_BASH_POLICY_ERROR };
			}
		}
		if (!isAllowedComposerTerminalCommand(command)) {
			return { allowed: false, reason: "not-allowlisted", message: COMPOSER_BASH_POLICY_ERROR };
		}
	}
	return { allowed: true };
}
