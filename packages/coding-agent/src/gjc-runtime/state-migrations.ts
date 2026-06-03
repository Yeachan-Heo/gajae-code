import * as fs from "node:fs/promises";
import type { CanonicalGjcWorkflowSkill } from "../skill-state/active-state";
import { initialPhaseForSkill } from "../skill-state/initial-phase";
import { canonicalWorkflowSkill, WORKFLOW_STATE_RECEIPT_VERSION } from "../skill-state/workflow-state-contract";
import { writeWorkflowEnvelopeAtomic } from "./state-writer";
import { getSkillManifest } from "./workflow-manifest";

export interface NormalizeLegacyStateResult {
	state: Record<string, unknown>;
	changed: boolean;
}

export interface MigrateAndPersistLegacyStateArgs {
	cwd: string;
	skill: string;
	statePath: string;
	sessionId?: string;
}

export interface MigrateAndPersistLegacyStateResult {
	migrated: boolean;
	path: string;
}

const RECEIPT_STRING_FIELDS = [
	"command",
	"state_path",
	"storage_path",
	"mutated_at",
	"fresh_until",
	"mutation_id",
] as const;

function cloneRecord(record: Record<string, unknown>): Record<string, unknown> {
	return { ...record };
}

function canonicalSkillOrThrow(skill: string): CanonicalGjcWorkflowSkill {
	const canonical = canonicalWorkflowSkill(skill);
	if (!canonical) throw new Error(`Unsupported GJC workflow skill: ${skill}`);
	return canonical;
}

function safeString(value: unknown): string {
	return typeof value === "string" ? value : "";
}

function legacyPhaseForSkill(skill: CanonicalGjcWorkflowSkill, phase: string): string {
	if (phase === "planning") return initialPhaseForSkill(skill);
	return phase;
}

function normalizePhase(skill: CanonicalGjcWorkflowSkill, value: unknown): string {
	const manifest = getSkillManifest(skill);
	const manifestStates = new Set(manifest.states.map(state => state.id));
	const phase = legacyPhaseForSkill(skill, safeString(value).trim());
	return manifestStates.has(phase) ? phase : manifest.initialState;
}

function receiptWithRequiredFields(raw: unknown, skill: CanonicalGjcWorkflowSkill): Record<string, unknown> {
	const receipt =
		raw && typeof raw === "object" && !Array.isArray(raw) ? cloneRecord(raw as Record<string, unknown>) : {};
	receipt.version = WORKFLOW_STATE_RECEIPT_VERSION;
	receipt.skill = skill;
	if (receipt.owner !== "gjc-state-cli" && receipt.owner !== "gjc-runtime" && receipt.owner !== "gjc-hook") {
		receipt.owner = "gjc-state-cli";
	}
	if (receipt.status !== "fresh" && receipt.status !== "stale") receipt.status = "stale";
	for (const field of RECEIPT_STRING_FIELDS) {
		if (typeof receipt[field] !== "string") receipt[field] = "";
	}
	return receipt;
}

function recordsEqual(left: Record<string, unknown>, right: Record<string, unknown>): boolean {
	return JSON.stringify(left) === JSON.stringify(right);
}

/**
 * Pure legacy state normalizer for background/internal readers.
 *
 * Readers that need compatibility with old on-disk workflow state shapes must call
 * this in-memory helper and must never call `migrateAndPersistLegacyState`. The
 * persist variant is reserved for explicit state migration commands because it is
 * the only path allowed to write normalized upgrades back to `.gjc/state/**`.
 */
export function normalizeLegacyState(raw: Record<string, unknown>, skill: string): NormalizeLegacyStateResult {
	const canonicalSkill = canonicalSkillOrThrow(skill);
	const state = cloneRecord(raw);
	state.skill = canonicalSkill;
	if (typeof state.version !== "number") state.version = 1;
	if (typeof state.active !== "boolean") state.active = true;

	const sourcePhase = typeof state.current_phase === "string" ? state.current_phase : state.phase;
	const normalizedPhase = normalizePhase(canonicalSkill, sourcePhase);
	state.current_phase = normalizedPhase;
	if ("phase" in state && typeof state.phase === "string") state.phase = normalizedPhase;
	state.receipt = receiptWithRequiredFields(state.receipt, canonicalSkill);

	return { state, changed: !recordsEqual(raw, state) };
}

export async function migrateAndPersistLegacyState(
	args: MigrateAndPersistLegacyStateArgs,
): Promise<MigrateAndPersistLegacyStateResult> {
	const canonicalSkill = canonicalSkillOrThrow(args.skill);
	const raw = JSON.parse(await fs.readFile(args.statePath, "utf-8")) as unknown;
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
		throw new Error(`Workflow state file must contain a JSON object: ${args.statePath}`);
	}
	const { state, changed } = normalizeLegacyState(raw as Record<string, unknown>, canonicalSkill);
	if (!changed) return { migrated: false, path: args.statePath };

	const persistedPath = await writeWorkflowEnvelopeAtomic(args.statePath, state, {
		cwd: args.cwd,
		receipt: {
			cwd: args.cwd,
			skill: canonicalSkill,
			owner: "gjc-state-cli",
			command: `gjc state ${canonicalSkill} migrate`,
			sessionId: args.sessionId,
		},
		audit: {
			cwd: args.cwd,
			skill: canonicalSkill,
			verb: "migrate",
			owner: "gjc-state-cli",
			category: "state",
		},
	});
	return { migrated: true, path: persistedPath };
}
