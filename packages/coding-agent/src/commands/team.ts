import { Args, Command, Flags } from "@gajae-code/utils/cli";
import {
	executeGjcTeamApiOperation,
	listGjcTeams,
	monitorGjcTeam,
	parseTeamLaunchArgs,
	shutdownGjcTeam,
	startGjcTeam,
} from "../gjc-runtime/team-runtime";

function writeJson(value: unknown): void {
	process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function writeText(lines: string[]): void {
	process.stdout.write(`${lines.join("\n")}\n`);
}

function formatTaskCounts(counts: Record<string, number>): string {
	return Object.entries(counts)
		.map(([status, count]) => `${status}=${count}`)
		.join(" ");
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
	static description = "Run native GJC tmux team orchestration commands";
	static strict = false;

	static args = {
		action: Args.string({
			description: "start (default), status, list, shutdown, resume, or api",
			required: false,
		}),
	};

	static flags = {
		json: Flags.boolean({ char: "j", description: "Emit machine-readable JSON", default: false }),
		"dry-run": Flags.boolean({ description: "Create team state without starting tmux panes", default: false }),
	};

	static examples = [
		'gjc team 3:executor "Implement the approved plan"',
		"gjc team status <team-name> --json",
		'gjc team api claim-task --input \'{"team_name":"demo","worker_id":"worker-1"}\' --json',
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
				...formatIntegrationSummary(snapshot),
			]);
			return;
		}

		if (action === "shutdown") {
			const teamName = rest.find(arg => !arg.startsWith("--"));
			if (!teamName) throw new Error("missing_team_name");
			const snapshot = await shutdownGjcTeam(teamName);
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
					"send-message broadcast mailbox-list mailbox-mark-delivered mailbox-mark-notified",
					"create-task read-task list-tasks update-task claim-task transition-task-status release-task-claim",
					"read-config read-manifest read-worker-status read-worker-heartbeat update-worker-heartbeat write-worker-inbox write-worker-identity",
					"append-event read-events await-event write-shutdown-request read-shutdown-ack read-monitor-snapshot write-monitor-snapshot read-task-approval write-task-approval",
				]);
				return;
			}
			const input = parseInputFlag(rest);
			writeJson(await executeGjcTeamApiOperation(operation, input));
			return;
		}

		const startArgs = action === "start" ? rest : this.argv;
		const options = parseTeamLaunchArgs(startArgs);
		const snapshot = await startGjcTeam({ ...options, dryRun });
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
		]);
	}
}
