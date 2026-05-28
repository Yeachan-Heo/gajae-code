import { spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { normalizeWorkflowHudSummary, type WorkflowHudSummary } from "../skill-state/active-state";

const BRIDGE_ENV = "GJC_RUNTIME_BINARY";
const LEGACY_BRIDGE_ENV = "GJC_LEGACY_RUNTIME_BINARY";
const GUARD_ENV = "GJC_RUNTIME_BRIDGE_ACTIVE";
export const WORKFLOW_HUD_PROTOCOL = "workflow-hud-summary-v1";

export interface GjcRuntimeBridgeResult {
	status: number;
	error?: string;
}

const SKILL_ENTRYPOINT_ENDPOINTS = new Set(["deep-interview", "ralplan"]);

export interface WorkflowHudBridgePayload {
	version: 1;
	skill: string;
	phase?: string;
	active?: boolean;
	session_id?: string;
	thread_id?: string;
	turn_id?: string;
	hud: WorkflowHudSummary;
}

export interface GjcRuntimeHudBridgeResult extends GjcRuntimeBridgeResult {
	hudPayload?: WorkflowHudBridgePayload;
}

export interface GjcRuntimeHudBridgeOptions {
	cwd?: string;
	env?: NodeJS.ProcessEnv;
	sidecarSkill: string;
	onHudPayload?: (payload: WorkflowHudBridgePayload) => Promise<void> | void;
	pollIntervalMs?: number;
}

function candidateBinaries(env: NodeJS.ProcessEnv): string[] {
	return [env[BRIDGE_ENV], env[LEGACY_BRIDGE_ENV]].filter(
		(value): value is string => typeof value === "string" && value.trim().length > 0,
	);
}

function isPathLike(command: string): boolean {
	return command.includes("/") || command.includes("\\");
}

function canAttempt(command: string): boolean {
	return !isPathLike(command) || existsSync(command);
}

function unavailableBridgeResult(
	endpoint: string,
	env: NodeJS.ProcessEnv,
	attempted: string[],
): GjcRuntimeBridgeResult {
	const configured = [env[BRIDGE_ENV], env[LEGACY_BRIDGE_ENV]].filter(Boolean).join(", ");
	const guidance = SKILL_ENTRYPOINT_ENDPOINTS.has(endpoint)
		? `Inside a GJC agent session, invoke /skill:${endpoint} instead so the bundled skill is loaded directly.`
		: `Configure ${BRIDGE_ENV} with a GJC-compatible private runtime binary for the ${endpoint} endpoint.`;
	return {
		status: 1,
		error: [
			`gjc ${endpoint} is a private runtime bridge command.`,
			guidance,
			`Only private runtime deployments should call this bridge command; configure them with ${BRIDGE_ENV}.`,
			configured
				? `Configured runtime candidates failed: ${configured}.`
				: "No private GJC runtime binary was configured.",
			attempted.length > 0 ? `Attempted: ${attempted.join(", ")}.` : undefined,
		]
			.filter(Boolean)
			.join("\n"),
	};
}

export function normalizeWorkflowHudBridgePayload(
	raw: unknown,
	expectedSkill: string,
): WorkflowHudBridgePayload | null {
	if (!raw || typeof raw !== "object") return null;
	const record = raw as Record<string, unknown>;
	if (record.version !== 1 || record.skill !== expectedSkill) return null;
	const hud = normalizeWorkflowHudSummary(record.hud);
	if (!hud) return null;
	return {
		version: 1,
		skill: expectedSkill,
		phase: typeof record.phase === "string" && record.phase.trim() ? record.phase.trim() : undefined,
		active: typeof record.active === "boolean" ? record.active : undefined,
		session_id:
			typeof record.session_id === "string" && record.session_id.trim() ? record.session_id.trim() : undefined,
		thread_id: typeof record.thread_id === "string" && record.thread_id.trim() ? record.thread_id.trim() : undefined,
		turn_id: typeof record.turn_id === "string" && record.turn_id.trim() ? record.turn_id.trim() : undefined,
		hud,
	};
}

async function readHudPayload(sidecarPath: string, expectedSkill: string): Promise<WorkflowHudBridgePayload | null> {
	try {
		return normalizeWorkflowHudBridgePayload(JSON.parse(await Bun.file(sidecarPath).text()), expectedSkill);
	} catch {
		return null;
	}
}

export function runGjcRuntimeBridge(
	endpoint: string,
	args: string[],
	env: NodeJS.ProcessEnv = process.env,
): GjcRuntimeBridgeResult {
	if (env[GUARD_ENV] === "1") {
		return {
			status: 1,
			error: `Refusing recursive gjc runtime bridge for ${endpoint}.`,
		};
	}

	const attempted: string[] = [];
	for (const binary of candidateBinaries(env)) {
		const command = binary.trim();
		if (!canAttempt(command)) continue;
		attempted.push(command);
		const child = spawnSync(command, [endpoint, ...args], {
			stdio: "inherit",
			env: {
				...env,
				[GUARD_ENV]: "1",
			},
		});

		if (child.error) {
			const error = child.error as NodeJS.ErrnoException;
			if (error.code === "ENOENT") continue;
			return { status: 1, error: error.message };
		}

		return { status: child.status ?? (child.signal ? 1 : 0) };
	}

	return unavailableBridgeResult(endpoint, env, attempted);
}

export async function runGjcRuntimeBridgeWithHudSidecar(
	endpoint: string,
	args: string[],
	options: GjcRuntimeHudBridgeOptions,
): Promise<GjcRuntimeHudBridgeResult> {
	const env = options.env ?? process.env;
	if (env[GUARD_ENV] === "1") return { status: 1, error: `Refusing recursive gjc runtime bridge for ${endpoint}.` };

	const attempted: string[] = [];
	for (const binary of candidateBinaries(env)) {
		const command = binary.trim();
		if (!canAttempt(command)) continue;
		attempted.push(command);
		const sidecarDir = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-workflow-hud-"));
		const sidecarPath = path.join(sidecarDir, `${options.sidecarSkill}-${randomUUID()}.json`);
		let latestPayload: WorkflowHudBridgePayload | undefined;
		let lastRaw = "";
		const publishPayload = async (): Promise<void> => {
			let raw = "";
			try {
				raw = await Bun.file(sidecarPath).text();
			} catch {
				return;
			}
			if (!raw || raw === lastRaw) return;
			lastRaw = raw;
			const payload = await readHudPayload(sidecarPath, options.sidecarSkill);
			if (!payload) return;
			latestPayload = payload;
			try {
				await options.onHudPayload?.(payload);
			} catch {
				// HUD sidecar sync is best-effort and must not change child command semantics.
			}
		};
		try {
			const child = spawn(command, [endpoint, ...args], {
				cwd: options.cwd,
				stdio: "inherit",
				env: {
					...env,
					[GUARD_ENV]: "1",
					GJC_WORKFLOW_HUD_PROTOCOL: WORKFLOW_HUD_PROTOCOL,
					GJC_WORKFLOW_HUD_SIDECAR: sidecarPath,
					GJC_WORKFLOW_HUD_SKILL: options.sidecarSkill,
				},
			});
			const interval = setInterval(() => {
				void publishPayload();
			}, options.pollIntervalMs ?? 100);
			const exit = Promise.withResolvers<{ status: number; error?: string; code?: string }>();
			child.on("error", error => {
				const fsError = error as NodeJS.ErrnoException;
				exit.resolve({ status: 1, error: error.message, code: fsError.code });
			});
			child.on("exit", (code, signal) => exit.resolve({ status: code ?? (signal ? 1 : 0) }));
			const result = await exit.promise;
			clearInterval(interval);
			await publishPayload();
			if (result.code === "ENOENT") continue;
			return {
				status: result.status,
				...(result.error ? { error: result.error } : {}),
				...(latestPayload ? { hudPayload: latestPayload } : {}),
			};
		} finally {
			await fs.rm(sidecarDir, { recursive: true, force: true });
		}
	}

	return unavailableBridgeResult(endpoint, env, attempted);
}

export async function runBridgedRuntimeEndpoint(endpoint: string, args: string[]): Promise<void> {
	const result = runGjcRuntimeBridge(endpoint, args);
	if (result.error) process.stderr.write(`${result.error}\n`);
	process.exitCode = result.status;
}
