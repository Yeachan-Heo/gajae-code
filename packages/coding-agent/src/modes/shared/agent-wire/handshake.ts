import type { RpcUnattendedDeclaration } from "../../rpc/rpc-types";
import { BRIDGE_PROTOCOL_VERSION, type BridgeFrameType } from "./protocol";
import type { BridgeCommandScope } from "./scopes";

export type BridgeCapability =
	| "events"
	| "prompt"
	| "permission"
	| "elicitation"
	| "ui.declarative"
	| "ui.editor"
	| "ui.terminal_input"
	| "host_tools"
	| "host_uri"
	| "client_bridge.read_text_file"
	| "client_bridge.write_text_file"
	| "client_bridge.create_terminal"
	| "workflow_gate";

export interface BridgeProtocolRange {
	min: number;
	max: number;
}

export interface BridgeHandshakeRequest {
	protocol_version_range: BridgeProtocolRange;
	capabilities: BridgeCapability[];
	requested_scopes: BridgeCommandScope[];
	last_seq?: number;
	/** Optional unattended declaration (budget + scope + action allowlist) for #318/#319. */
	unattended?: RpcUnattendedDeclaration;
}

export interface BridgeEndpointDescriptor {
	events: string;
	commands: string;
	uiResponses: string;
	claimControl: string;
	disconnectControl: string;
	hostToolResults: string;
	hostUriResults: string;
}

export interface BridgeHandshakeAccepted {
	status: "accepted";
	protocol_version: typeof BRIDGE_PROTOCOL_VERSION;
	session_id: string;
	accepted_capabilities: BridgeCapability[];
	accepted_scopes: BridgeCommandScope[];
	unsupported: BridgeCapability[];
	endpoints: BridgeEndpointDescriptor;
	frame_types: BridgeFrameType[];
	/** Echoed unattended declaration when one was supplied and accepted (#321). */
	accepted_unattended?: RpcUnattendedDeclaration;
	/** Server-side accepted unattended mode after live negotiation, not just declaration echo. */
	unattended_active?: boolean;
}

export interface BridgeHandshakeRejected {
	status: "rejected";
	reason: "incompatible_version" | "unauthorized" | "invalid_request";
	message: string;
}

export type BridgeHandshakeResponse = BridgeHandshakeAccepted | BridgeHandshakeRejected;

/** Shape-validate an optional unattended declaration carried on the handshake. */
export function isUnattendedDeclarationShape(value: unknown): value is RpcUnattendedDeclaration {
	if (!value || typeof value !== "object") return false;
	const d = value as Record<string, unknown>;
	const b = d.budget as Record<string, unknown> | undefined;
	const budgetOk =
		!!b &&
		typeof b === "object" &&
		// Match UnattendedRunController fail-closed validation: positive finite budgets.
		["max_tokens", "max_tool_calls", "max_wall_time_ms", "max_cost_usd"].every(
			k => typeof b[k] === "number" && Number.isFinite(b[k] as number) && (b[k] as number) > 0,
		);
	return (
		typeof d.actor === "string" &&
		d.actor.trim() !== "" &&
		budgetOk &&
		Array.isArray(d.scopes) &&
		d.scopes.every(s => typeof s === "string") &&
		Array.isArray(d.action_allowlist) &&
		d.action_allowlist.every(s => typeof s === "string")
	);
}
export function isBridgeHandshakeRequest(value: unknown): value is BridgeHandshakeRequest {
	if (!value || typeof value !== "object") return false;
	const request = value as {
		protocol_version_range?: unknown;
		capabilities?: unknown;
		requested_scopes?: unknown;
		last_seq?: unknown;
		unattended?: unknown;
	};
	const range = request.protocol_version_range as { min?: unknown; max?: unknown } | undefined;
	return (
		!!range &&
		typeof range.min === "number" &&
		Number.isInteger(range.min) &&
		typeof range.max === "number" &&
		Number.isInteger(range.max) &&
		Array.isArray(request.capabilities) &&
		request.capabilities.every(capability => typeof capability === "string") &&
		Array.isArray(request.requested_scopes) &&
		request.requested_scopes.every(scope => typeof scope === "string") &&
		(request.last_seq === undefined ||
			(typeof request.last_seq === "number" && Number.isInteger(request.last_seq))) &&
		(request.unattended === undefined || isUnattendedDeclarationShape(request.unattended))
	);
}

export function negotiateBridgeHandshake(
	request: BridgeHandshakeRequest,
	server: {
		sessionId: string;
		capabilities: readonly BridgeCapability[];
		scopes: readonly BridgeCommandScope[];
		endpoints: BridgeEndpointDescriptor;
		frameTypes: readonly BridgeFrameType[];
		acceptedUnattended?: RpcUnattendedDeclaration;
	},
): BridgeHandshakeResponse {
	if (
		request.protocol_version_range.min > BRIDGE_PROTOCOL_VERSION ||
		request.protocol_version_range.max < BRIDGE_PROTOCOL_VERSION
	) {
		return {
			status: "rejected",
			reason: "incompatible_version",
			message: `Bridge protocol v${BRIDGE_PROTOCOL_VERSION} is outside client range ${request.protocol_version_range.min}..${request.protocol_version_range.max}`,
		};
	}
	const serverCapabilities = new Set(server.capabilities);
	const acceptedCapabilities = request.capabilities.filter(capability => serverCapabilities.has(capability));
	const acceptedSet = new Set(acceptedCapabilities);
	const unsupported = request.capabilities.filter(capability => !acceptedSet.has(capability));
	const serverScopes = new Set(server.scopes);
	const acceptedScopes = request.requested_scopes.filter(scope => serverScopes.has(scope));
	const accepted: BridgeHandshakeAccepted = {
		status: "accepted",
		protocol_version: BRIDGE_PROTOCOL_VERSION,
		session_id: server.sessionId,
		accepted_capabilities: acceptedCapabilities,
		accepted_scopes: acceptedScopes,
		unsupported,
		endpoints: server.endpoints,
		frame_types: [...server.frameTypes],
	};
	if (server.acceptedUnattended !== undefined && acceptedSet.has("workflow_gate")) {
		accepted.accepted_unattended = server.acceptedUnattended;
		accepted.unattended_active = true;
	}
	return accepted;
}
