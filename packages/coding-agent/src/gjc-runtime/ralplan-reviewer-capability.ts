import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { GJC_RESTRICTED_ROLE_AGENT_BASH_ENV } from "./restricted-role-agent-bash";

export const GJC_RALPLAN_REVIEWER_ROLE_ENV = "GJC_RALPLAN_REVIEWER_ROLE";
export const GJC_RALPLAN_REVIEWER_ID_ENV = "GJC_RALPLAN_REVIEWER_ID";
export const GJC_RALPLAN_REVIEWER_CAPABILITY_ENV = "GJC_RALPLAN_REVIEWER_CAPABILITY";

export type RalplanReviewerRole = "architect" | "critic";

export interface RalplanReviewerIdentity {
	role: RalplanReviewerRole;
	agentId: string;
	capability: string;
}

export interface RalplanReviewAttestationInput {
	sessionId: string;
	runId: string;
	stage: RalplanReviewerRole;
	stageN: number;
	artifactPath: string;
	artifactSha256: string;
	reviewedPlanner?: { stage_n: number; path: string; sha256: string };
	laneVerdict: string;
	architectDecision?: string;
}

export interface RalplanReviewAttestation {
	version: 1;
	role: RalplanReviewerRole;
	agent_id: string;
	signature: string;
}

const reviewerCapabilities = new Map<string, Map<string, string>>();

function isReviewerRole(value: unknown): value is RalplanReviewerRole {
	return value === "architect" || value === "critic";
}

function isAgentId(value: unknown): value is string {
	return typeof value === "string" && value.length > 0 && value.length <= 128 && !/[\u0000-\u001f\u007f]/u.test(value);
}

function capabilityKey(role: RalplanReviewerRole, agentId: string): string {
	return `${role}\u0000${agentId}`;
}

/** Mint an opaque capability for a dispatcher-created Ralplan review lane. */
export function getOrCreateRalplanReviewerCapability(
	sessionId: string,
	role: RalplanReviewerRole,
	agentId: string,
): string {
	if (sessionId.trim() === "" || !isAgentId(agentId)) throw new Error("Ralplan reviewer identity is invalid");
	let sessionCapabilities = reviewerCapabilities.get(sessionId);
	if (!sessionCapabilities) {
		sessionCapabilities = new Map();
		reviewerCapabilities.set(sessionId, sessionCapabilities);
	}
	const key = capabilityKey(role, agentId);
	let capability = sessionCapabilities.get(key);
	if (!capability) {
		capability = randomBytes(32).toString("base64url");
		sessionCapabilities.set(key, capability);
	}
	return capability;
}

export function clearRalplanReviewerCapabilities(sessionId: string): void {
	reviewerCapabilities.delete(sessionId);
}

/** Read the role identity and capability injected by the trusted task dispatcher. */
export function readRalplanReviewerIdentity(env: NodeJS.ProcessEnv = process.env): RalplanReviewerIdentity | undefined {
	if (env[GJC_RESTRICTED_ROLE_AGENT_BASH_ENV] !== "1") return undefined;
	const role = env[GJC_RALPLAN_REVIEWER_ROLE_ENV];
	const agentId = env[GJC_RALPLAN_REVIEWER_ID_ENV];
	const capability = env[GJC_RALPLAN_REVIEWER_CAPABILITY_ENV];
	if (!isReviewerRole(role) || !isAgentId(agentId) || typeof capability !== "string" || capability.length !== 43)
		return undefined;
	return { role, agentId, capability };
}

function attestationPayload(
	input: RalplanReviewAttestationInput,
	identity: Pick<RalplanReviewerIdentity, "role" | "agentId">,
): string {
	return JSON.stringify({
		version: 1,
		session_id: input.sessionId,
		run_id: input.runId,
		stage: input.stage,
		stage_n: input.stageN,
		artifact_path: input.artifactPath,
		artifact_sha256: input.artifactSha256,
		reviewed_planner: input.reviewedPlanner ?? null,
		lane_verdict: input.laneVerdict,
		architect_decision: input.architectDecision ?? null,
		reviewer_role: identity.role,
		reviewer_id: identity.agentId,
	});
}

export function createRalplanReviewAttestation(
	input: RalplanReviewAttestationInput,
	identity: RalplanReviewerIdentity,
): RalplanReviewAttestation {
	if (identity.role !== input.stage) throw new Error("Ralplan reviewer role does not match the review stage");
	const signature = createHmac("sha256", identity.capability)
		.update(attestationPayload(input, identity))
		.digest("hex");
	return { version: 1, role: identity.role, agent_id: identity.agentId, signature };
}

export function verifyRalplanReviewAttestation(
	input: RalplanReviewAttestationInput,
	value: unknown,
): value is RalplanReviewAttestation {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
	const record = value as Record<string, unknown>;
	if (
		record.version !== 1 ||
		!isReviewerRole(record.role) ||
		record.role !== input.stage ||
		!isAgentId(record.agent_id) ||
		typeof record.signature !== "string" ||
		!/^[0-9a-f]{64}$/u.test(record.signature)
	)
		return false;
	const capability = reviewerCapabilities.get(input.sessionId)?.get(capabilityKey(record.role, record.agent_id));
	if (!capability) return false;
	const expected = createHmac("sha256", capability)
		.update(attestationPayload(input, { role: record.role, agentId: record.agent_id }))
		.digest();
	const actual = Buffer.from(record.signature, "hex");
	return actual.length === expected.length && timingSafeEqual(actual, expected);
}
