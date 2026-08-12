import { createHash } from "node:crypto";
import { createCoordinatorMcpServer } from "../coordinator-mcp/server";
import {
	assertCanonicalCoordinatorWorkdir,
	assertCoordinatorAuthorityUnchanged,
	assertFrozenCoordinatorAuthority,
	type FrozenCoordinatorAuthority,
	freezeCoordinatorAuthority,
} from "./authority";

export const MASTER_COORDINATOR_TOOL_NAMES = [
	"gjc_coordinator_start_session",
	"gjc_coordinator_send_prompt",
	"gjc_coordinator_await_turn",
	"gjc_coordinator_register_session",
] as const;

export type MasterCoordinatorToolName = (typeof MASTER_COORDINATOR_TOOL_NAMES)[number];

export interface CoordinatorCallTarget {
	callTool(name: string, args: Record<string, unknown>): Promise<Record<string, unknown>>;
}

export type CoordinatorGatewayServerFactory = (env: NodeJS.ProcessEnv) => CoordinatorCallTarget;

export interface MasterCoordinatorGatewayOptions {
	authority?: FrozenCoordinatorAuthority;
	env?: NodeJS.ProcessEnv;
	server?: CoordinatorCallTarget;
	createServer?: CoordinatorGatewayServerFactory;
}

export interface CoordinatorStartSessionInput {
	cwd: string;
	idempotency_key: string;
	allow_mutation?: true;
}

export interface CoordinatorSendPromptInput {
	session_id: string;
	prompt: string;
	idempotency_key: string;
	queue?: boolean;
	force?: boolean;
	allow_mutation?: true;
}

export interface CoordinatorAwaitTurnInput {
	turn_id: string;
	session_id?: string;
	timeout_ms?: number;
	poll_interval_ms?: number;
}

export interface CoordinatorRegisterSessionInput {
	session_id: string;
	cwd: string;
	idempotency_key: string;
	visible?: boolean;
	source?: string;
	model?: string;
	tmux_session?: string;
	tmux_target?: string;
	allow_mutation?: true;
}

export type CoordinatorGatewayInput =
	| CoordinatorStartSessionInput
	| CoordinatorSendPromptInput
	| CoordinatorAwaitTurnInput
	| CoordinatorRegisterSessionInput;

export class CoordinatorGatewayError extends Error {
	readonly code: string;

	constructor(code: string, message = code) {
		super(message);
		this.name = "CoordinatorGatewayError";
		this.code = code;
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function canonicalJson(value: unknown): string {
	if (value === null || typeof value === "boolean" || typeof value === "number" || typeof value === "string")
		return JSON.stringify(value);
	if (Array.isArray(value)) return `[${value.map(item => canonicalJson(item)).join(",")}]`;
	if (typeof value === "object") {
		const record = value as Record<string, unknown>;
		return `{${Object.keys(record)
			.sort()
			.map(key => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
			.join(",")}}`;
	}
	throw new CoordinatorGatewayError("gateway_input_invalid", "Coordinator gateway input cannot be serialized.");
}

function digest(value: unknown): string {
	return createHash("sha256").update(canonicalJson(value), "utf8").digest("hex");
}

function clone<T>(value: T): T {
	return structuredClone(value);
}

function assertNonEmptyString(value: unknown, field: string): asserts value is string {
	if (typeof value !== "string" || value.trim().length === 0)
		throw new CoordinatorGatewayError("gateway_input_invalid", `${field} must be a non-empty string.`);
}

function assertOpaqueInput(value: unknown, field: string): asserts value is string {
	assertNonEmptyString(value, field);
	if (value.length > 128 || !/^[\x20-\x7e]+$/.test(value))
		throw new CoordinatorGatewayError(
			"gateway_input_invalid",
			`${field} must be printable ASCII of at most 128 bytes.`,
		);
}

function assertAllowedKeys(value: Record<string, unknown>, allowed: readonly string[]): void {
	const permitted = new Set(allowed);
	for (const key of Object.keys(value)) {
		if (!permitted.has(key))
			throw new CoordinatorGatewayError(
				"gateway_authority_input_forbidden",
				`Coordinator gateway input field is not allowed: ${key}`,
			);
	}
}

function assertMutationFlag(value: Record<string, unknown>): void {
	if (Object.hasOwn(value, "allow_mutation") && value.allow_mutation !== true)
		throw new CoordinatorGatewayError(
			"gateway_mutation_not_allowed",
			"Coordinator gateway mutations require the immutable sessions capability.",
		);
}

function numericOption(value: unknown, field: string, minimum: number, maximum: number): number | undefined {
	if (value === undefined) return undefined;
	if (typeof value !== "number" || !Number.isSafeInteger(value) || value < minimum || value > maximum)
		throw new CoordinatorGatewayError("gateway_input_invalid", `${field} is outside its bounded range.`);
	return value;
}

function normalizeStart(input: unknown): Record<string, unknown> {
	if (!isRecord(input))
		throw new CoordinatorGatewayError("gateway_input_invalid", "start_session input must be an object.");
	assertAllowedKeys(input, ["cwd", "idempotency_key", "allow_mutation"]);
	assertMutationFlag(input);
	assertNonEmptyString(input.cwd, "cwd");
	assertOpaqueInput(input.idempotency_key, "idempotency_key");
	return { cwd: input.cwd, idempotency_key: input.idempotency_key, allow_mutation: true };
}

function normalizeSend(input: unknown): Record<string, unknown> {
	if (!isRecord(input))
		throw new CoordinatorGatewayError("gateway_input_invalid", "send_prompt input must be an object.");
	assertAllowedKeys(input, ["session_id", "prompt", "idempotency_key", "queue", "force", "allow_mutation"]);
	assertMutationFlag(input);
	assertOpaqueInput(input.session_id, "session_id");
	assertNonEmptyString(input.prompt, "prompt");
	assertOpaqueInput(input.idempotency_key, "idempotency_key");
	if (input.queue !== undefined && typeof input.queue !== "boolean")
		throw new CoordinatorGatewayError("gateway_input_invalid", "queue must be boolean.");
	if (input.force !== undefined && typeof input.force !== "boolean")
		throw new CoordinatorGatewayError("gateway_input_invalid", "force must be boolean.");
	return {
		session_id: input.session_id,
		prompt: input.prompt,
		idempotency_key: input.idempotency_key,
		...(input.queue === true ? { queue: true } : {}),
		...(input.force === true ? { force: true } : {}),
		allow_mutation: true,
	};
}

function normalizeAwait(input: unknown): Record<string, unknown> {
	if (!isRecord(input))
		throw new CoordinatorGatewayError("gateway_input_invalid", "await_turn input must be an object.");
	assertAllowedKeys(input, ["turn_id", "session_id", "timeout_ms", "poll_interval_ms"]);
	assertOpaqueInput(input.turn_id, "turn_id");
	if (input.session_id !== undefined) assertOpaqueInput(input.session_id, "session_id");
	const timeoutMs = numericOption(input.timeout_ms, "timeout_ms", 0, 1_800_000);
	const pollIntervalMs = numericOption(input.poll_interval_ms, "poll_interval_ms", 0, 10_000);
	return {
		turn_id: input.turn_id,
		...(input.session_id === undefined ? {} : { session_id: input.session_id }),
		...(timeoutMs === undefined ? {} : { timeout_ms: timeoutMs }),
		...(pollIntervalMs === undefined ? {} : { poll_interval_ms: pollIntervalMs }),
	};
}

function normalizeRegister(input: unknown): Record<string, unknown> {
	if (!isRecord(input))
		throw new CoordinatorGatewayError("gateway_input_invalid", "register_session input must be an object.");
	assertAllowedKeys(input, [
		"session_id",
		"cwd",
		"idempotency_key",
		"visible",
		"source",
		"model",
		"tmux_session",
		"tmux_target",
		"allow_mutation",
	]);
	assertMutationFlag(input);
	assertOpaqueInput(input.session_id, "session_id");
	assertNonEmptyString(input.cwd, "cwd");
	assertOpaqueInput(input.idempotency_key, "idempotency_key");
	for (const field of ["source", "model", "tmux_session", "tmux_target"] as const) {
		if (input[field] !== undefined) assertNonEmptyString(input[field], field);
	}
	if (input.visible !== undefined && typeof input.visible !== "boolean")
		throw new CoordinatorGatewayError("gateway_input_invalid", "visible must be boolean.");
	return {
		session_id: input.session_id,
		cwd: input.cwd,
		idempotency_key: input.idempotency_key,
		...(input.visible === false ? { visible: false } : {}),
		...(input.source === undefined ? {} : { source: input.source }),
		...(input.model === undefined ? {} : { model: input.model }),
		...(input.tmux_session === undefined ? {} : { tmux_session: input.tmux_session }),
		...(input.tmux_target === undefined ? {} : { tmux_target: input.tmux_target }),
		allow_mutation: true,
	};
}

function authorityInput(operation: MasterCoordinatorToolName, input: unknown): Record<string, unknown> {
	if (operation === "gjc_coordinator_start_session") return normalizeStart(input);
	if (operation === "gjc_coordinator_send_prompt") return normalizeSend(input);
	if (operation === "gjc_coordinator_await_turn") return normalizeAwait(input);
	return normalizeRegister(input);
}

export class MasterCoordinatorGateway {
	readonly authority: FrozenCoordinatorAuthority;
	readonly #server: CoordinatorCallTarget;
	readonly #environment: NodeJS.ProcessEnv;
	readonly #idempotency = new Map<string, { requestDigest: string; response: Record<string, unknown> }>();

	constructor(authority: FrozenCoordinatorAuthority, server?: CoordinatorCallTarget, environment?: NodeJS.ProcessEnv) {
		assertFrozenCoordinatorAuthority(authority);
		this.authority = authority;
		this.#environment = environment ?? (authority.env as NodeJS.ProcessEnv);
		this.#server = server ?? createCoordinatorMcpServer({ env: authority.env as NodeJS.ProcessEnv });
	}

	static async create(options: MasterCoordinatorGatewayOptions = {}): Promise<MasterCoordinatorGateway> {
		const authority = options.authority ?? (await freezeCoordinatorAuthority(options.env ?? process.env));
		const server = options.server ?? options.createServer?.(authority.env as NodeJS.ProcessEnv);
		return new MasterCoordinatorGateway(authority, server, options.env ?? (authority.env as NodeJS.ProcessEnv));
	}

	async assertAdmittedWorkdir(cwd: unknown): Promise<string> {
		await assertCoordinatorAuthorityUnchanged(this.authority, this.#environment);

		return await assertCanonicalCoordinatorWorkdir(this.authority, cwd);
	}

	async callTool(name: MasterCoordinatorToolName | string, input: unknown = {}): Promise<Record<string, unknown>> {
		if (!(MASTER_COORDINATOR_TOOL_NAMES as readonly string[]).includes(name))
			throw new CoordinatorGatewayError("gateway_tool_forbidden", `Coordinator tool is not allowlisted: ${name}`);
		await assertCoordinatorAuthorityUnchanged(this.authority, this.#environment);
		const operation = name as MasterCoordinatorToolName;
		const args = authorityInput(operation, input);
		if (operation === "gjc_coordinator_start_session" || operation === "gjc_coordinator_register_session")
			args.cwd = await assertCanonicalCoordinatorWorkdir(this.authority, args.cwd);
		const idempotencyKey = typeof args.idempotency_key === "string" ? args.idempotency_key : null;
		const key = idempotencyKey === null ? null : `${operation}\0${idempotencyKey}`;
		const requestDigest = digest(args);
		const existing = key === null ? undefined : this.#idempotency.get(key);
		if (existing !== undefined) {
			if (existing.requestDigest !== requestDigest)
				throw new CoordinatorGatewayError(
					"gateway_idempotency_conflict",
					"Coordinator gateway idempotency key was reused with different input.",
				);
			return clone(existing.response);
		}
		const response = await this.#server.callTool(operation, args);
		if (!isRecord(response))
			throw new CoordinatorGatewayError("gateway_response_invalid", "Coordinator returned a non-object response.");
		if (key !== null) this.#idempotency.set(key, { requestDigest, response: clone(response) });
		return clone(response);
	}

	async call(name: MasterCoordinatorToolName | string, input: unknown = {}): Promise<Record<string, unknown>> {
		return await this.callTool(name, input);
	}

	async invoke(name: MasterCoordinatorToolName | string, input: unknown = {}): Promise<Record<string, unknown>> {
		return await this.callTool(name, input);
	}

	async startSession(input: CoordinatorStartSessionInput): Promise<Record<string, unknown>> {
		return await this.callTool("gjc_coordinator_start_session", input);
	}

	async sendPrompt(input: CoordinatorSendPromptInput): Promise<Record<string, unknown>> {
		return await this.callTool("gjc_coordinator_send_prompt", input);
	}

	async awaitTurn(input: CoordinatorAwaitTurnInput): Promise<Record<string, unknown>> {
		return await this.callTool("gjc_coordinator_await_turn", input);
	}

	async registerSession(input: CoordinatorRegisterSessionInput): Promise<Record<string, unknown>> {
		return await this.callTool("gjc_coordinator_register_session", input);
	}
}

export const CoordinatorGateway = MasterCoordinatorGateway;
export const FrozenCoordinatorGateway = MasterCoordinatorGateway;

export async function createMasterCoordinatorGateway(
	options: MasterCoordinatorGatewayOptions = {},
): Promise<MasterCoordinatorGateway> {
	return await MasterCoordinatorGateway.create(options);
}

export const createCoordinatorGateway = createMasterCoordinatorGateway;

export function isMasterCoordinatorToolName(value: unknown): value is MasterCoordinatorToolName {
	return typeof value === "string" && (MASTER_COORDINATOR_TOOL_NAMES as readonly string[]).includes(value);
}
