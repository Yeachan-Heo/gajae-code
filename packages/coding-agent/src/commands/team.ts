import { Args, Command, Flags } from "@gajae-code/utils/cli";
import {
	buildTeamHudSummary,
	executeGjcTeamApiOperation,
	type GjcTeamSnapshot,
	listGjcTeams,
	monitorGjcTeam,
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

function formatNotificationSummary(snapshot: GjcTeamSnapshot): string {
	const summary = snapshot.notification_summary;
	return `notifications: total=${summary.total} replay_eligible=${summary.replay_eligible} pending=${summary.by_state.pending} queued=${summary.by_state.queued} deferred=${summary.by_state.deferred} failed=${summary.by_state.failed}`;
}

function formatAwaitingIntegrationNextStep(snapshot: GjcTeamSnapshot): string[] {
	if (snapshot.phase !== "awaiting_integration") return [];
	return [
		"next: worker tasks are completed, but integration still needs leader attention before the team is complete",
	];
}

function formatIntegrationSummary(snapshot: {
	integration_by_worker?: Record<string, { status?: string; conflict_files?: string[] }>;
}): string[] {
	const entries = Object.entries(snapshot.integration_by_worker ?? {});
	if (entries.length === 0) return ["integration: no attempts recorded"];
	return entries.map(([worker, state]) => {
		const files = state.conflict_files?.length ? ` files=${state.conflict_files.join(",")}` : "";
		return `integration: ${worker} ${state.status ?? "unknown"}${files}`;
	});
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
	static description = "Run native GJC tmux team orchestration; --dry-run writes ephemeral .gjc/state/team state only";
	static strict = false;

	static args = {
		action: Args.string({
			description: "start (default), status, list, shutdown, resume, or api",
			required: false,
		}),
	};

	static flags = {
		json: Flags.boolean({ char: "j", description: "Emit machine-readable JSON", default: false }),
		"dry-run": Flags.boolean({
			description:
				"Create ephemeral .gjc/state/team state without starting tmux panes; do not commit generated state",
			default: false,
		}),
	};

	static examples = [
		'gjc team 3:executor "Implement the approved plan"',
		"gjc team status <team-name> --json",
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

		if (action === "status" || action === "resume") {
			const teamName = rest.find(arg => !arg.startsWith("--"));
			if (!teamName) throw new Error("missing_team_name");
			const snapshot = await monitorGjcTeam(teamName);
			await syncTeamHud(snapshot);
			if (json) {
				writeJson(snapshot);
				return;
			}
			writeText([
				`team: ${snapshot.team_name}`,
				`phase: ${snapshot.phase}`,
				`tmux: ${snapshot.tmux_target || snapshot.tmux_session}`,
				`state: ${snapshot.state_dir}`,
				`tasks: ${snapshot.task_total} (${formatTaskCounts(snapshot.task_counts)})`,
				`workers: ${snapshot.workers.map(worker => `${worker.id}:${worker.status}`).join(" ")}`,
				formatNotificationSummary(snapshot),
				...formatAwaitingIntegrationNextStep(snapshot),
				...formatIntegrationSummary(snapshot),
			]);
			return;
		}

		if (action === "shutdown") {
			const teamName = rest.find(arg => !arg.startsWith("--"));
			if (!teamName) throw new Error("missing_team_name");
			const snapshot = await shutdownGjcTeam(teamName);
			await syncTeamHud(snapshot);
			if (json) {
				writeJson(snapshot);
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
					"read-config read-manifest read-worker-status read-worker-heartbeat update-worker-heartbeat write-worker-inbox write-worker-identity",
					"append-event read-events await-event write-shutdown-request read-shutdown-ack read-monitor-snapshot write-monitor-snapshot read-task-approval write-task-approval",
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
			writeJson(result);
			return;
		}

		const startArgs = action === "start" ? rest : this.argv;
		const options = parseTeamLaunchArgs(startArgs);
		const snapshot = await startGjcTeam({ ...options, dryRun });
		await syncTeamHud(snapshot);
		if (json) {
			writeJson(snapshot);
			return;
		}
		writeText([
			`team: ${snapshot.team_name}`,
			`phase: ${snapshot.phase}`,
			`tmux: ${snapshot.tmux_session}`,
			`state: ${snapshot.state_dir}`,
			`workers: ${snapshot.workers.length}`,
			...(dryRun ? ["dry-run: wrote ephemeral .gjc/state/team state only; do not commit generated .gjc state"] : []),
		]);
	}
}
