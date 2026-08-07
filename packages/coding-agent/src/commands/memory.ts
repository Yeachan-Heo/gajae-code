/** Manage the opt-in, additive M6 memory capability. */
import { Args, Command, Flags, renderCommandHelp } from "@gajae-code/utils/cli";
import { MEMORY_ACTIONS, type MemoryAction, type MemoryCommandArgs, runMemoryCommand } from "../cli/memory";

const ACTIONS: readonly MemoryAction[] = [...MEMORY_ACTIONS];

function flattenScopes(values: readonly string[] | undefined): readonly string[] | undefined {
	if (values === undefined) return undefined;
	return values.flatMap(value => value.split(",").map(scope => scope.trim()));
}

export default class Memory extends Command {
	static description = "Initialize, inspect, or update the opt-in GJC memory capability";

	static args = {
		action: Args.string({
			description: "Memory action (omit to show help)",
			required: false,
			options: ACTIONS,
		}),
		value: Args.string({
			description: "URI, query, proposal id, or memory URI value",
			required: false,
		}),
	};

	static flags = {
		json: Flags.boolean({ description: "Output versioned JSON" }),
		intent: Flags.string({ description: "Retrieval intent" }),
		scope: Flags.string({
			description: "Memory scope (repeatable or comma-separated: global, project, session)",
			multiple: true,
		}),
		limit: Flags.integer({ description: "Maximum retrieval results" }),
		"max-bytes": Flags.integer({ description: "Maximum memory file size for doctor" }),
		complete: Flags.boolean({ description: "Fail when retrieval is truncated" }),
		deterministic: Flags.boolean({ description: "Use deterministic retrieval inputs" }),
		explain: Flags.boolean({ description: "Include retrieval explanation" }),
		// Validation lives in the handler so an unsupported value returns the versioned
		// gajae.memory.error.v1 invalid-input envelope instead of oclif parser help.
		format: Flags.string({ description: "Output format (json or text)" }),
		"require-resolved": Flags.boolean({
			description: "Fail with conflict-requires-confirmation when a material conflict is unresolved",
		}),
		"as-of": Flags.string({ description: "Strict UTC timestamp for deterministic retrieval" }),
		"session-id": Flags.string({ description: "Explicit memory session id" }),
		goal: Flags.string({ description: "Checkpoint goal" }),
		task: Flags.string({ description: "Checkpoint task" }),
		"next-step": Flags.string({ description: "Checkpoint next step (repeatable; at most three)", multiple: true }),
		constraint: Flags.string({ description: "Checkpoint constraint (repeatable)", multiple: true }),
		decision: Flags.string({ description: "Checkpoint decision (repeatable)", multiple: true }),
		risk: Flags.string({ description: "Checkpoint risk (repeatable)", multiple: true }),
		type: Flags.string({ description: "Memory document type for propose" }),
		content: Flags.string({ description: "Memory document content for propose" }),
		"target-scope": Flags.string({ description: "Target memory scope for propose" }),
		"target-uri": Flags.string({ description: "Target memory URI for propose" }),
		supersedes: Flags.string({ description: "Document id to supersede (repeatable)", multiple: true }),
		"expected-digest": Flags.string({ description: "Expected current digest for forget" }),
		reason: Flags.string({ description: "Reason for forget" }),
	};

	static examples = [
		"# Initialize the profile-aware memory root\n  gjc memory init",
		"# Inspect deterministic package capabilities without initialization\n  gjc memory capabilities",
		"# Resolve the canonical metadata for a memory URI\n  gjc memory resolve global://profile.md --json",
		"# Read a verified memory document\n  gjc memory get global://profile.md",
		'# Search ranked memory citations\n  gjc memory search "deployment convention" --scope global,project',
		'# Recall memory claims with a fixed retrieval timestamp\n  gjc memory recall "deployment convention" --deterministic --as-of 2026-07-29T00:00:00.000Z',
		'# Persist a session checkpoint\n  gjc memory checkpoint --goal "Ship continuity" --task "Save handoff" --next-step "Run resume" --session-id session-1 --json',
		"# Read a checkpoint handoff packet\n  gjc memory resume --session-id session-1 --json",
		"# Audit the memory store without mutating it\n  gjc memory doctor --json",
		"# Bound doctor file checks by size\n  gjc memory doctor --max-bytes 1048576",
		'# Stage a memory write proposal\n  gjc memory propose --type decision --content "Use the append-only transaction" --target-uri global://constraints/transaction.md --json',
		"# Apply a staged proposal by id\n  gjc memory apply <proposal-id> --json",
		"# Tombstone a memory document with a CAS digest\n  gjc memory forget global://constraints/transaction.md --expected-digest <digest> --json",
		"# Invalid actions print usage and exit with code 2\n  gjc memory inspect",
		"# Omit the action to show help; unknown actions are rejected with usage\n  gjc memory",
	];

	async run(): Promise<void> {
		const { args, flags } = await this.parse(Memory);
		if (!args.action) {
			renderCommandHelp("gjc", "memory", Memory);
			return;
		}

		const cmd: MemoryCommandArgs = {
			action: args.action as MemoryAction,
			value: args.value,
			flags: {
				json: flags.json,
				intent: flags.intent,
				scopes: flattenScopes(flags.scope),
				limit: flags.limit,
				maxBytes: flags["max-bytes"],
				complete: flags.complete,
				deterministic: flags.deterministic,
				explain: flags.explain,
				format: flags.format,
				requireResolved: flags["require-resolved"],
				asOf: flags["as-of"],
				sessionId: flags["session-id"],
				goal: flags.goal,
				task: flags.task,
				nextSteps: flags["next-step"],
				constraints: flags.constraint,
				decisions: flags.decision,
				risks: flags.risk,
				type: flags.type,
				content: flags.content,
				targetScope: flags["target-scope"],
				targetUri: flags["target-uri"],
				supersedes: flags.supersedes,
				expectedDigest: flags["expected-digest"],
				reason: flags.reason,
			},
		};
		await runMemoryCommand(cmd);
	}
}
