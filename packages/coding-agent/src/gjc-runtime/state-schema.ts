/**
 * Canonical zod schemas for GJC workflow state (Workstream A, v4).
 *
 * Schemas are **lenient/additive** (`.passthrough()`): unknown keys are
 * preserved, non-anchored fields are optional. This upholds the binding v2
 * read contract — reads never reject evolving/old state. The strict
 * `RequiredOnWriteEnvelopeSchema` is the WRITE-side gate (fail-closed), anchored
 * to exactly what the sanctioned writer emits.
 *
 * These schemas describe the persisted `WorkflowStateReceipt`/envelope; they are
 * a distinct concept from the `CliWriteReceipt` stdout presentation type.
 */
import * as fs from "node:fs/promises";
import { z } from "zod";
import { WORKFLOW_STATE_VERSION } from "../skill-state/workflow-state-version";

const CANONICAL_GJC_WORKFLOW_SKILLS = ["deep-interview", "ralplan", "ultragoal", "team"] as const;
const skillEnum = z.enum([...CANONICAL_GJC_WORKFLOW_SKILLS]);
const ownerEnum = z.enum(["gjc-state-cli", "gjc-runtime", "gjc-hook"]);
const receiptStatusEnum = z.enum(["fresh", "stale"]);

export const WorkflowStateContentChecksumSchema = z
	.object({
		algorithm: z.literal("sha256"),
		value: z.string(),
		covered_path: z.string(),
		computed_at: z.string(),
	})
	.passthrough();

/** Lenient receipt schema for reads (mirrors WorkflowStateReceipt). */
export const WorkflowStateReceiptSchema = z
	.object({
		version: z.number(),
		skill: skillEnum,
		owner: ownerEnum,
		command: z.string(),
		state_path: z.string(),
		storage_path: z.string(),
		mutated_at: z.string(),
		fresh_until: z.string(),
		status: receiptStatusEnum,
		mutation_id: z.string(),
		verb: z.string().optional(),
		from_phase: z.string().optional(),
		to_phase: z.string().optional(),
		forced: z.boolean().optional(),
		paths: z.array(z.string()).optional(),
		content_sha256: WorkflowStateContentChecksumSchema.optional(),
	})
	.passthrough();

/** Lenient envelope schema for reads. Every non-structural field optional. */
export const WorkflowStateEnvelopeSchema = z
	.object({
		skill: z.string().optional(),
		active: z.boolean().optional(),
		current_phase: z.string().optional(),
		version: z.number().optional(),
		updated_at: z.string().optional(),
		session_id: z.string().optional(),
		receipt: WorkflowStateReceiptSchema.optional(),
	})
	.passthrough();

/**
 * Strict receipt required on WRITE (post checksum-stamping). Anchored to the
 * fields the sanctioned writer emits — `content_sha256` is REQUIRED here.
 */
export const RequiredWorkflowStateReceiptSchema = z
	.object({
		version: z.number(),
		skill: skillEnum,
		owner: ownerEnum,
		command: z.string(),
		state_path: z.string(),
		storage_path: z.string(),
		mutated_at: z.string(),
		fresh_until: z.string(),
		status: receiptStatusEnum,
		mutation_id: z.string(),
		content_sha256: WorkflowStateContentChecksumSchema,
	})
	.passthrough();

/**
 * Write-side fail-closed gate: the serialized on-disk envelope must satisfy
 * this after checksum stamping. Anchored to current sanctioned-writer output.
 */
export const RequiredOnWriteEnvelopeSchema = z
	.object({
		skill: skillEnum,
		version: z.literal(WORKFLOW_STATE_VERSION),
		updated_at: z.string(),
		current_phase: z.string(),
		active: z.boolean(),
		receipt: RequiredWorkflowStateReceiptSchema,
	})
	.passthrough();

/** Per-skill mode state consumed by hooks / the mutation guard. */
export const ModeStateSchema = z
	.object({
		active: z.boolean().optional(),
		current_phase: z.string().optional(),
		skill: z.string().optional(),
		session_id: z.string().optional(),
		thread_id: z.string().optional(),
		cwd: z.string().optional(),
		updated_at: z.string().optional(),
		handoff_from: z.string().optional(),
		handoff_to: z.string().optional(),
		handoff_at: z.string().optional(),
	})
	.passthrough();

export const SkillActiveEntrySchema = z
	.object({
		skill: z.string(),
		phase: z.string().optional(),
		active: z.boolean().optional(),
		activated_at: z.string().optional(),
		updated_at: z.string().optional(),
		session_id: z.string().optional(),
		thread_id: z.string().optional(),
		turn_id: z.string().optional(),
		stale: z.boolean().optional(),
		handoff_from: z.string().optional(),
		handoff_to: z.string().optional(),
		handoff_at: z.string().optional(),
		receipt: WorkflowStateReceiptSchema.optional(),
	})
	.passthrough();

export const SkillActiveStateSchema = z
	.object({
		version: z.number().optional(),
		active: z.boolean().optional(),
		skill: z.string().optional(),
		keyword: z.string().optional(),
		phase: z.string().optional(),
		activated_at: z.string().optional(),
		updated_at: z.string().optional(),
		source: z.string().optional(),
		session_id: z.string().optional(),
		thread_id: z.string().optional(),
		turn_id: z.string().optional(),
		active_skills: z.array(SkillActiveEntrySchema).optional(),
	})
	.passthrough();

export type WorkflowStateEnvelope = z.infer<typeof WorkflowStateEnvelopeSchema>;
export type RequiredOnWriteEnvelope = z.infer<typeof RequiredOnWriteEnvelopeSchema>;
export type ModeStateParsed = z.infer<typeof ModeStateSchema>;
export type SkillActiveStateParsed = z.infer<typeof SkillActiveStateSchema>;

/**
 * Validated read result.
 * - `null`        → file absent (ENOENT); callers treat as no state.
 * - `{ok:true}`   → parsed + schema-valid.
 * - `{ok:false}`  → present but unparseable or schema-invalid. Callers fail
 *                   OPEN (normalize/log), never crash — preserving v2 reads.
 */
export type ReadGjcJsonResult<T> = { ok: true; value: T; raw: unknown } | { ok: false; error: string; raw: unknown };

function isEnoent(error: unknown): boolean {
	return Boolean(error) && (error as NodeJS.ErrnoException).code === "ENOENT";
}

/**
 * Parse + schema-validate a `.gjc` JSON file at the read boundary.
 * Returns `null` when the file is absent. Fail-open: an invalid file yields
 * `{ ok: false }` with the raw value attached so the caller can normalize/log.
 */
export async function readGjcJson<T>(filePath: string, schema: z.ZodType<T>): Promise<ReadGjcJsonResult<T> | null> {
	let text: string;
	try {
		text = await fs.readFile(filePath, "utf-8");
	} catch (error) {
		if (isEnoent(error)) return null;
		return { ok: false, error: `read error: ${(error as Error).message}`, raw: undefined };
	}
	let raw: unknown;
	try {
		raw = JSON.parse(text);
	} catch (error) {
		return { ok: false, error: `invalid JSON: ${(error as Error).message}`, raw: text };
	}
	const parsed = schema.safeParse(raw);
	if (parsed.success) return { ok: true, value: parsed.data, raw };
	return { ok: false, error: parsed.error.message, raw };
}
