import {
	type ComposerBashPolicyToolSurface,
	formatComposerBashPolicyError,
	isComposerHarnessModel,
} from "@gajae-code/ai/providers/composer-discipline";

export const COMPOSER_BASH_POLICY_ERROR = formatComposerBashPolicyError("generic");
export const CURSOR_COMPOSER_BASH_POLICY_ERROR = formatComposerBashPolicyError("cursor");

type ComposerBashPolicyResult =
	| { allowed: true }
	| {
			allowed: false;
			reason: string;
			message: string;
			surface: ComposerBashPolicyToolSurface;
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

export function resolveComposerBashPolicyToolSurface(input: {
	modelId?: string;
	provider?: string;
}): ComposerBashPolicyToolSurface {
	if (input.provider?.toLowerCase() === "cursor") return "cursor";
	return /(?:^|[/:._-])cursor(?:[/:._-]|$)/i.test(input.modelId ?? "") ? "cursor" : "generic";
}

export function checkComposerBashPolicy(input: {
	modelId?: string;
	provider?: string;
	commands: readonly string[];
}): ComposerBashPolicyResult {
	if (!isComposerBashPolicyModel(input.modelId)) return { allowed: true };
	const surface = resolveComposerBashPolicyToolSurface(input);
	const message = formatComposerBashPolicyError(surface);
	for (const command of input.commands) {
		for (const block of BLOCK_PATTERNS) {
			if (block.pattern.test(command)) {
				return { allowed: false, reason: block.id, message, surface };
			}
		}
		if (!isAllowedComposerTerminalCommand(command)) {
			return { allowed: false, reason: "not-allowlisted", message, surface };
		}
	}
	return { allowed: true };
}
