import { Args, Command, Flags } from "@gajae-code/utils/cli";
import { WorkType } from "../gjc-runtime/git-lifecycle";
import {
	defaultCommandRunner,
	type GithubAdapter,
	GitLifecycleController,
	type LanePolicyMode,
	type PullRequest,
	type RequiredGate,
} from "../gjc-runtime/git-lifecycle-controller";

const workTypes = Object.values(WorkType);

export default class Lane extends Command {
	static description = "Manage typed, isolated git lifecycle lanes";
	static args = {
		action: Args.string({
			required: true,
			options: ["configure", "start", "status", "pr", "reconcile", "gc"],
			description: "configure, start, status, pr, reconcile, or gc",
		}),
	};
	static flags = {
		json: Flags.boolean({ char: "j", default: false, description: "Emit machine-readable JSON" }),
		mode: Flags.string({
			options: ["pr-only", "local-controlled-merge"],
			description: "Merge policy mode (configure)",
		}),
		remote: Flags.string({ description: "Git remote name (configure)" }),
		base: Flags.string({ description: "Base branch (configure)" }),
		"worktree-root": Flags.string({ description: "Managed worktree root (configure)" }),
		"allowed-types": Flags.string({
			description: "Comma-separated work types allowed for controlled merge (configure)",
		}),
		gates: Flags.string({ description: "Comma-separated required check@app pairs (configure)" }),
		"retention-hours": Flags.integer({ description: "Cleanup retention hours, default 24 (configure)" }),
		forbidden: Flags.string({ description: "Comma-separated forbidden path patterns (configure)" }),
		"lane-id": Flags.string({ description: "Lane identifier (start, status, pr, reconcile, gc)" }),
		type: Flags.string({ options: workTypes, description: "Typed work category (start)" }),
		scope: Flags.string({ description: "Typed lane scope (start)" }),
		purpose: Flags.string({ description: "Typed lane purpose (start)" }),
		agent: Flags.string({ description: "Owning agent (start)" }),
		session: Flags.string({ description: "Owning session (start)" }),
		title: Flags.string({ description: "Pull request title (pr)" }),
	};
	static examples = [
		"gjc lane configure --mode local-controlled-merge --remote origin --base main --worktree-root D:/worktrees --allowed-types fix,docs --gates build@CI",
		"gjc lane start --lane-id lane-1 --type fix --scope auth --purpose timeout --agent gjc --session s1",
		"gjc lane status --lane-id lane-1 --json",
		"gjc lane pr --lane-id lane-1",
		"gjc lane reconcile --lane-id lane-1",
		"gjc lane gc --lane-id lane-1",
	];
	async run(): Promise<void> {
		const { args, flags } = await this.parse(Lane);
		const github = new GhAdapter(process.cwd());
		const controller = new GitLifecycleController({ cwd: process.cwd(), github });
		let result: unknown;
		switch (args.action) {
			case "configure":
				result = await controller.configure({
					mode: required(flags.mode, "--mode") as LanePolicyMode,
					remote: required(flags.remote, "--remote"),
					base: required(flags.base, "--base"),
					worktreeRoot: required(flags["worktree-root"], "--worktree-root"),
					allowedAutoMergeTypes: csv(flags["allowed-types"]) as typeof workTypes,
					requiredGates: gates(flags.gates),
					forbiddenPathPatterns: csv(flags.forbidden),
					retentionHours: flags["retention-hours"],
				});
				break;
			case "start":
				result = await controller.start({
					laneId: required(flags["lane-id"], "--lane-id"),
					type: required(flags.type, "--type") as (typeof workTypes)[number],
					scope: required(flags.scope, "--scope"),
					purpose: required(flags.purpose, "--purpose"),
					agent: required(flags.agent, "--agent"),
					sessionId: required(flags.session, "--session"),
				});
				break;
			case "status":
				result = await controller.status(flags["lane-id"]);
				break;
			case "pr":
				result = await controller.pr(required(flags["lane-id"], "--lane-id"), flags.title);
				break;
			case "reconcile":
				result = await controller.reconcile(required(flags["lane-id"], "--lane-id"));
				break;
			case "gc":
				result = await controller.gc(required(flags["lane-id"], "--lane-id"));
				break;
		}
		console.log(flags.json ? JSON.stringify(result) : JSON.stringify(result, null, "\t"));
	}
}
class GhAdapter implements GithubAdapter {
	constructor(private readonly cwd: string) {}
	async findPullRequest(head: string, base: string): Promise<PullRequest | undefined> {
		const list = await this.gh(["pr", "list", "--head", head, "--base", base, "--state", "all", "--json", fields]);
		const value = JSON.parse(list) as unknown[];
		return value.length ? normalize(value[0]) : undefined;
	}
	async createPullRequest(head: string, base: string, title: string): Promise<PullRequest> {
		await this.gh(["pr", "create", "--head", head, "--base", base, "--title", title, "--body", ""]);
		const pull = await this.findPullRequest(head, base);
		if (!pull) throw new Error("created pull request could not be resolved");
		return pull;
	}
	async getPullRequest(number: number): Promise<PullRequest | undefined> {
		try {
			return normalize(JSON.parse(await this.gh(["pr", "view", String(number), "--json", fields])));
		} catch {
			return undefined;
		}
	}
	async squashMergePullRequest(
		number: number,
		input: { matchHeadCommit: string; expectedBaseCommit: string },
	): Promise<{ method: "SQUASH"; matchHeadCommit: string; expectedBaseCommit: string }> {
		const current = await this.getPullRequest(number);
		if (
			current?.state !== "OPEN" ||
			current.headRefOid !== input.matchHeadCommit ||
			current.baseRefOid !== input.expectedBaseCommit
		)
			throw new Error("pull request head or base changed before controlled merge");
		await this.gh(["pr", "merge", String(number), "--squash", "--match-head-commit", input.matchHeadCommit]);
		return {
			method: "SQUASH",
			matchHeadCommit: input.matchHeadCommit,
			expectedBaseCommit: input.expectedBaseCommit,
		};
	}
	private async gh(args: string[]): Promise<string> {
		const result = await defaultCommandRunner(["gh", ...args], this.cwd);
		if (result.exitCode) throw new Error(result.stderr || "gh command failed");
		return result.stdout;
	}
}
const fields =
	"number,url,state,isDraft,isCrossRepository,headRefName,headRefOid,baseRefName,baseRefOid,mergeable,reviewDecision,statusCheckRollup,mergedAt,mergeCommit,headRepository";
function normalize(value: any): PullRequest {
	return {
		...value,
		reviewDecision: value.reviewDecision || null,
		checks: (value.statusCheckRollup ?? []).map((item: any) => ({
			name: item.name ?? item.context,
			app: item.app?.slug ?? item.app?.name ?? item.workflowName,
			conclusion: item.conclusion ?? item.state,
			headSha: value.headRefOid,
		})),
		mergeCommit: value.mergeCommit?.oid,
		remoteBranchDeleted: value.headRepository === null,
	};
}
function csv(value?: string): string[] {
	return value
		? value
				.split(",")
				.map(part => part.trim())
				.filter(Boolean)
		: [];
}
function gates(value?: string): RequiredGate[] {
	return csv(value).map(entry => {
		const separator = entry.lastIndexOf("@");
		if (separator <= 0 || separator === entry.length - 1) throw new Error(`invalid required gate: ${entry}`);
		return { name: entry.slice(0, separator), app: entry.slice(separator + 1) };
	});
}
function required(value: string | undefined, name: string): string {
	if (!value) throw new Error(`${name} is required`);
	return value;
}
