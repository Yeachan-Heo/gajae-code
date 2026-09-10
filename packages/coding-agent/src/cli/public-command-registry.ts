import type { ArgDescriptor, FlagDescriptor } from "@gajae-code/utils/cli";
import { DAEMON_ACTION_TOKENS, resolveDaemonAction } from "../daemon/operator-contract";
import { OPERATIONS, type Operation, type OperationKind } from "../sdk/protocol/operation-registry";

export const PUBLIC_HELP_SECTIONS = [
	"overview",
	"usage",
	"children",
	"arguments",
	"options",
	"examples",
	"recovery",
] as const;
export type PublicHelpSection = (typeof PUBLIC_HELP_SECTIONS)[number];
export type PublicCommandFamily = "sdk" | "daemon";
export type PublicDisruption = "none" | "interrupts-work" | "force-kill";
export interface PublicRecovery {
	description: string;
	disruption: PublicDisruption;
	requiresConfirmation: boolean;
}
export interface PublicFlagDescriptor extends FlagDescriptor {
	description: string;
	/** Boundary options are stripped before operation parsing. */
	boundary?: "help" | "mode" | "retrieval";
	conflicts?: readonly string[];
	requires?: readonly string[];
	risk?: string;
	validation?: "positive-safe-integer" | "sha256" | "error-id" | "search-limit" | "pending-ceiling";
	/** Serve's existing operation parser accepts separate operands only. */
	valueSyntax?: "separate" | "separate-or-equals";
}
export interface PublicArgumentDescriptor extends ArgDescriptor {
	description: string;
}
export interface PublicCommandDescriptor {
	command: readonly string[];
	canonicalCommand: readonly string[];
	parent: readonly string[] | null;
	description: string;
	/** Effective local grammar, not a union of sibling options. Keys have no leading --. */
	flags: Readonly<Record<string, PublicFlagDescriptor>>;
	/** Insertion order is positional order; child tokens are not arguments. */
	args: Readonly<Record<string, PublicArgumentDescriptor>>;
	children: readonly string[];
	usage: readonly { syntax: string; executable: false }[];
	examples: readonly { syntax: string; executable: false }[];
	recovery: readonly PublicRecovery[];
	risk?: string;
	defaultChild?: string;
	exactlyOneOf?: readonly (readonly string[])[];
	/** Semantic conditions remain runtime-owned (e.g. proof-bound retirement). */
	constraints: readonly string[];
	operationKind?: Exclude<OperationKind, "reverse">;
}
export interface PublicCommandResolution {
	descriptor: PublicCommandDescriptor;
	/** Number of path tokens consumed, including the family. No argv scanning is performed. */
	consumed: number;
	remaining: readonly string[];
	exact: boolean;
}

const stringFlag = (description: string, extra: Partial<PublicFlagDescriptor> = {}): PublicFlagDescriptor => ({
	kind: "string",
	description,
	valueSyntax: "separate-or-equals",
	...extra,
});
const booleanFlag = (description: string, extra: Partial<PublicFlagDescriptor> = {}): PublicFlagDescriptor => ({
	kind: "boolean",
	description,
	...extra,
});
const positive = (description: string): PublicFlagDescriptor =>
	stringFlag(description, { validation: "positive-safe-integer" });
const argument = (description: string, extra: Partial<PublicArgumentDescriptor> = {}): PublicArgumentDescriptor => ({
	kind: "string",
	description,
	required: true,
	...extra,
});
const agentDir = stringFlag("SDK broker/state directory (default: the configured agent directory).");
const repo = stringFlag("Workspace directory for scope or saved-session resolution (default: current directory).");
const timeout = positive("Request or live-follow timeout in milliseconds; send uses this for its --wait window.");
const idempotency = stringFlag(
	"Caller idempotency key; retain it when reconciling an uncertain mutation, never blindly replay.",
);
const jsonNames = ["json-input", "json-input-file", "json-input-stdin"];
const jsonInput: Record<string, PublicFlagDescriptor> = {
	"json-input": stringFlag("Request JSON object; secret values must instead use the secure file or stdin source.", {
		conflicts: jsonNames.slice(1),
	}),
	"json-input-file": stringFlag("Read a request JSON object from a regular 0600 file.", {
		conflicts: ["json-input", "json-input-stdin"],
	}),
	"json-input-stdin": booleanFlag("Read a request JSON object from standard input.", {
		conflicts: jsonNames.slice(0, 2),
	}),
};
export const PUBLIC_BOUNDARY_FLAGS: Readonly<Record<string, PublicFlagDescriptor>> = {
	help: booleanFlag("Show inert command-local help; no operation is executed.", { char: "h", boundary: "help" }),
	json: booleanFlag("Use JSON for help and ordinary failures; existing successful output contracts are unchanged.", {
		boundary: "mode",
	}),
	"help-section": stringFlag("Select a static help section.", {
		boundary: "help",
		options: PUBLIC_HELP_SECTIONS,
		default: "overview",
		requires: ["help"],
	}),
	"help-page": stringFlag("Select a positive decimal help page.", {
		boundary: "help",
		validation: "positive-safe-integer",
		default: "1",
		requires: ["help"],
	}),
	"help-revision": stringFlag("Pin help traversal to a descriptor SHA256 revision.", {
		boundary: "help",
		validation: "sha256",
		requires: ["help"],
	}),
};
export const PUBLIC_RETRIEVAL_FLAGS: Readonly<Record<string, PublicFlagDescriptor>> = {
	"error-ref": stringFlag(
		"Retrieve retained sanitized error evidence by 32-character lowercase hex ID; available only within its 24-hour retention lifetime.",
		{ boundary: "retrieval", validation: "error-id", requires: ["error-sha256"], conflicts: ["help"] },
	),
	"error-sha256": stringFlag("Verify the retained record's 64-character lowercase SHA256 digest.", {
		boundary: "retrieval",
		validation: "sha256",
		requires: ["error-ref"],
		conflicts: ["help"],
	}),
	"error-page": stringFlag("Retrieve a positive decimal evidence page without replaying the original operation.", {
		boundary: "retrieval",
		validation: "positive-safe-integer",
		default: "1",
		requires: ["error-ref", "error-sha256"],
	}),
	"error-agent-dir": stringFlag("Use only this evidence-store agent directory; never search alternative roots.", {
		boundary: "retrieval",
		requires: ["error-ref", "error-sha256"],
	}),
};
const safeRecovery: PublicRecovery[] = [
	{
		description:
			"Use command-local --help to correct syntax. After an uncertain mutation, preserve complete references and reconcile before retrying; no recovery is executed automatically.",
		disruption: "none",
		requiresConfirmation: false,
	},
];
const mutationRecovery: PublicRecovery[] = [
	...safeRecovery,
	{
		description:
			"Confirm the target and inspect available outcome evidence before any disruptive recovery. Retirement requires actual dead-host proof and is not a status query.",
		disruption: "interrupts-work",
		requiresConfirmation: true,
	},
];
const sessionArg = { sessionId: argument("Exact SDK session ID.") };

type NodeInput = Pick<PublicCommandDescriptor, "description"> &
	Partial<Omit<PublicCommandDescriptor, "command" | "parent" | "description" | "usage" | "examples">> & {
		syntax?: string;
		example?: string;
	};
function node(path: string, input: NodeInput): PublicCommandDescriptor {
	const command = path.split(" ");
	const { syntax, example, ...metadata } = input;
	return {
		command,
		canonicalCommand: command,
		parent: command.length === 1 ? null : command.slice(0, -1),
		args: {},
		children: [],
		constraints: [],
		recovery: safeRecovery,
		...metadata,
		flags: { ...PUBLIC_BOUNDARY_FLAGS, ...(command.length === 1 ? PUBLIC_RETRIEVAL_FLAGS : {}), ...input.flags },
		usage: [{ syntax: `gjc ${path}${syntax ? ` ${syntax}` : ""}`, executable: false }],
		examples: [{ syntax: example ?? `gjc ${path} --help --json`, executable: false }],
	};
}
const sessionFlags = { "agent-dir": agentDir };
const observeDaemonFlags = {
	all: booleanFlag("Target all registered daemon kinds."),
	verbose: booleanFlag("Show runtime detail and the full roots list.", { char: "v" }),
};
const daemonRisk =
	"Stopping or restarting interrupts daemon work; --force permits SIGKILL escalation and can lose in-flight work.";
const mutateDaemonFlags = {
	all: observeDaemonFlags.all,
	force: booleanFlag("Allow SIGKILL escalation after graceful stop times out.", { risk: daemonRisk }),
	"graceful-timeout-ms": positive("Cooperative stop timeout before escalation."),
	"kill-timeout-ms": positive("Wait for old PID death after SIGKILL."),
};
const daemonArgs = {
	kind: argument("Daemon kinds (default: telegram); these are not SDK broker kinds.", {
		required: false,
		multiple: true,
		options: ["telegram", "discord", "slack"],
	}),
};

/** Static descriptors only: no settings, theme, broker, transport, filesystem or process initialization. */
export const PUBLIC_COMMANDS: readonly PublicCommandDescriptor[] = [
	node("sdk", {
		description: "Discover SDK transports, sessions, search, spawn and advisory guides.",
		children: ["serve", "search", "spawn", "session", "guides"],
		syntax: "<command>",
		constraints: [
			"A public child command is required unless requesting help or root evidence retrieval.",
			"Evidence retrieval is exclusive with help, operation arguments and operation flags; duplicate selectors are invalid.",
		],
	}),
	node("sdk serve", {
		description: "Relay SDK frames over stdio or a Unix socket.",
		syntax: "(--stdio | --socket <path>) [--session <id>] [--pending-ceiling <bytes>]",
		flags: {
			stdio: booleanFlag("Serve frames over standard input/output.", { conflicts: ["socket"] }),
			socket: stringFlag("Unix socket path (unavailable on Windows).", {
				conflicts: ["stdio"],
				valueSyntax: "separate",
			}),
			session: stringFlag("Attach to a specific live SDK session.", { valueSyntax: "separate" }),
			"pending-ceiling": stringFlag(
				"Queued relay bytes per direction; minimum 262144. Flag overrides GJC_SDK_SERVE_PENDING_CEILING_BYTES, otherwise 8388608.",
				{ validation: "pending-ceiling", valueSyntax: "separate" },
			),
		},
		exactlyOneOf: [["stdio", "socket"]],
		constraints: [
			"Operation flags may occur only once and use separate operands.",
			"Without --session exactly one live session must be available.",
			"After relay ownership, protocol frames retain their existing contract; --json controls only preflight failures.",
		],
		example: "gjc sdk serve --stdio",
	}),
	node("sdk search", {
		description: "Search broker-visible sessions in an exact repo, pwd or global scope.",
		syntax: "[--scope repo|pwd|global] [--repo <dir>] [--limit <N>] [--cursor <cursor>]",
		flags: {
			...sessionFlags,
			repo,
			scope: stringFlag("Exact search scope.", { options: ["repo", "pwd", "global"], default: "repo" }),
			limit: { kind: "integer", description: "Search page size, 1 through 100.", validation: "search-limit" },
			cursor: stringFlag("Frozen scoped search continuation cursor."),
			json: booleanFlag("Render the SdkSearchResultV1 success envelope and JSON failures.", { boundary: "mode" }),
		},
		constraints: ["Not-in-git-worktree is a successful search result, not an unavailable error."],
		example: "gjc sdk search --scope repo --json",
	}),
	node("sdk spawn", {
		description: "Spawn a task-seeded background child from a live local interactive master.",
		syntax: "--cwd <dir> --prompt <task> [--model <selector>] [--profile <name>]",
		flags: {
			...sessionFlags,
			cwd: stringFlag("Child working directory.", { required: true }),
			prompt: stringFlag("Seed task delivered once to the child.", { required: true }),
			model: stringFlag("Child model selector."),
			profile: stringFlag("Child model profile."),
			"idempotency-key": idempotency,
			json: booleanFlag("Render the safe spawn result and ordinary failures as JSON.", { boundary: "mode" }),
		},
		risk: "Creates background work; an uncertain spawn may already have created a child.",
		recovery: mutationRecovery,
		constraints: [
			"Requires a live local interactive master capability and current master attestation.",
			"Do not expose master credentials; preserve the idempotency key and returned references before considering replay.",
		],
	}),
	node("sdk session", {
		description: "Manage broker-bound credential-free sessions.",
		children: ["list", "inspect", "send", "status", "tail", "retire", "raw"],
		syntax: "<command>",
	}),
	node("sdk session list", {
		description: "List sessions within the selected workspace scope.",
		flags: {
			...sessionFlags,
			repo,
			scope: stringFlag("Session list scope; all ignores workspace selection.", {
				options: ["repo", "cwd", "worktree", "all"],
				default: "repo",
			}),
		},
		syntax: "[--scope repo|cwd|worktree|all] [--repo <dir>]",
		constraints: ["repo/worktree outside Git fail; they never silently broaden to all."],
		example: "gjc sdk session list --scope cwd",
	}),
	node("sdk session inspect", {
		description: "Inspect a session without exposing endpoint credentials.",
		args: sessionArg,
		flags: sessionFlags,
		syntax: "<sessionId>",
	}),
	node("sdk session send", {
		description: "Submit a prompt with a durable operation reference; optionally await its result.",
		args: sessionArg,
		flags: {
			...sessionFlags,
			...jsonInput,
			text: stringFlag("Prompt text, alternative to nonempty JSON input."),
			"op-ref": stringFlag(
				"Prompt clientRef (default: generated ULID); must match JSON clientRef when both are supplied.",
			),
			wait: booleanFlag("Poll turn.result kind=prompt until terminal or the wait window expires."),
			"timeout-ms": timeout,
		},
		syntax:
			"<sessionId> (--text <prompt> | --json-input <object> | --json-input-file <file> | --json-input-stdin) [--wait]",
		constraints: [
			"Prompt text is required, either directly or in the JSON object.",
			"--text conflicts with a nonempty JSON object, not an empty object.",
			"--timeout-ms affects --wait only (default wait window: 30000ms).",
			"JSON input sources are mutually exclusive.",
		],
		risk: "Submits agent work; a wait timeout after acceptance is not permission to submit again.",
		recovery: mutationRecovery,
	}),
	node("sdk session status", {
		description: "Read the durable prompt result for a known operation reference.",
		args: { ...sessionArg, opRef: argument("Exact operation reference returned or supplied by send.") },
		flags: { ...sessionFlags, "timeout-ms": timeout },
		syntax: "<sessionId> <opRef>",
	}),
	node("sdk session tail", {
		description: "Read retained history and follow live session events into one accumulated result.",
		args: sessionArg,
		flags: {
			...sessionFlags,
			repo,
			cursor: stringFlag("Saved checkpoint token for continuation."),
			strict: booleanFlag("Fail closed on retention gaps."),
			"until-idle": booleanFlag("Exit after an observed terminal turn state."),
			"all-events": booleanFlag("Include every event-ring kind."),
			"timeout-ms": timeout,
		},
		syntax: "<sessionId> [--cursor <checkpoint>] [--strict] [--until-idle]",
		constraints: ["Live follow defaults to 10000ms; saved-session resolution uses --repo."],
	}),
	node("sdk session retire", {
		description: "Retire an indexed terminalUncertain create effect using actual dead-host proof.",
		args: sessionArg,
		flags: { ...sessionFlags, ...jsonInput, "idempotency-key": { ...idempotency, required: true } },
		syntax: "<sessionId> --idempotency-key <key> [--json-input-file <proof-file>]",
		risk: "Proof-bound lifecycle mutation, not read-only reconciliation or status. Confirm intent before execution.",
		recovery: mutationRecovery,
		constraints: [
			"Runs session.reconcile_uncertain with the selected sessionId; any JSON sessionId must match.",
			"The lifecycle service validates the complete dead-host proof. No --confirm flag is required by the existing retirement grammar.",
			"JSON input sources are mutually exclusive.",
		],
	}),
	node("sdk session raw", {
		description: "Explicit raw control, query and global operation hatch.",
		children: ["control", "query", "global"],
		syntax: "<control|query|global>",
		constraints: ["Operation IDs are option values, never child command paths."],
	}),
	node("sdk session raw control", {
		description: "Submit a permitted session control operation.",
		args: sessionArg,
		operationKind: "control",
		flags: {
			...sessionFlags,
			...jsonInput,
			op: stringFlag("Control operation ID; adapter dispositions restrict availability.", { required: true }),
			confirm: booleanFlag("Confirm a destructive local control; terminal abort requires confirmation.", {
				risk: "May interrupt or replace active work.",
			}),
			"idempotency-key": idempotency,
			"timeout-ms": timeout,
		},
		syntax: "<sessionId> --op <operation> [--json-input <object>]",
		risk: "Controls can mutate or interrupt work; terminal turn.abort requires --confirm and --idempotency-key.",
		recovery: mutationRecovery,
		constraints: [
			"JSON input sources are mutually exclusive.",
			"Terminal abort scope must be turn or owned and uses the operator abort path.",
		],
	}),
	node("sdk session raw query", {
		description: "Read a permitted session query with an optional continuation cursor.",
		args: sessionArg,
		operationKind: "query",
		flags: {
			...sessionFlags,
			...jsonInput,
			query: stringFlag("Query ID (including registered query aliases).", { required: true }),
			cursor: stringFlag("Raw query continuation cursor."),
			"timeout-ms": timeout,
		},
		syntax: "<sessionId> --query <query> [--cursor <cursor>]",
		constraints: ["JSON input sources are mutually exclusive."],
	}),
	node("sdk session raw global", {
		description: "Run a permitted broker-global operation without a session positional.",
		operationKind: "global",
		flags: {
			...sessionFlags,
			...jsonInput,
			op: stringFlag("Global operation ID; session.spawn and session.get_endpoint are unavailable here.", {
				required: true,
			}),
			"idempotency-key": idempotency,
		},
		syntax: "--op <operation> [--json-input <object>] [--idempotency-key <key>]",
		risk: "Lifecycle globals can create, close, delete or retire sessions; inspect uncertain results before replay.",
		recovery: mutationRecovery,
		constraints: [
			"Lifecycle mutations require --idempotency-key; session.list does not.",
			"Lifecycle timeout is derived from operation input, not --timeout-ms.",
			"JSON input sources are mutually exclusive.",
		],
	}),
	node("sdk guides", {
		description: "Manage verified advisory SDK guides.",
		children: ["refresh", "list", "show", "status", "trust"],
		syntax: "<command>",
	}),
	node("sdk guides refresh", {
		description: "Fetch and verify an allowlisted HTTPS guide manifest and advisory cache.",
		flags: {
			...sessionFlags,
			url: stringFlag("HTTPS allowlisted manifest URL.", { required: true }),
			"timeout-ms": positive("Bounded refresh timeout in milliseconds."),
		},
		syntax: "--url <https-url> [--timeout-ms <N>]",
		constraints: [
			"A fallback cache or bundled selection is an operational refresh failure, not online refresh success.",
		],
	}),
	node("sdk guides list", { description: "List guides from the verified advisory selection.", flags: sessionFlags }),
	node("sdk guides show", {
		description: "Read a verified guide by ID.",
		args: { guideId: argument("Exact guide ID from guides list.") },
		flags: sessionFlags,
		syntax: "<guideId>",
	}),
	node("sdk guides status", { description: "Report guide cache and selection status.", flags: sessionFlags }),
	node("sdk guides trust", { description: "Show the static guide trust policy; no refresh or cache mutation." }),
	node("daemon", {
		description: "Manage Telegram, Discord and Slack background daemons, not the SDK broker.",
		children: DAEMON_ACTION_TOKENS,
		defaultChild: "status",
		args: daemonArgs,
		flags: observeDaemonFlags,
		syntax: "[status] [<kind>...] [--all]",
		constraints: [
			"No action defaults to status; no kind defaults to telegram.",
			"Evidence retrieval is exclusive with help, operation arguments and operation flags; duplicate selectors are invalid.",
		],
	}),
	...DAEMON_ACTION_TOKENS.map(action => {
		const canonical = resolveDaemonAction(action)!;
		const mutation = canonical === "stop" || canonical === "restart";
		return node(`daemon ${action}`, {
			description:
				canonical === "restart"
					? "Reload a running daemon, spawning an owner if none is running."
					: canonical === "stop"
						? "Stop selected daemon owners."
						: "Read status for selected daemon kinds.",
			canonicalCommand: ["daemon", canonical],
			args: daemonArgs,
			flags: mutation
				? {
						...mutateDaemonFlags,
						...(canonical === "restart"
							? {
									"spawn-if-stopped": booleanFlag(
										"Spawn on restart when no daemon is running (existing restart default).",
									),
								}
							: {}),
					}
				: observeDaemonFlags,
			syntax: "[<kind>...] [--all] [--json]",
			risk: mutation ? daemonRisk : undefined,
			recovery: mutation ? mutationRecovery : safeRecovery,
			constraints: [
				"Known kinds: telegram, discord, slack. No kind defaults to telegram; --all selects all registered kinds.",
				...(action === "reload" ? ["reload is an alias of restart, not a distinct operation."] : []),
			],
			example: `gjc daemon ${action} telegram --json`,
		});
	}),
];

/** Exact full public path lookup; private workers and function-only verbs are absent. */
export function getPublicCommand(command: readonly string[]): PublicCommandDescriptor | undefined {
	return PUBLIC_COMMANDS.find(
		node => node.command.length === command.length && node.command.every((token, index) => token === command[index]),
	);
}
export function getPublicCommandChildren(descriptor: PublicCommandDescriptor): readonly PublicCommandDescriptor[] {
	return descriptor.children.map(token => getPublicCommand([...descriptor.command, token])!);
}
/** Resolve path tokens only. The entry scanner must first respect flag operands and --. */
export function resolvePublicCommand(tokens: readonly string[]): PublicCommandResolution | undefined {
	let descriptor = getPublicCommand(tokens.slice(0, 1));
	if (!descriptor) return undefined;
	let consumed = 1;
	while (consumed < tokens.length && descriptor.children.includes(tokens[consumed]!)) {
		descriptor = getPublicCommand([...descriptor.command, tokens[consumed]!])!;
		consumed++;
	}
	return { descriptor, consumed, remaining: tokens.slice(consumed), exact: consumed === tokens.length };
}
/** Operation metadata is reused, not promoted to command paths or usage-level enum rejection. */
export function getPublicRawOperations(kind: Exclude<OperationKind, "reverse">): readonly Operation[] {
	return OPERATIONS.filter(
		operation =>
			operation.kind === kind &&
			operation.adapterDispositions.daemonCli !== "prohibited" &&
			operation.adapterDispositions.daemonCli !== "provider_only" &&
			operation.sdkId !== "session.get_endpoint" &&
			operation.sdkId !== "session.spawn",
	);
}
