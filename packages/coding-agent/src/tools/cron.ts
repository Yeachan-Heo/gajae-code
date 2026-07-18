import { randomBytes } from "node:crypto";
import type { AgentTool, AgentToolContext, AgentToolResult, AgentToolUpdateCallback } from "@gajae-code/agent-core";
import { logger, prompt } from "@gajae-code/utils";
import * as z from "zod/v4";
import { AsyncJobManager, isBackgroundJobSupportEnabled } from "../async";
import cronDescription from "../prompts/tools/cron.md" with { type: "text" };
import type { ToolSession } from "./index";
import { ToolError } from "./tool-errors";

/** Maximum scheduled tasks per owner. Mirrors upstream Claude Code's 50-task cap. */
export const MAX_CRON_TASKS_PER_OWNER = 50;

/** Recurring tasks auto-expire 7 days after creation (mirrors upstream). */
export const CRON_RECURRING_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

const CRON_ID_LENGTH = 8;
const MAX_CRON_SCAN_MINUTES = 366 * 24 * 60;
const MAX_RECURRING_JITTER_MS = 30 * 60 * 1000;
const MAX_ONE_SHOT_EARLY_JITTER_MS = 90 * 1000;
const MAX_TIMEOUT_MS = 2_147_483_647;

const cronSchema = z
	.object({
		op: z
			.enum(["create", "list", "delete"])
			.describe(
				"operation: 'create' schedules a prompt on a cron expression, 'list' enumerates scheduled tasks, 'delete' cancels a task by id",
			),
		cron_expression: z
			.string()
			.optional()
			.describe(
				"(op=create, required) Standard 5-field cron expression in the user's local timezone: 'minute hour day-of-month month day-of-week'. Examples: '*/5 * * * *' (every 5 min), '0 9 * * *' (9am daily), '0 9 * * 1-5' (weekdays at 9am). Day-of-week uses 0/7 for Sunday through 6 for Saturday. When both day-of-month and day-of-week are constrained, a date matches if either field matches (vixie-cron semantics).",
			),
		prompt: z
			.string()
			.optional()
			.describe(
				"(op=create, required) Prompt to inject between turns when the cron fires. May reference slash commands (e.g. '/review-pr 1234') or natural-language instructions.",
			),
		recurring: z
			.boolean()
			.optional()
			.describe(
				"(op=create) true to fire on every match of the cron expression (recurring, auto-expires after 7 days); false to fire once at the next match and then self-delete.",
			),
		id: z.string().optional().describe("(op=delete, required) The 8-character job ID returned by op=create."),
	})
	.strict();

export type CronParams = z.infer<typeof cronSchema>;

export interface CronJobSnapshot {
	id: string;
	cron_expression: string;
	prompt: string;
	recurring: boolean;
	createdAt: number;
	expiresAt?: number;
	nextFireAt?: number;
	/** True while this owner-scoped schedule's delivery is in progress. */
	firing?: boolean;
	humanSchedule: string;
	ownerId?: string;
}

export interface CronListJobDetails {
	id: string;
	cron: string;
	recurring: boolean;
	prompt: string;
	humanSchedule: string;
}

export interface CronToolDetails {
	op: "create" | "list" | "delete";
	id?: string;
	cron_expression?: string;
	recurring?: boolean;
	nextFireAt?: number;
	jobs?: CronListJobDetails[];
	deleted?: boolean;
}

interface CronTimerHandle {
	clear(): void;
}

interface CronScheduleRecord {
	snapshot: CronJobSnapshot;
	session: ToolSession;
	timer?: CronTimerHandle;
	expiryTimer?: CronTimerHandle;
	disposed: boolean;
}

interface OwnerScheduleState {
	jobs: Map<string, CronScheduleRecord>;
	cleanupRegistered: boolean;
}

const schedulesByOwner = new Map<string, OwnerScheduleState>();

function ownerKey(ownerId: string | undefined): string {
	return ownerId ?? "__legacy__";
}

function getOrCreateOwnerState(ownerId: string | undefined): OwnerScheduleState {
	const key = ownerKey(ownerId);
	let state = schedulesByOwner.get(key);
	if (!state) {
		state = { jobs: new Map(), cleanupRegistered: false };
		schedulesByOwner.set(key, state);
	}
	return state;
}

function clearTimer(handle: CronTimerHandle | undefined): void {
	handle?.clear();
}

function disposeRecord(record: CronScheduleRecord): void {
	record.disposed = true;
	clearTimer(record.timer);
	clearTimer(record.expiryTimer);
	record.timer = undefined;
	record.expiryTimer = undefined;
}

function deleteRecord(ownerId: string | undefined, id: string): boolean {
	const key = ownerKey(ownerId);
	const state = schedulesByOwner.get(key);
	const record = state?.jobs.get(id);
	if (!state || !record) return false;
	disposeRecord(record);
	const deleted = state.jobs.delete(id);
	if (state.jobs.size === 0) schedulesByOwner.delete(key);
	if (deleted) notifyCronChange();
	return deleted;
}

function ensureOwnerCleanup(ownerId: string | undefined, manager: AsyncJobManager, state: OwnerScheduleState): void {
	if (state.cleanupRegistered) return;
	if (!ownerId) return;
	manager.registerOwnerCleanup(ownerId, () => {
		clearOwnerSchedules(ownerId);
	});
	state.cleanupRegistered = true;
}

/** Clear every schedule for an owner. Exported for tests + lifecycle teardown. */
export function clearOwnerSchedules(ownerId: string | undefined): void {
	const key = ownerKey(ownerId);
	const state = schedulesByOwner.get(key);
	if (!state) return;
	for (const record of state.jobs.values()) disposeRecord(record);
	state.jobs.clear();
	state.cleanupRegistered = false;
	schedulesByOwner.delete(key);
	notifyCronChange();
}

/** Reset every owner's schedule store. Test-only. */
export function resetCronRegistryForTests(): void {
	for (const key of Array.from(schedulesByOwner.keys())) {
		const ownerId = key === "__legacy__" ? undefined : key;
		clearOwnerSchedules(ownerId);
	}
	schedulesByOwner.clear();
	notifyCronChange();
}

/** Module-level listeners notified whenever the cron schedule set changes. */
const cronChangeListeners = new Set<() => void>();

/** Subscribe to cron schedule-set changes. Returns an unsubscribe function. */
export function onCronChange(cb: () => void): () => void {
	cronChangeListeners.add(cb);
	return () => {
		cronChangeListeners.delete(cb);
	};
}

function notifyCronChange(): void {
	for (const cb of cronChangeListeners) {
		try {
			cb();
		} catch (error) {
			logger.warn("Cron change listener failed", {
				error: error instanceof Error ? error.message : String(error),
			});
		}
	}
}

/** Snapshot the scheduled cron jobs for an owner (or all owners when omitted). */
export function listCronSnapshots(ownerId?: string): CronJobSnapshot[] {
	const out: CronJobSnapshot[] = [];
	if (ownerId !== undefined) {
		const state = schedulesByOwner.get(ownerKey(ownerId));
		if (state) {
			for (const record of state.jobs.values()) out.push(record.snapshot);
		}
		return out;
	}
	for (const state of schedulesByOwner.values()) {
		for (const record of state.jobs.values()) out.push(record.snapshot);
	}
	return out;
}

/** Delete a scheduled cron job by owner-scoped id. Returns true when removed. */
export function deleteCronJobById(ownerId: string | undefined, id: string): boolean {
	return deleteRecord(ownerId, id);
}

const CRON_FIELD_BOUNDS: Array<{ name: string; min: number; max: number }> = [
	{ name: "minute", min: 0, max: 59 },
	{ name: "hour", min: 0, max: 23 },
	{ name: "day-of-month", min: 1, max: 31 },
	{ name: "month", min: 1, max: 12 },
	{ name: "day-of-week", min: 0, max: 7 },
];

function validateCronField(spec: string, bounds: { name: string; min: number; max: number }): void {
	if (spec === "*") return;
	const parts = spec.split(",");
	for (const part of parts) {
		const stepSplit = part.split("/");
		if (stepSplit.length > 2) {
			throw new ToolError(`Invalid cron expression: bad step in ${bounds.name} field '${part}'.`);
		}
		const [rangePart, stepRaw] = stepSplit;
		if (!rangePart) {
			throw new ToolError(`Invalid cron expression: empty ${bounds.name} field segment.`);
		}
		if (stepRaw !== undefined) {
			const step = Number(stepRaw);
			if (!Number.isInteger(step) || step <= 0) {
				throw new ToolError(
					`Invalid cron expression: step value must be a positive integer in ${bounds.name} field.`,
				);
			}
		}
		if (rangePart === "*") continue;
		const rangeSplit = rangePart.split("-");
		if (rangeSplit.length > 2) {
			throw new ToolError(`Invalid cron expression: bad range in ${bounds.name} field '${rangePart}'.`);
		}
		for (const raw of rangeSplit) {
			const value = Number(raw);
			if (!Number.isInteger(value) || value < bounds.min || value > bounds.max) {
				throw new ToolError(
					`Invalid cron expression: value '${raw}' out of range for ${bounds.name} (${bounds.min}-${bounds.max}).`,
				);
			}
		}
		if (rangeSplit.length === 2) {
			const [lo, hi] = rangeSplit.map(Number);
			if (lo > hi) {
				throw new ToolError(
					`Invalid cron expression: range must be ascending in ${bounds.name} field '${rangePart}'.`,
				);
			}
		}
	}
}

export function validateCronExpression(expression: string): void {
	const trimmed = expression.trim();
	if (!trimmed) {
		throw new ToolError("Invalid cron expression: expression must not be empty.");
	}
	const fields = trimmed.split(/\s+/);
	if (fields.length !== 5) {
		throw new ToolError(
			"Invalid cron expression: expected 5 space-separated fields (minute hour day month weekday).",
		);
	}
	for (let i = 0; i < CRON_FIELD_BOUNDS.length; i += 1) {
		validateCronField(fields[i]!, CRON_FIELD_BOUNDS[i]!);
	}
}

interface ParsedCronExpression {
	minute: Set<number>;
	hour: Set<number>;
	dayOfMonth: Set<number>;
	month: Set<number>;
	dayOfWeek: Set<number>;
	dayOfMonthRestricted: boolean;
	dayOfWeekRestricted: boolean;
}

function expandCronField(
	spec: string,
	bounds: { min: number; max: number },
	normalize?: (value: number) => number,
): Set<number> {
	const values = new Set<number>();
	for (const part of spec.split(",")) {
		const [rangePartRaw, stepRaw] = part.split("/");
		const rangePart = rangePartRaw!;
		const step = stepRaw === undefined ? 1 : Number(stepRaw);
		const [loRaw, hiRaw] = rangePart === "*" ? [String(bounds.min), String(bounds.max)] : rangePart.split("-");
		const lo = Number(loRaw);
		const hi = hiRaw === undefined ? lo : Number(hiRaw);
		for (let value = lo; value <= hi; value += step) {
			values.add(normalize ? normalize(value) : value);
		}
	}
	return values;
}

function parseCronExpression(expression: string): ParsedCronExpression {
	validateCronExpression(expression);
	const [minute, hour, dayOfMonth, month, dayOfWeek] = expression.trim().split(/\s+/);
	return {
		minute: expandCronField(minute!, CRON_FIELD_BOUNDS[0]!),
		hour: expandCronField(hour!, CRON_FIELD_BOUNDS[1]!),
		dayOfMonth: expandCronField(dayOfMonth!, CRON_FIELD_BOUNDS[2]!),
		month: expandCronField(month!, CRON_FIELD_BOUNDS[3]!),
		dayOfWeek: expandCronField(dayOfWeek!, CRON_FIELD_BOUNDS[4]!, value => (value === 7 ? 0 : value)),
		dayOfMonthRestricted: dayOfMonth !== "*",
		dayOfWeekRestricted: dayOfWeek !== "*",
	};
}

function matchesCronDate(parsed: ParsedCronExpression, date: Date): boolean {
	if (!parsed.minute.has(date.getMinutes())) return false;
	if (!parsed.hour.has(date.getHours())) return false;
	if (!parsed.month.has(date.getMonth() + 1)) return false;
	const domMatches = parsed.dayOfMonth.has(date.getDate());
	const dowMatches = parsed.dayOfWeek.has(date.getDay());
	if (parsed.dayOfMonthRestricted && parsed.dayOfWeekRestricted) return domMatches || dowMatches;
	return domMatches && dowMatches;
}

export function findNextCronMatchMs(expression: string, afterMs: number, deadlineMs?: number): number | undefined {
	const parsed = parseCronExpression(expression);
	const cursor = new Date(afterMs);
	cursor.setSeconds(0, 0);
	cursor.setMinutes(cursor.getMinutes() + 1);
	for (let i = 0; i < MAX_CRON_SCAN_MINUTES; i += 1) {
		const candidateMs = cursor.getTime();
		if (deadlineMs !== undefined && candidateMs > deadlineMs) return undefined;
		if (matchesCronDate(parsed, cursor)) return candidateMs;
		cursor.setMinutes(cursor.getMinutes() + 1);
	}
	return undefined;
}

function hashStringToUint32(value: string): number {
	let hash = 2166136261;
	for (let i = 0; i < value.length; i += 1) {
		hash ^= value.charCodeAt(i);
		hash = Math.imul(hash, 16777619);
	}
	return hash >>> 0;
}

function deterministicJitterMs(seed: string, maxMs: number): number {
	if (maxMs <= 0) return 0;
	return hashStringToUint32(seed) % (Math.floor(maxMs) + 1);
}

export function calculateCronFireTimeMs(params: {
	id: string;
	cronExpression: string;
	baseMatchMs: number;
	recurring: boolean;
	nowMs: number;
	expiresAt?: number;
}): number {
	if (params.recurring) {
		const followingMatchMs = findNextCronMatchMs(params.cronExpression, params.baseMatchMs, params.expiresAt);
		const intervalMs = followingMatchMs
			? Math.max(60_000, followingMatchMs - params.baseMatchMs)
			: MAX_RECURRING_JITTER_MS * 2;
		const maxJitterMs = Math.min(MAX_RECURRING_JITTER_MS, Math.floor(intervalMs / 2));
		return params.baseMatchMs + deterministicJitterMs(`${params.id}:${params.baseMatchMs}:late`, maxJitterMs);
	}
	const baseDate = new Date(params.baseMatchMs);
	if (baseDate.getMinutes() === 0 || baseDate.getMinutes() === 30) {
		const jitterMs = deterministicJitterMs(`${params.id}:${params.baseMatchMs}:early`, MAX_ONE_SHOT_EARLY_JITTER_MS);
		return Math.max(params.nowMs, params.baseMatchMs - jitterMs);
	}
	return params.baseMatchMs;
}

function setCronTimeout(callback: () => void, delayMs: number): CronTimerHandle {
	let handle: NodeJS.Timeout | undefined;
	let cleared = false;
	const schedule = (remainingMs: number) => {
		if (cleared) return;
		const boundedDelayMs = Math.max(0, Math.min(MAX_TIMEOUT_MS, Math.floor(remainingMs)));
		handle = setTimeout(() => {
			if (cleared) return;
			const nextRemainingMs = remainingMs - boundedDelayMs;
			if (nextRemainingMs > 0) {
				schedule(nextRemainingMs);
				return;
			}
			callback();
		}, boundedDelayMs);
	};
	schedule(Math.max(0, delayMs));
	return {
		clear() {
			cleared = true;
			if (handle) clearTimeout(handle);
		},
	};
}

function humanizeCronExpression(expression: string): string {
	const [minute, hour, dayOfMonth, month, dayOfWeek] = expression.trim().split(/\s+/);
	if (minute === "*" && hour === "*" && dayOfMonth === "*" && month === "*" && dayOfWeek === "*") {
		return "every minute";
	}
	const stepMatch = minute?.match(/^\*\/(\d+)$/);
	if (stepMatch && hour === "*" && dayOfMonth === "*" && month === "*" && dayOfWeek === "*") {
		const step = Number(stepMatch[1]);
		return `every ${step} minute${step === 1 ? "" : "s"}`;
	}
	if (/^\d+$/u.test(minute ?? "") && /^\d+$/u.test(hour ?? "") && dayOfMonth === "*" && month === "*") {
		const hh = hour!.padStart(2, "0");
		const mm = minute!.padStart(2, "0");
		if (dayOfWeek === "*") return `at ${hh}:${mm} every day`;
		return `at ${hh}:${mm} on day-of-week ${dayOfWeek}`;
	}
	return expression;
}

function toCronListJobDetails(snapshot: CronJobSnapshot): CronListJobDetails {
	return {
		id: snapshot.id,
		cron: snapshot.cron_expression,
		recurring: snapshot.recurring,
		prompt: snapshot.prompt,
		humanSchedule: snapshot.humanSchedule,
	};
}

function formatCronFireContent(snapshot: CronJobSnapshot): string {
	return `<task-notification>\nScheduled task ${snapshot.id} fired (${snapshot.humanSchedule}).\n\n${snapshot.prompt}\n</task-notification>`;
}

function deliverCronFire(record: CronScheduleRecord): Promise<void> | undefined {
	const content = formatCronFireContent(record.snapshot);
	const details = {
		id: record.snapshot.id,
		cron_expression: record.snapshot.cron_expression,
		recurring: record.snapshot.recurring,
	};
	const sendPromise = record.session.sendCustomMessage?.(
		{ customType: "cron-fire", content, display: false, attribution: "agent", details },
		{ triggerTurn: true, deliverAs: "followUp" },
	);
	if (sendPromise) return sendPromise;
	record.session.steer?.({ customType: "cron-fire", content, details });
	return undefined;
}

function scheduleRecord(ownerId: string | undefined, state: OwnerScheduleState, record: CronScheduleRecord): void {
	if (record.disposed) return;
	clearTimer(record.timer);
	record.timer = undefined;
	const now = Date.now();
	if (record.snapshot.expiresAt !== undefined && now >= record.snapshot.expiresAt) {
		deleteRecord(ownerId, record.snapshot.id);
		return;
	}
	const baseMatchMs = findNextCronMatchMs(record.snapshot.cron_expression, now, record.snapshot.expiresAt);
	if (baseMatchMs === undefined) {
		deleteRecord(ownerId, record.snapshot.id);
		return;
	}
	const fireAt = calculateCronFireTimeMs({
		id: record.snapshot.id,
		cronExpression: record.snapshot.cron_expression,
		baseMatchMs,
		recurring: record.snapshot.recurring,
		nowMs: now,
		expiresAt: record.snapshot.expiresAt,
	});
	record.snapshot.nextFireAt = fireAt;
	record.timer = setCronTimeout(() => fireRecord(ownerId, state, record.snapshot.id), fireAt - now);
	notifyCronChange();
}

function scheduleExpiry(ownerId: string | undefined, record: CronScheduleRecord): void {
	if (record.snapshot.expiresAt === undefined) return;
	const delayMs = record.snapshot.expiresAt - Date.now();
	record.expiryTimer = setCronTimeout(() => {
		deleteRecord(ownerId, record.snapshot.id);
	}, delayMs);
}

function fireRecord(ownerId: string | undefined, state: OwnerScheduleState, id: string): void {
	const record = state.jobs.get(id);
	if (!record || record.disposed) return;
	if (record.snapshot.expiresAt !== undefined && Date.now() >= record.snapshot.expiresAt) {
		deleteRecord(ownerId, id);
		return;
	}
	record.snapshot.firing = true;
	notifyCronChange();
	const settle = () => {
		if (record.disposed) return;
		record.snapshot.firing = false;
		notifyCronChange();
		if (!record.snapshot.recurring) {
			deleteRecord(ownerId, id);
			return;
		}
		scheduleRecord(ownerId, state, record);
	};
	try {
		const delivery = deliverCronFire(record);
		if (delivery) {
			void delivery.then(settle, error => {
				logger.warn("Cron fire delivery failed", {
					id,
					error: error instanceof Error ? error.message : String(error),
				});
				settle();
			});
		} else {
			settle();
		}
	} catch (error) {
		logger.warn("Cron fire delivery failed", { id, error: error instanceof Error ? error.message : String(error) });
		settle();
	}
}

const CRON_ID_ALPHABET = "abcdefghijklmnopqrstuvwxyz0123456789";

function generateCronId(taken: Set<string>): string {
	for (let attempt = 0; attempt < 16; attempt += 1) {
		const bytes = randomBytes(CRON_ID_LENGTH);
		let id = "";
		for (let i = 0; i < CRON_ID_LENGTH; i += 1) {
			id += CRON_ID_ALPHABET[bytes[i]! % CRON_ID_ALPHABET.length];
		}
		if (!taken.has(id)) return id;
	}
	return `${randomBytes(6).toString("hex")}-${Date.now().toString(36)}`;
}

function isCronDisabled(): boolean {
	return process.env.CLAUDE_CODE_DISABLE_CRON === "1";
}

export class CronTool implements AgentTool<typeof cronSchema, CronToolDetails> {
	readonly name = "cron";
	readonly label = "Cron";
	readonly summary = "Schedule, list, and cancel cron-style prompts (op: create | list | delete)";
	readonly description: string;
	readonly parameters = cronSchema;
	readonly strict = true;
	readonly loadMode = "discoverable";

	constructor(private readonly session: ToolSession) {
		this.description = prompt.render(cronDescription);
	}

	static createIf(session: ToolSession): CronTool | null {
		if (!isBackgroundJobSupportEnabled(session.settings)) return null;
		if (isCronDisabled()) return null;
		return new CronTool(session);
	}

	async execute(
		_toolCallId: string,
		params: CronParams,
		_signal?: AbortSignal,
		_onUpdate?: AgentToolUpdateCallback<CronToolDetails>,
		_context?: AgentToolContext,
	): Promise<AgentToolResult<CronToolDetails>> {
		switch (params.op) {
			case "create":
				return this.#create(params);
			case "list":
				return this.#list();
			case "delete":
				return this.#delete(params);
		}
	}

	async #create(params: CronParams): Promise<AgentToolResult<CronToolDetails>> {
		const manager = AsyncJobManager.instance();
		if (!manager) {
			throw new ToolError("Async execution is disabled; cron is unavailable in this session.");
		}
		if (isCronDisabled()) {
			throw new ToolError("Cron is disabled by CLAUDE_CODE_DISABLE_CRON=1.");
		}
		if (!params.cron_expression || !params.prompt) {
			throw new ToolError("cron op=create requires both 'cron_expression' and 'prompt'.");
		}
		validateCronExpression(params.cron_expression);

		const ownerId = this.session.getAgentId?.() ?? undefined;
		const state = getOrCreateOwnerState(ownerId);
		if (state.jobs.size >= MAX_CRON_TASKS_PER_OWNER) {
			throw new ToolError(
				`Cron task limit reached (${MAX_CRON_TASKS_PER_OWNER}). Cancel an existing task with cron op=delete first.`,
			);
		}
		ensureOwnerCleanup(ownerId, manager, state);

		const id = generateCronId(new Set(state.jobs.keys()));
		const now = Date.now();
		const recurring = params.recurring ?? true;
		const snapshot: CronJobSnapshot = {
			id,
			cron_expression: params.cron_expression.trim(),
			prompt: params.prompt,
			recurring,
			createdAt: now,
			expiresAt: recurring ? now + CRON_RECURRING_MAX_AGE_MS : undefined,
			humanSchedule: humanizeCronExpression(params.cron_expression.trim()),
			ownerId,
		};
		const record: CronScheduleRecord = { snapshot, session: this.session, disposed: false };
		state.jobs.set(id, record);
		scheduleExpiry(ownerId, record);
		scheduleRecord(ownerId, state, record);

		logger.debug("cron op=create: scheduled task", {
			id,
			ownerId,
			cron: snapshot.cron_expression,
			nextFireAt: snapshot.nextFireAt,
		});

		return {
			content: [{ type: "text", text: `Scheduled ${id} (${snapshot.humanSchedule})` }],
			details: {
				op: "create",
				id,
				cron_expression: snapshot.cron_expression,
				recurring: snapshot.recurring,
				nextFireAt: snapshot.nextFireAt,
			},
		};
	}

	async #list(): Promise<AgentToolResult<CronToolDetails>> {
		const ownerId = this.session.getAgentId?.() ?? undefined;
		const state = schedulesByOwner.get(ownerKey(ownerId));
		const records = state
			? Array.from(state.jobs.values()).sort((a, b) => a.snapshot.createdAt - b.snapshot.createdAt)
			: [];
		const jobs = records.map(record => toCronListJobDetails(record.snapshot));
		if (jobs.length === 0) {
			return {
				content: [{ type: "text", text: "No scheduled jobs" }],
				details: { op: "list", jobs: [] },
			};
		}
		const lines = jobs.map(job => {
			const preview = job.prompt.length > 80 ? `${job.prompt.slice(0, 77)}...` : job.prompt;
			return `${job.id} (${job.humanSchedule}): ${preview}`;
		});
		return {
			content: [{ type: "text", text: lines.join("\n") }],
			details: { op: "list", jobs },
		};
	}

	async #delete(params: CronParams): Promise<AgentToolResult<CronToolDetails>> {
		if (!params.id) {
			throw new ToolError("cron op=delete requires 'id'.");
		}
		const ownerId = this.session.getAgentId?.() ?? undefined;
		const deleted = deleteRecord(ownerId, params.id);
		const text = deleted ? `Cancelled ${params.id}` : `No scheduled task '${params.id}' found; nothing to cancel.`;
		return {
			content: [{ type: "text", text }],
			details: { op: "delete", id: params.id, deleted },
		};
	}
}
