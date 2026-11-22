import type { DesktopPreferences } from "@gajae-code/desktop-host/preferences-protocol";
import type {
	DesktopAuthProvider,
	DesktopAuthState,
	DesktopFrame,
	DesktopModel,
	DesktopRequest,
	DesktopSession,
	DesktopSnapshot,
} from "@gajae-code/desktop-host/protocol";

export interface NavigationFixture {
	connect(): void;
	emit(frame: DesktopFrame): void;
	requests(): DesktopRequest[];
	snapshot(): DesktopSnapshot;
	holdProjectReorder(hold: boolean): void;
	resolveProjectReorder(ok: boolean): void;
	seedTranscripts(messageCount: number, sessionCount?: number): void;
	holdAnimationFrames(hold: boolean): void;
	pendingAnimationFrames(): number;
	flushAnimationFrames(includeCancelled?: boolean): void;
	/** The flow `auth.state` would report now. */
	authState(): DesktopAuthState | null;
	/** Conversations another process holds open: `session.connect` answers them read-only. */
	setElsewhere(ids: string[]): void;
}

declare global {
	interface Window {
		navigationFixture: NavigationFixture;
	}
}

export interface NavigationFixtureOptions {
	/** Start with no available model: the zero-model onboarding state. A saved key brings them back. */
	zeroModels?: boolean;
	/** The `auth.providers` reply. Without it the fixture answers an empty list, as before. */
	providers?: DesktopAuthProvider[];
}

/**
 * Page-owned transport for mounted navigation tests and visual QA; never a product fallback.
 * It is serialized into the page, so it must stay self-contained.
 */
export function installNavigationFixture(holdBootstrap = false, options: NavigationFixtureOptions = {}): void {
	const callbacks = new Map<number, (event: unknown) => void>();
	const listeners = new Map<number, number>();
	const requests: DesktopRequest[] = [];
	let serial = 0;
	let bootstrapId: string | undefined;
	let holdReorder = false;
	let heldReorder: DesktopRequest | undefined;
	let elsewhere = new Set<string>();
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
		// The app writes these conversations itself, as it does every conversation it created.
		connection: { state: "connected" },
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
	/** The models a saved key brings back; `zeroModels` starts the snapshot without them. */
	const fixtureModels: DesktopModel[] = snapshot.models;
	if (options.zeroModels) snapshot = { ...snapshot, models: [] };
	let providers = structuredClone(options.providers ?? []);
	/** The Host's single authorization flow as `auth.state` reports it; `auth` frames update it. */
	let authState: DesktopAuthState | null = null;
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
		if (frame.type === "auth") authState = frame.auth;
		if (frame.type === "session")
			snapshot = {
				...snapshot,
				sessions: snapshot.sessions.some(item => item.id === frame.session.id)
					? snapshot.sessions.map(item => (item.id === frame.session.id ? frame.session : item))
					: [...snapshot.sessions, frame.session],
			};
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
	const nativeRequestFrame = window.requestAnimationFrame.bind(window);
	const nativeCancelFrame = window.cancelAnimationFrame.bind(window);
	const heldFrames = new Map<number, { callback: FrameRequestCallback; cancelled: boolean }>();
	let holdFrames = false;
	let frameSerial = 0;
	window.requestAnimationFrame = callback => {
		if (!holdFrames) return nativeRequestFrame(callback);
		const id = --frameSerial;
		heldFrames.set(id, { callback, cancelled: false });
		return id;
	};
	window.cancelAnimationFrame = id => {
		const frame = heldFrames.get(id);
		if (frame) frame.cancelled = true;
		else nativeCancelFrame(id);
	};
	window.navigationFixture = {
		connect() {
			if (bootstrapId) {
				respond(bootstrapId, snapshot);
				bootstrapId = undefined;
			}
		},
		emit,
		setElsewhere(ids) {
			elsewhere = new Set(ids);
		},
		requests: () => requests,
		authState: () => authState,
		snapshot: () => snapshot,
		seedTranscripts(messageCount, sessionCount) {
			const sessions =
				sessionCount === undefined
					? snapshot.sessions
					: Array.from({ length: sessionCount }, (_, i) =>
							session(`scroll-${i}`, `Scroll conversation ${i}`, "idle"),
						);
			emit({
				type: "snapshot",
				snapshot: {
					...snapshot,
					sessions: sessions.map(item => ({
						...item,
						messages: Array.from({ length: messageCount }, (_, i) => ({
							id: `${item.id}-message-${i}`,
							entryId: `${item.id}-message-${i}`,
							role: "user" as const,
							text: `Transcript ${item.id}, message ${i}\nA stable line for reading offsets.\n한글과 English remain in the same transcript.\nThe final line has a predictable height.`,
						})),
					})),
				},
			});
		},
		holdAnimationFrames(hold) {
			holdFrames = hold;
		},
		pendingAnimationFrames: () => heldFrames.size,
		flushAnimationFrames(includeCancelled = false) {
			holdFrames = false;
			const frames = [...heldFrames.values()];
			heldFrames.clear();
			// Running cancelled callbacks deliberately models callbacks already handed to the browser.
			for (const frame of frames) if (includeCancelled || !frame.cancelled) frame.callback(performance.now());
		},
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
				case "auth.providers":
					result = providers;
					break;
				case "auth.state":
					result = authState;
					break;
				case "auth.login":
				case "auth.answer":
				case "auth.cancel": {
					// Like the Host: publish the new flow state first, then answer with it.
					const provider =
						request.method === "auth.login" ? String(request.params.provider) : (authState?.provider ?? "");
					const next: DesktopAuthState = {
						id: request.method === "auth.login" ? crypto.randomUUID() : String(request.params.flowId),
						provider,
						status: request.method === "auth.cancel" ? "cancelled" : "authorizing",
					};
					emit({ type: "auth", auth: next });
					result = next;
					break;
				}
				case "auth.setKey": {
					// Like the Host: the snapshot with the provider's models goes out before the response.
					const provider = String(request.params.provider);
					const keyed = fixtureModels.filter(model => model.provider === provider);
					const added = keyed.length
						? keyed
						: [{ ...fixtureModels[1]!, id: `${provider}/keyed`, name: "Keyed model", provider }];
					emit({
						type: "snapshot",
						snapshot: {
							...snapshot,
							models: [
								...snapshot.models,
								...added.filter(model => !snapshot.models.some(item => item.id === model.id)),
							],
						},
					});
					providers = providers.map(item =>
						item.id === provider
							? { ...item, configured: true, stored: true, credentialKinds: ["api_key"] }
							: item,
					);
					result = { provider, saved: true, catalogRefreshed: true };
					break;
				}
				case "settings.get":
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
				// Like the Host: work in progress needs confirmation; the answer follows the session frame.
				case "session.disconnect": {
					const target = snapshot.sessions.find(item => item.id === request.params.sessionId);
					if (!target) break;
					if (target.status === "running" && request.params.confirm !== true) {
						result = { disconnected: false, confirm: { running: true, queued: target.queued?.length ?? 0 } };
						break;
					}
					const released: DesktopSession = {
						...target,
						status: "idle",
						controlGeneration: null,
						connection: { state: "disconnected" },
					};
					emit({ type: "session", session: released });
					result = { disconnected: true, session: released };
					break;
				}
				case "session.connect": {
					const target = snapshot.sessions.find(item => item.id === request.params.sessionId);
					if (!target) break;
					const connected: DesktopSession = elsewhere.has(target.id)
						? { ...target, controlGeneration: null, connection: { state: "elsewhere" } }
						: { ...target, controlGeneration: 2, connection: { state: "connected" } };
					emit({ type: "session", session: connected });
					result = connected;
					break;
				}
			}
			queueMicrotask(() => respond(request.id, result));
		},
	};
}
