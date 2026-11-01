import type { DesktopPreferences } from "../../../desktop-host/src/preferences-protocol";
import type { DesktopFrame, DesktopRequest, DesktopSession, DesktopSnapshot } from "../../../desktop-host/src/protocol";

export interface NavigationFixture {
	connect(): void;
	emit(frame: DesktopFrame): void;
	requests(): DesktopRequest[];
	snapshot(): DesktopSnapshot;
	holdProjectReorder(hold: boolean): void;
	resolveProjectReorder(ok: boolean): void;
}

declare global {
	interface Window {
		navigationFixture: NavigationFixture;
	}
}

/** Page-owned transport for mounted navigation tests and visual QA; never a product fallback. */
export function installNavigationFixture(holdBootstrap = false): void {
	const callbacks = new Map<number, (event: unknown) => void>();
	const listeners = new Map<number, number>();
	const requests: DesktopRequest[] = [];
	let serial = 0;
	let bootstrapId: string | undefined;
	let holdReorder = false;
	let heldReorder: DesktopRequest | undefined;
	const session = (id: string, title: string, status: DesktopSession["status"]): DesktopSession => ({
		id,
		title,
		status,
		projectId: "p",
		starred: false,
		messages: [],
		imageInput: { supported: true, blocked: false },
		operatorRunning: false,
		controlGeneration: 1,
		model: "fixture/astra",
		thinking: { level: "medium", scope: "session", available: true, options: [{ value: "medium", label: "Medium" }] },
	});
	let snapshot: DesktopSnapshot = {
		protocolVersion: 1,
		projects: [
			{ id: "p", name: "pandas", path: "/work/pandas" },
			{ id: "q", name: "한글 프로젝트", path: "/work/한글 프로젝트" },
		],
		// The catalog appends newly created conversations, oldest first.
		sessions: [
			session("old", "Oldest conversation", "idle"),
			session("middle", "Middle conversation", "running"),
			session("new", "Newest conversation", "done"),
			{ ...session("other", "다른 프로젝트의 대화", "waiting"), projectId: "q" },
		],
		models: [
			{
				id: "fixture/astra",
				provider: "fixture",
				name: "Astra",
				contextWindow: 128000,
				reasoning: true,
				thinking: { options: [{ value: "medium", label: "Medium" }] },
			},
			{
				id: "fixture/second",
				provider: "fixture",
				name: "Second model",
				contextWindow: 128000,
				reasoning: false,
				thinking: { options: [] },
			},
		],
		capabilities: [],
		deliveries: [],
	};
	const available = { available: true, reason: null };
	const preferences: DesktopPreferences = {
		profiles: [
			{
				id: "focused",
				name: "Focused",
				description: null,
				group: "CODEX",
				groupRank: 0,
				available: true,
				source: "configured",
				active: false,
				default: false,
				roles: [{ id: "default", model: "fixture/astra:medium" }],
				capabilities: { selectSession: available, persistDefault: available },
			},
		],
		roles: [
			{
				id: "default",
				name: "Default",
				model: { id: "astra", provider: "fixture", name: "Astra" },
				configured: true,
				thinkingLevel: "medium",
				scope: "default",
				canApply: available,
				canClear: { available: false, reason: "The default model cannot be cleared." },
				configurationResolution: { origin: "global", layers: ["global"] },
			},
		],
		sampling: [],
	};
	const emit = (frame: DesktopFrame) => {
		if (frame.type === "snapshot") snapshot = frame.snapshot;
		for (const [id, callback] of listeners) callbacks.get(callback)?.({ event: "engine-frame", id, payload: frame });
	};
	const respond = (id: string, result: unknown) => emit({ type: "response", id, ok: true, result });
	const finishReorder = (request: DesktopRequest, ok: boolean) => {
		if (!ok) {
			emit({ type: "response", id: request.id, ok: false, error: "Reorder refused" });
			return;
		}
		const ids = request.params.ids as string[];
		emit({
			type: "snapshot",
			snapshot: { ...snapshot, projects: ids.map(id => snapshot.projects.find(project => project.id === id)!) },
		});
		respond(request.id, null);
	};
	window.navigationFixture = {
		connect() {
			if (bootstrapId) {
				respond(bootstrapId, snapshot);
				bootstrapId = undefined;
			}
		},
		emit,
		requests: () => requests,
		snapshot: () => snapshot,
		holdProjectReorder(hold) {
			holdReorder = hold;
		},
		resolveProjectReorder(ok) {
			if (!heldReorder) throw new Error("No held project reorder");
			const request = heldReorder;
			heldReorder = undefined;
			finishReorder(request, ok);
		},
	};
	const scoped = window as unknown as {
		isTauri: boolean;
		__TAURI_INTERNALS__: unknown;
		__TAURI_EVENT_PLUGIN_INTERNALS__: unknown;
	};
	scoped.isTauri = true;
	scoped.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener() {} };
	scoped.__TAURI_INTERNALS__ = {
		transformCallback(callback: (event: unknown) => void) {
			const id = ++serial;
			callbacks.set(id, callback);
			return id;
		},
		unregisterCallback(id: number) {
			callbacks.delete(id);
		},
		async invoke(command: string, args: { eventId?: number; handler?: number; request?: DesktopRequest } = {}) {
			if (command === "plugin:event|listen") {
				const id = ++serial;
				if (args.handler !== undefined) listeners.set(id, args.handler);
				return id;
			}
			if (command === "plugin:event|unlisten") {
				if (args.eventId !== undefined) listeners.delete(args.eventId);
				return;
			}
			if (command !== "engine_request" || !args.request) throw new Error(`Unknown fixture command: ${command}`);
			const request = args.request;
			requests.push(request);
			if (request.method === "bootstrap" && holdBootstrap) {
				bootstrapId = request.id;
				return;
			}
			if (request.method === "project.reorder") {
				if (holdReorder) heldReorder = request;
				else queueMicrotask(() => finishReorder(request, true));
				return;
			}
			let result: unknown = null;
			switch (request.method) {
				case "bootstrap":
					result = snapshot;
					break;
				case "models.list":
					result = snapshot.models;
					break;
				case "preferences.get":
					result = preferences;
					break;
				case "settings.get":
				case "auth.providers":
				case "auth.keyProviders":
				case "command.list":
					result = [];
					break;
				case "activity.get":
					result = {
						sessionId: request.params.sessionId,
						revision: 1,
						activity: { available: false, reason: "Visual fixture" },
					};
					break;
				case "tools.list":
					result = { available: [], active: [] };
					break;
				case "session.select": {
					const selected = snapshot.sessions.find(item => item.id === request.params.sessionId);
					if (selected) emit({ type: "session", session: selected });
					break;
				}
			}
			queueMicrotask(() => respond(request.id, result));
		},
	};
}
