import * as fs from "node:fs/promises";
import * as path from "node:path";
export const GJC_SESSION_FILE_ENV = "GJC_SESSION_FILE";
export const GJC_SESSION_ID_ENV = "GJC_SESSION_ID";
export const GJC_SESSION_CWD_ENV = "GJC_SESSION_CWD";

const REQUEST_VERSION = 1;
const DEFAULT_ULTRAGOAL_OBJECTIVE =
	"Complete the durable ultragoal plan in .gjc/ultragoal/goals.json, including later accepted/appended stories, under the original brief constraints; use .gjc/ultragoal/ledger.jsonl as the audit trail.";

export interface PendingGoalModeRequest {
	version: typeof REQUEST_VERSION;
	kind: "goal_mode_request";
	source: "ultragoal";
	objective: string;
	createdAt: string;
	goalsPath?: string;
}

interface UltragoalPlanShape {
	codexObjective?: unknown;
}

function isEnoent(error: unknown): boolean {
	return (
		typeof error === "object" && error !== null && "code" in error && (error as { code?: unknown }).code === "ENOENT"
	);
}

function requestPath(cwd: string): string {
	return path.join(cwd, ".gjc", "state", "goal-mode-request.json");
}

function ultragoalGoalsPath(cwd: string): string {
	return path.join(cwd, ".gjc", "ultragoal", "goals.json");
}

function isCreateGoalsArg(value: string): boolean {
	return value === "create-goals" || value === "create";
}

export function isUltragoalCreateGoalsInvocation(args: readonly string[]): boolean {
	const command = args.find(arg => !arg.startsWith("-"));
	return command !== undefined && isCreateGoalsArg(command);
}

export async function readUltragoalCodexObjective(cwd: string): Promise<{ objective: string; goalsPath: string }> {
	const goalsPath = ultragoalGoalsPath(cwd);
	try {
		const plan = (await Bun.file(goalsPath).json()) as UltragoalPlanShape;
		const objective = typeof plan.codexObjective === "string" ? plan.codexObjective.trim() : "";
		return { objective: objective || DEFAULT_ULTRAGOAL_OBJECTIVE, goalsPath };
	} catch (error) {
		if (isEnoent(error)) {
			return { objective: DEFAULT_ULTRAGOAL_OBJECTIVE, goalsPath };
		}
		throw error;
	}
}

export async function writePendingGoalModeRequest(input: {
	cwd: string;
	objective: string;
	goalsPath?: string;
}): Promise<PendingGoalModeRequest> {
	const objective = input.objective.trim();
	if (!objective) throw new Error("goal objective is required");
	const request: PendingGoalModeRequest = {
		version: REQUEST_VERSION,
		kind: "goal_mode_request",
		source: "ultragoal",
		objective,
		createdAt: new Date().toISOString(),
		goalsPath: input.goalsPath,
	};
	const filePath = requestPath(input.cwd);
	await fs.mkdir(path.dirname(filePath), { recursive: true });
	await Bun.write(filePath, `${JSON.stringify(request, null, 2)}\n`);
	return request;
}

export async function consumePendingGoalModeRequest(cwd: string): Promise<PendingGoalModeRequest | null> {
	const filePath = requestPath(cwd);
	let raw: unknown;
	try {
		raw = await Bun.file(filePath).json();
	} catch (error) {
		if (isEnoent(error)) return null;
		throw error;
	}
	const candidate = raw as Partial<PendingGoalModeRequest>;
	if (
		candidate.version !== REQUEST_VERSION ||
		candidate.kind !== "goal_mode_request" ||
		candidate.source !== "ultragoal" ||
		typeof candidate.objective !== "string" ||
		candidate.objective.trim().length === 0
	) {
		return null;
	}
	await fs.unlink(filePath).catch(error => {
		if (!isEnoent(error)) throw error;
	});
	return { ...candidate, objective: candidate.objective.trim() } as PendingGoalModeRequest;
}

export function buildGjcRuntimeSessionEnv(input: {
	sessionFile?: string | null;
	sessionId?: string | null;
	cwd?: string | null;
}): Record<string, string> {
	const env: Record<string, string> = {};
	if (input.sessionFile) env[GJC_SESSION_FILE_ENV] = input.sessionFile;
	if (input.sessionId) env[GJC_SESSION_ID_ENV] = input.sessionId;
	if (input.cwd) env[GJC_SESSION_CWD_ENV] = input.cwd;
	return env;
}
