import { Args, Command, Flags } from "@gajae-code/utils/cli";
import {
	claimGjcTeamTask,
	type GjcTeamTaskStatus,
	listGjcTeams,
	parseTeamLaunchArgs,
	readGjcTeamSnapshot,
	shutdownGjcTeam,
	startGjcTeam,
	transitionGjcTeamTask,
} from "../gjc-runtime/team-runtime";

function writeJson(value: unknown): void {
	process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function writeText(lines: string[]): void {
	process.stdout.write(`${lines.join("\n")}\n`);
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

function stringField(input: Record<string, unknown>, name: string): string {
	const value = input[name];
	return typeof value === "string" ? value.trim() : "";
}

function isTaskStatus(value: string): value is GjcTeamTaskStatus {
	return ["pending", "in_progress", "complete", "failed", "blocked"].includes(value);
}

export default class Team extends Command {
	static description = "Run native gjc tmux team orchestration commands";
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
		'gjc team api claim-task --input \'{"team_name":"demo","worker_id":"worker-01"}\' --json',
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
			const snapshot = await readGjcTeamSnapshot(teamName);
			if (json) {
				writeJson(snapshot);
				return;
			}
			writeText([
				`team: ${snapshot.team_name}`,
				`phase: ${snapshot.phase}`,
				`tmux: ${snapshot.tmux_session}`,
				`state: ${snapshot.state_dir}`,
				`tasks: ${snapshot.task_total}`,
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
			const input = parseInputFlag(rest);
			const teamName = stringField(input, "team_name") || stringField(input, "teamName");
			if (!teamName) throw new Error("missing_team_name");
			if (operation === "claim-task") {
				const workerId = stringField(input, "worker_id") || stringField(input, "workerId") || "worker-01";
				writeJson(await claimGjcTeamTask(teamName, workerId));
				return;
			}
			if (operation === "transition-task") {
				const taskId = stringField(input, "task_id") || stringField(input, "taskId");
				const status = stringField(input, "status");
				if (!taskId) throw new Error("missing_task_id");
				if (!isTaskStatus(status)) throw new Error(`invalid_task_status:${status}`);
				writeJson({ ok: true, task: await transitionGjcTeamTask(teamName, taskId, status) });
				return;
			}
			throw new Error(`unknown_team_api_operation:${operation ?? ""}`);
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
