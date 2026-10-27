export const PROTOCOL_VERSION = 1;

export const DESKTOP_METHODS = [
	"bootstrap",
	"project.open",
	"session.create",
	"session.select",
	"session.rename",
	"session.delete",
	"session.star",
	"session.fork",
	"session.compact",
	"session.retry",
	"session.export",
	"prompt",
	"abort",
	"model.set",
	"settings.get",
	"settings.set",
	"auth.setKey",
	"question.answer",
	"diff.get",
	"tools.list",
	"tools.set",
	"goal.operate",
	"shutdown",
] as const;
export type DesktopMethod = (typeof DESKTOP_METHODS)[number];

export interface DesktopRequest {
	id: string;
	method: DesktopMethod;
	params: Record<string, unknown>;
}

export interface DesktopMessage {
	id: string;
	role: "user" | "assistant" | "tool" | "system";
	text: string;
	toolName?: string;
	isError?: boolean;
	truncated?: boolean;
}

export interface DesktopQuestion {
	id: string;
	sessionId: string;
	kind: "select" | "confirm" | "input" | "editor";
	title: string;
	message?: string;
	options?: string[];
	initialValue?: string;
}

export interface DesktopSession {
	id: string;
	projectId: string;
	title: string;
	status: "idle" | "running" | "waiting" | "error";
	starred: boolean;
	model?: string;
	messages: DesktopMessage[];
	historyTruncated?: boolean;
	question?: DesktopQuestion;
	error?: string;
}

export interface DesktopProject {
	id: string;
	name: string;
	path: string;
}
export interface DesktopModel {
	id: string;
	name: string;
	provider: string;
}
export interface DesktopCapability {
	id: string;
	label: string;
	available: boolean;
	reason?: string;
}
export interface DesktopSnapshot {
	protocolVersion: number;
	projects: DesktopProject[];
	sessions: DesktopSession[];
	models: DesktopModel[];
	capabilities: DesktopCapability[];
}
export interface DesktopSetting {
	path: string;
	value: unknown;
	type: string;
	description?: string;
	choices?: string[];
	writable: boolean;
}
export interface DesktopDiff {
	path: string;
	status: string;
	patch: string;
}
export type DesktopFrame =
	| { type: "response"; id: string; ok: true; result: unknown }
	| { type: "response"; id: string; ok: false; error: string }
	| { type: "snapshot"; snapshot: DesktopSnapshot }
	| { type: "session"; session: DesktopSession }
	| { type: "fatal"; error: string };

export const MAX_FRAME_BYTES = 8 * 1024 * 1024;

export function parseRequest(line: string): DesktopRequest {
	if (new TextEncoder().encode(line).byteLength > MAX_FRAME_BYTES) throw new Error("Request exceeds frame limit");
	const value: unknown = JSON.parse(line);
	if (!value || typeof value !== "object") throw new Error("Invalid request");
	const request = value as Record<string, unknown>;
	if (
		typeof request.id !== "string" ||
		!request.id.length ||
		request.id.length > 128 ||
		typeof request.method !== "string" ||
		!DESKTOP_METHODS.includes(request.method as DesktopMethod) ||
		!request.params ||
		typeof request.params !== "object" ||
		Array.isArray(request.params)
	)
		throw new Error("Invalid request envelope");
	return request as unknown as DesktopRequest;
}
