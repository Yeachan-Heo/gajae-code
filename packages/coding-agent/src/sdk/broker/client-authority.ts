import type { SdkClient } from "../client/client";
import { isWorkspaceIdentity, type WorkspaceIdentity } from "./authority";
import type { BrokerDiscovery } from "./discovery";

/** Mutable JSON record carried through a broker request. */
export type BrokerAuthorityInput = Record<string, unknown>;

/**
 * Cwd-bearing lifecycle operations that require a fresh broker workspace grant
 * immediately before the mutation. Mirrors the broker's own cwd-bearing set;
 * `session.close` is intentionally not cwd-bearing.
 */
const CWD_BEARING_LIFECYCLE_OPERATIONS = new Set<string>([
	"session.create",
	"session.fork",
	"session.resume",
	"session.delete",
]);

/**
 * Boot-transient authority fields. They are broker-issued and must never
 * originate from a caller; any caller-supplied value is discarded and replaced
 * with the broker-authoritative one.
 */
const CALLER_AUTHORITY_FIELDS = ["brokerOwnerId", "workspaceGrantId", "workspaceIdentity"];

/**
 * Client-side authority enrichment error. Surfaced verbatim (code + message) by
 * the SDK CLI and MCP adapters; never wraps a successful broker response.
 */
export class SdkBrokerAuthorityError extends Error {
	readonly code: string;
	constructor(code: string, message: string) {
		super(message);
		this.name = "SdkBrokerAuthorityError";
		this.code = code;
	}
}

/** Removes caller-supplied authority fields so only broker-issued values remain. */
function stripCallerAuthority(input: BrokerAuthorityInput): BrokerAuthorityInput {
	const stripped: BrokerAuthorityInput = {};
	for (const [key, value] of Object.entries(input)) if (!CALLER_AUTHORITY_FIELDS.includes(key)) stripped[key] = value;
	return stripped;
}

/**
 * Resolves the workspace cwd for a lifecycle input, honoring the same
 * `cwd`/`path`/`target.path` aliases the broker normalizes. Returns undefined
 * when the input is not cwd-bearing.
 */
function resolveLifecycleCwd(input: BrokerAuthorityInput): string | undefined {
	const direct = typeof input.cwd === "string" ? input.cwd : typeof input.path === "string" ? input.path : undefined;
	if (direct) return direct;
	const target = input.target;
	if (target && typeof target === "object" && !Array.isArray(target)) {
		const targetPath = (target as { path?: unknown }).path;
		if (typeof targetPath === "string") return targetPath;
	}
	return undefined;
}

/** Narrows a `session.list` response to a broker-issued grant, or undefined. */
function extractGrantedListing(
	value: unknown,
): { workspaceGrantId: string; workspaceIdentity: WorkspaceIdentity } | undefined {
	const frame = value as { result?: unknown } | undefined;
	const listing =
		frame?.result && typeof frame.result === "object" && !Array.isArray(frame.result) ? frame.result : value;
	const grantId = (listing as { workspaceGrantId?: unknown } | undefined)?.workspaceGrantId;
	const identity = (listing as { workspaceIdentity?: unknown } | undefined)?.workspaceIdentity;
	if (typeof grantId !== "string" || grantId.length === 0) return undefined;
	if (!isWorkspaceIdentity(identity)) return undefined;
	return { workspaceGrantId: grantId, workspaceIdentity: identity };
}

/**
 * Centralizes non-ACP client-side broker authority enrichment.
 *
 * Given a connected {@link SdkClient}, the current {@link BrokerDiscovery}, an
 * operation, and the caller-supplied input:
 *
 * - Always injects the exact current-boot `brokerOwnerId`
 *   ({@link BrokerDiscovery.ownerId}), discarding any caller value.
 * - For cwd-bearing create/fork/resume/delete, obtains a scoped `session.list`
 *   grant `{ brokerOwnerId, cwd }` immediately before the mutation and requires
 *   a broker-issued `workspaceGrantId` plus a matching `{dev,ino}`
 *   `workspaceIdentity`, merging both into the input. A listing that omits the
 *   grant fails closed.
 * - Never accepts caller overrides for `brokerOwnerId`, `workspaceGrantId`, or
 *   `workspaceIdentity`.
 *
 * `brokerOwnerId` and `workspaceGrantId` are boot-transient and intentionally
 * excluded from durable hashes by the broker; the grant fetch keeps the
 * mutation idempotent, since the broker interns and reuses the grant across
 * retries for the same still-bound workspace.
 */
export async function enrichBrokerAuthority(
	client: SdkClient,
	discovery: BrokerDiscovery,
	operation: string,
	callerInput: BrokerAuthorityInput,
): Promise<BrokerAuthorityInput> {
	const input = stripCallerAuthority(callerInput);
	input.brokerOwnerId = discovery.ownerId;
	if (!CWD_BEARING_LIFECYCLE_OPERATIONS.has(operation)) return input;
	const cwd = resolveLifecycleCwd(input);
	if (!cwd) return input;
	const listing = await client.global("session.list", { brokerOwnerId: discovery.ownerId, cwd });
	const granted = extractGrantedListing(listing);
	if (!granted)
		throw new SdkBrokerAuthorityError(
			"workspace_grant_missing",
			"session.list did not issue a workspace grant for the requested cwd.",
		);
	input.workspaceGrantId = granted.workspaceGrantId;
	input.workspaceIdentity = { dev: granted.workspaceIdentity.dev, ino: granted.workspaceIdentity.ino };
	return input;
}
