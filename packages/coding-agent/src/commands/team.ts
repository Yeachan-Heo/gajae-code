import { Args, Command, Flags } from "@gajae-code/utils/cli";
import { renderCliWriteReceipt } from "../gjc-runtime/cli-write-receipt";
import { renderTeamStatusMarkdown } from "../gjc-runtime/state-renderer";
import {
	buildTeamHudSummary,
	executeGjcTeamApiOperation,
	type GjcTeamSnapshot,
	listGjcTeams,
	monitorGjcTeamSnapshot,
	parseTeamLaunchArgs,
	persistGjcTeamModeStateSummary,
	readGjcTeamEvents,
	readGjcTeamSnapshot,
	shutdownGjcTeam,
	startGjcTeam,
} from "../gjc-runtime/team-runtime";
import { syncSkillActiveState } from "../skill-state/active-state";

function writeJson(value: unknown): void {
	process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function writeText(lines: string[]): void {
	process.stdout.write(`${lines.join("\n")}\n`);
}
async function syncTeamHud(snapshot: GjcTeamSnapshot): Promise<void> {
	try {
		const events = await readGjcTeamEvents(snapshot.team_name);
		await syncSkillActiveState({
			cwd: process.cwd(),
			skill: "team",
			active: snapshot.phase !== "complete" && snapshot.phase !== "cancelled",
			phase: snapshot.phase,
			hud: await buildTeamHudSummary(snapshot, events.at(-1)),
			source: "gjc-team",
		});
		await persistGjcTeamModeStateSummary(snapshot, process.cwd());
	} catch {
		// HUD sync is best-effort and must not change command semantics.
	}
}

function formatTaskCounts(counts: Record<string, number>): string {
	return Object.entries(counts)
		.map(([status, count]) => `${status}=${count}`)
		.join(" ");
}

function snapshotWriteReceipt(snapshot: GjcTeamSnapshot): Record<string, unknown> {
	return {
		ok: true,
		team_name: snapshot.team_name,
		phase: snapshot.phase,
		state_dir: snapshot.state_dir,
		tmux_session: snapshot.tmux_session,
		tmux_target: snapshot.tmux_target,
		worker_count: snapshot.workers.length,
		task_counts: snapshot.task_counts,
	};
}

function writeReceipt(value: Record<string, unknown>): void {
	process.stdout.write(renderCliWriteReceipt(value));
}

function parseInputFlag(argv: string[]): Record<string, unknown> {
	const index = argv.indexOf("--input");
	if (index < 0) return {};
	const raw = argv[index + 1];
	if (!raw) throw new Error("missing_api_input");
	const parsed = JSON.parse(raw) as unknown;
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("invalid_api_input");
	return parsed as Record<string, unknown>;
}

export default class Team extends Command {
	static description =
		"Run native GJC tmux team orchestration from inside an existing tmux/GJC --tmux session; --dry-run writes ephemeral .gjc/_session-{sessionid}/state/team state only";
	static strict = false;

	static args = {
		action: Args.string({
			description: "start (default), status, monitor, list, shutdown, resume, or api",
			required: false,
		}),
	};

	static flags = {
		json: Flags.boolean({ char: "j", description: "Emit machine-readable JSON", default: false }),
		"dry-run": Flags.boolean({
			description:
				"Create ephemeral .gjc/_session-{sessionid}/state/team state without starting tmux panes; do not commit generated state",
			default: false,
		}),
	};

	static examples = [
		"gjc --tmux  # start the required tmux-backed leader session first",
		'gjc team 3:executor "Implement the approved plan"',
		"gjc team status <team-name> --json",
		"gjc team monitor <team-name> --json",
		'gjc team api claim-task --input \'{"team_name":"demo","worker_id":"worker-1"}\' --json',
		'gjc team 2:executor --dry-run --json "Preview state only"',
		"gjc team shutdown <team-name>",
	];

	async run(): Promise<void> {
		const { flags } = await this.parse(Team);
		const [action = "start", ...rest] = this.argv;
		const json = flags.json ?? this.argv.includes("--json");
		const dryRun = flags["dry-run"] ?? this.argv.includes("--dry-run");

		if (action === "list") {
			const teams = await listGjcTeams();
			if (json) {
				writeJson({ teams });
				return;
			}
			writeText(teams.map(team => `${team.team_name}\t${team.phase}\t${team.task_total} task(s)`));
			return;
		}

		if (action === "status") {
			const teamName = rest.find(arg => !arg.startsWith("--"));
			if (!teamName) throw new Error("missing_team_name");
			const snapshot = await readGjcTeamSnapshot(teamName);
			if (json) {
				writeJson(snapshot);
				return;
			}
			writeText([
				renderTeamStatusMarkdown(snapshot).trimEnd(),
				"- mode: read-only status; use `gjc team monitor <team>` or `gjc team resume <team>` for recovery/integration",
			]);
			void formatTaskCounts(snapshot.task_counts);
			return;
		}

		if (action === "monitor" || action === "resume") {
			const teamName = rest.find(arg => !arg.startsWith("--"));
			if (!teamName) throw new Error("missing_team_name");
			const snapshot = await monitorGjcTeamSnapshot(teamName);
			await syncTeamHud(snapshot);
			if (json) {
				writeReceipt(snapshotWriteReceipt(snapshot));
				return;
			}
			writeText([
				renderTeamStatusMarkdown(snapshot).trimEnd(),
				"- mode: mutating monitor; liveness recovery and integration may have run",
			]);
			void formatTaskCounts(snapshot.task_counts);
			return;
		}

		if (action === "shutdown") {
			const teamName = rest.find(arg => !arg.startsWith("--"));
			if (!teamName) throw new Error("missing_team_name");
			const snapshot = await shutdownGjcTeam(teamName);
			await syncTeamHud(snapshot);
			if (json) {
				writeReceipt(snapshotWriteReceipt(snapshot));
				return;
			}
			writeText([`team: ${snapshot.team_name}`, `phase: ${snapshot.phase}`, `state: ${snapshot.state_dir}`]);
			return;
		}

		if (action === "api") {
			const [operation] = rest;
			if (!operation || operation === "--help" || operation === "help") {
				writeText([
					"Supported operations:",
					"send-message broadcast mailbox-list mailbox-mark-delivered mailbox-mark-notified notification-list notification-read notification-replay notification-mark-pane-attempt worker-startup-ack",
					"create-task read-task list-tasks update-task claim-task transition-task-status release-task-claim",
					"read-config read-manifest read-worker-status update-worker-status read-worker-heartbeat recover-stale-claims update-worker-heartbeat read-worker-memory-guard update-worker-memory-guard apply-worker-memory-guard write-worker-inbox write-worker-identity",
					"append-event read-events read-traces await-event write-shutdown-request read-shutdown-ack read-monitor-snapshot write-monitor-snapshot read-task-approval write-task-approval",
					"Completion example:",
					'transition-task-status --input \'{"team_name":"demo","task_id":"task-1","to":"completed","claim_token":"...","completion_evidence":{"summary":"done","items":[{"kind":"command","status":"passed","summary":"focused tests passed","command":"bun test packages/coding-agent/test/gjc-runtime/team-runtime.test.ts"}]}}\' --json',
					'Review-only completion may use {"kind":"inspection","status":"verified","summary":"review passed","location":"agent://review"}.',
					'Typed lane task example: create-task --input \'{"team_name":"demo","subject":"Verify delivery","description":"Run verification","owner":"worker-1","lane":"verification","required_role":"executor","depends_on":["task-1"]}\' --json',
				]);
				return;
			}
			const input = parseInputFlag(rest);
			const result = await executeGjcTeamApiOperation(operation, input);
			const teamName = String(input.team_name ?? input.teamName ?? "").trim();
			if (teamName) {
				try {
					await syncTeamHud(await readGjcTeamSnapshot(teamName));
				} catch {
					// API operations without a resolvable snapshot leave HUD state unchanged.
				}
			}
			writeReceipt(result as Record<string, unknown>);
			return;
		}

		const startArgs = action === "start" ? rest : this.argv;
		const options = parseTeamLaunchArgs(startArgs);
		const snapshot = await startGjcTeam({ ...options, dryRun });
		await syncTeamHud(snapshot);
		if (json) {
			writeReceipt(snapshotWriteReceipt(snapshot));
			return;
		}
		writeText([
			`team: ${snapshot.team_name}`,
			`phase: ${snapshot.phase}`,
			`tmux: ${snapshot.tmux_session}`,
			`state: ${snapshot.state_dir}`,
			`workers: ${snapshot.workers.length}`,
			...(dryRun
				? [
						"dry-run: wrote ephemeral .gjc/_session-{sessionid}/state/team state only; do not commit generated .gjc state",
					]
				: []),
		]);
	}
}
