// TEST ONLY. Deterministic loopback provider for the manual desktop browser adapter.
// This is an HTTP/SSE fixture, not a replacement AgentSession or provider serializer.
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

export const QA_PROVIDER = "desktop-qa-fixture";
export const QA_KEY = "fixture-only-not-a-provider-secret";
export const QA_MODEL_IDS = ["qa-reasoning", "qa-plain", "qa-discrete"] as const;
const markerName = "qa-model-fixture.json";

export interface FixtureLayout {
	root: string;
	dataDir: string;
	agentDir: string;
	project: string;
	artifactPath: string;
	gateControlPath: string;
	gateArtifactPath: string;
}

export function fixtureLayout(root: string): FixtureLayout {
	const owned = path.resolve(root);
	return {
		root: owned,
		dataDir: path.join(owned, "desktop-data"),
		agentDir: path.join(owned, "desktop-data", "agent"),
		project: path.join(owned, "qa-project"),
		artifactPath: path.join(owned, "model-fixture-requests.json"),
		gateControlPath: path.join(owned, "qa-gate-control.json"),
		gateArtifactPath: path.join(owned, "workflow-gate-continuations.json"),
	};
}

/** Construct from scratch: never inherit HOME, credentials, proxies, or SDK overrides. */
export function fixtureEnvironment(layout: FixtureLayout, baseUrl: string, providerToken: string): Record<string, string> {
	assertFixtureEndpoint(baseUrl);
	return {
		PATH: "/usr/bin:/bin",
		HOME: path.join(layout.dataDir, "home"),
		USERPROFILE: path.join(layout.dataDir, "home"),
		TMPDIR: layout.root,
		LANG: "en_US.UTF-8",
		GIT_CONFIG_NOSYSTEM: "1",
		GIT_CONFIG_GLOBAL: os.devNull,
		GIT_TERMINAL_PROMPT: "0",
		GJC_CONFIG_DIR: ".gjc-desktop",
		PI_CONFIG_DIR: ".gjc-desktop",
		XDG_CONFIG_HOME: path.join(layout.dataDir, "config"),
		XDG_DATA_HOME: path.join(layout.dataDir, "data"),
		XDG_STATE_HOME: path.join(layout.dataDir, "state"),
		XDG_CACHE_HOME: path.join(layout.dataDir, "cache"),
		GJC_DESKTOP_DATA_DIR: layout.dataDir,
		GJC_DESKTOP_AGENT_DIR: layout.agentDir,
		GJC_CODING_AGENT_DIR: layout.agentDir,
		PI_CODING_AGENT_DIR: layout.agentDir,
		GJC_DESKTOP_ISOLATED: "1",
		GJC_DESKTOP_QA_MODEL_FIXTURE: "1",
		GJC_DESKTOP_QA_FIXTURE_ROOT: layout.root,
		GJC_DESKTOP_QA_FIXTURE_URL: baseUrl,
		GJC_DESKTOP_QA_FIXTURE_TOKEN: providerToken,
	};
}

export function assertFixtureEndpoint(baseUrl: string): void {
	const url = new URL(baseUrl);
	if (
		url.protocol !== "http:" || url.hostname !== "127.0.0.1" || !url.port ||
		url.username || url.password || url.pathname !== "/v1" || url.search || url.hash ||
		url.href !== baseUrl
	) throw new Error("Only the owned loopback fixture endpoint is permitted");
}

export function assertFixtureMode(environment: NodeJS.ProcessEnv): void {
	if (environment.GJC_DESKTOP_QA_MODEL_FIXTURE !== "1" || environment.GJC_DESKTOP_QA_LIVE === "1")
		throw new Error("Model fixture requires explicit fixture mode and forbids LIVE=1");
}

export async function seedFixture(layout: FixtureLayout, baseUrl: string, providerToken: string): Promise<void> {
	assertFixtureEndpoint(baseUrl);
	for (const directory of [layout.agentDir, layout.project, ...["home", "config", "data", "state", "cache"].map(name => path.join(layout.dataDir, name))])
		await fs.mkdir(directory, { recursive: true, mode: 0o700 });
	const models = QA_MODEL_IDS.map(id => ({
		id,
		name: `TEST ONLY ${id}`,
		reasoning: id !== "qa-plain",
		...(id === "qa-plain" ? {} : { thinking: {
			mode: "effort", minLevel: "low", maxLevel: id === "qa-discrete" ? "max" : "high",
			defaultLevel: "low", ...(id === "qa-discrete" ? { levels: ["low", "high", "max"] } : {}),
		} }),
		input: id === "qa-discrete" ? ["text", "image"] : ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 131072,
		maxTokens: 1024,
	}));
	// JSON is valid YAML. All paths and credentials here belong to this temporary fixture.
	await Bun.write(path.join(layout.agentDir, "models.yml"), JSON.stringify({
		providers: { [QA_PROVIDER]: {
			api: "openai-completions", baseUrl, apiKey: QA_KEY,
			headers: { "X-Desktop-QA-Fixture": providerToken },
			compat: { supportsReasoningEffort: true, thinkingFormat: "openai", supportsStore: false },
			models,
		} },
		profiles: Object.fromEntries(QA_MODEL_IDS.map(id => [id, {
			display_name: `TEST ONLY ${id}`, required_providers: [QA_PROVIDER],
			model_mapping: { default: `${QA_PROVIDER}/${id}${id === "qa-plain" ? "" : ":low"}` },
		}])),
	}));
	await Bun.write(path.join(layout.agentDir, "config.yml"), JSON.stringify({
		modelRoles: { default: `${QA_PROVIDER}/qa-reasoning:low` },
		compaction: { enabled: false }, retry: { enabled: false },
	}));
	await Bun.write(path.join(layout.root, markerName), JSON.stringify({ version: 1, root: layout.root, baseUrl, providerToken }));
}

/** Refuse direct invocation with arbitrary roots/endpoints or inherited install state. */
export async function validateFixtureEnvironment(environment: NodeJS.ProcessEnv): Promise<{ layout: FixtureLayout; baseUrl: string; providerToken: string }> {
	assertFixtureMode(environment);
	const root = environment.GJC_DESKTOP_QA_FIXTURE_ROOT;
	const baseUrl = environment.GJC_DESKTOP_QA_FIXTURE_URL;
	const providerToken = environment.GJC_DESKTOP_QA_FIXTURE_TOKEN;
	if (!root || !baseUrl || !providerToken || !/^[a-f0-9-]{36}$/.test(providerToken)) throw new Error("Missing owned fixture configuration");
	assertFixtureEndpoint(baseUrl);
	const canonical = await fs.realpath(root);
	if (canonical !== root || !path.basename(root).startsWith("gjc-host-ui-qa-") || environment.TMPDIR !== root)
		throw new Error("Fixture root must be a canonical QA-owned temporary directory");
	const info = await fs.stat(root);
	if ((info.mode & 0o077) !== 0 || (process.getuid && info.uid !== process.getuid())) throw new Error("Fixture root ownership is unsafe");
	const marker = await Bun.file(path.join(root, markerName)).json();
	if (marker.version !== 1 || marker.root !== root || marker.baseUrl !== baseUrl || marker.providerToken !== providerToken)
		throw new Error("Fixture ownership marker does not match");
	const layout = fixtureLayout(root);
	const expected = fixtureEnvironment(layout, baseUrl, providerToken);
	for (const [key, value] of Object.entries(expected)) {
		if (environment[key] !== value) throw new Error(`Unsafe fixture environment: ${key}`);
	}
	for (const key of Object.keys(environment)) {
		if (!(key in expected)) throw new Error(`Unexpected fixture environment: ${key}`);
	}
	for (const directory of [layout.dataDir, layout.agentDir, layout.project, ...["home", "config", "data", "state", "cache"].map(name => path.join(layout.dataDir, name))]) {
		if (await fs.realpath(directory) !== directory) throw new Error("Fixture roots cannot be symlinked");
	}
	return { layout, baseUrl, providerToken };
}

/** All SDK fetch traffic is fenced to one owned route; redirects cannot escape. */
export function fixtureFetch(baseUrl: string, providerToken: string, transport: typeof fetch): typeof fetch {
	assertFixtureEndpoint(baseUrl);
	const guarded = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
		const request = input instanceof Request ? new Request(input, init) : new Request(input.toString(), init);
		if (request.url !== `${baseUrl}/chat/completions` || request.method !== "POST" ||
			request.headers.get("X-Desktop-QA-Fixture") !== providerToken || request.headers.get("Authorization") !== `Bearer ${QA_KEY}`)
			throw new Error("TEST ONLY fixture refused non-owned network request");
		return transport(request, { redirect: "error" });
	};
	return Object.assign(guarded, { preconnect: () => { throw new Error("Fixture preconnect is forbidden"); } }) as typeof fetch;
}

export type FixtureGateKind = "approval" | "question" | "execution";
export interface FixtureGateContinuation {
	id: number;
	sessionId: string;
	kind: FixtureGateKind;
	state: "pending" | "resolved" | "rejected";
	/** True only when the genuine emitGate promise resolved; not an approval/grant. */
	advanced: boolean;
	answer?: unknown;
	error?: string;
}
export interface FixtureGateSnapshot {
	version: 1;
	testOnly: true;
	continuations: FixtureGateContinuation[];
}

/** The child advertises an exact loopback URL in an owned temporary file. */
export async function readFixtureGateControl(layout: FixtureLayout): Promise<string> {
	const value: unknown = await Bun.file(layout.gateControlPath).json();
	if (!value || typeof value !== "object" || !("baseUrl" in value) || typeof value.baseUrl !== "string")
		throw new Error("Invalid fixture gate control metadata");
	assertFixtureEndpoint(`${value.baseUrl}/v1`);
	return value.baseUrl;
}

export interface FixtureRequestRecord {
	id: number;
	method: "POST";
	path: "/v1/chat/completions";
	body: Record<string, unknown>;
	state: "held" | "completed" | "aborted";
	held: boolean;
	released: boolean;
	chunks: string[];
}
export interface FixtureSnapshot {
	version: 1;
	testOnly: true;
	provider: string;
	baseUrl: string;
	models: string[];
	holdNext: boolean;
	requests: FixtureRequestRecord[];
}

export interface ModelFixture {
	baseUrl: string;
	providerToken: string;
	snapshot(): FixtureSnapshot;
	holdNext(): void;
	release(id: number): boolean;
	flush(): Promise<void>;
	close(): Promise<void>;
}

export function startModelFixture(artifactPath: string): ModelFixture {
	const providerToken = crypto.randomUUID();
	const records: FixtureRequestRecord[] = [];
	const held = new Map<number, () => void>();
	let holdNext = true;
	let writes = Promise.resolve();
	let writeError: unknown;
	const encoder = new TextEncoder();
	const snapshot = (): FixtureSnapshot => ({
		version: 1, testOnly: true, provider: QA_PROVIDER, baseUrl,
		models: QA_MODEL_IDS.map(id => `${QA_PROVIDER}/${id}`), holdNext,
		requests: structuredClone(records),
	});
	const persist = () => {
		const text = JSON.stringify(snapshot(), null, 2);
		writes = writes.then(async () => { await Bun.write(artifactPath, text); }).catch(error => { writeError = error; });
	};
	const server = Bun.serve<undefined>({
		hostname: "127.0.0.1", port: 0, idleTimeout: 0, maxRequestBodySize: 4 * 1024 * 1024,
		async fetch(request) {
			const url = new URL(request.url);
			if (url.origin !== `http://127.0.0.1:${server.port}` || request.headers.get("host") !== `127.0.0.1:${server.port}` ||
				url.pathname !== "/v1/chat/completions" || url.search || request.method !== "POST" || request.headers.has("Origin") ||
				request.headers.get("Authorization") !== `Bearer ${QA_KEY}` || request.headers.get("X-Desktop-QA-Fixture") !== providerToken)
				return new Response("Forbidden fixture request", { status: 403 });
			if (records.length >= 64) return new Response("Fixture request limit", { status: 429 });
			let body: Record<string, unknown>;
			try {
				const value: unknown = await request.json();
				if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid body");
				body = value as Record<string, unknown>;
				if (!QA_MODEL_IDS.some(id => id === body.model) || body.stream !== true || !Array.isArray(body.messages)) throw new Error("Invalid model or stream");
			} catch { return new Response("Invalid fixture completion", { status: 400 }); }
			if (records.length >= 64) return new Response("Fixture request limit", { status: 429 });
			const record: FixtureRequestRecord = {
				id: records.length + 1, method: "POST", path: "/v1/chat/completions", body,
				state: "held", held: holdNext, released: false, chunks: [],
			};
			holdNext = false;
			records.push(record);
			let heartbeat: Timer | undefined;
			let streamController: ReadableStreamDefaultController<Uint8Array> | undefined;
			const onAbort = () => { abort(); streamController?.close(); };
			const abort = () => {
				if (record.state !== "held") return;
				record.state = "aborted";
				held.delete(record.id);
				if (heartbeat) clearInterval(heartbeat);
				request.signal.removeEventListener("abort", onAbort);
				persist();
			};
			const response = new ReadableStream<Uint8Array>({
				start(controller) {
					streamController = controller;
					const send = (data: string) => {
						record.chunks.push(data);
						controller.enqueue(encoder.encode(`data: ${data}\n\n`));
					};
					const chunk = (delta: Record<string, unknown>, finish: string | null = null) => JSON.stringify({
						id: `qa-completion-${record.id}`, object: "chat.completion.chunk", created: 1700000000,
						model: body.model, choices: [{ index: 0, delta, finish_reason: finish }],
					});
					const finish = () => {
						if (record.state !== "held") return;
						if (heartbeat) clearInterval(heartbeat);
						send(chunk({ content: `Fixture turn ${record.id} complete.` }));
						send(chunk({}, "stop"));
						send(JSON.stringify({ id: `qa-completion-${record.id}`, object: "chat.completion.chunk", created: 1700000000,
							model: body.model, choices: [], usage: { prompt_tokens: 12, completion_tokens: 8, total_tokens: 20 } }));
						send("[DONE]");
						record.state = "completed";
						held.delete(record.id);
						request.signal.removeEventListener("abort", onAbort);
						controller.close();
						persist();
					};
					send(chunk({ role: "assistant", content: "" }));
					if (body.model !== "qa-plain") send(chunk({ reasoning_content: `Fixture reasoning ${record.id}. ` }));
					send(chunk({ content: `Fixture turn ${record.id} started. ` }));
					request.signal.addEventListener("abort", onAbort, { once: true });
					if (request.signal.aborted) onAbort();
					else if (record.held) {
						held.set(record.id, finish);
						heartbeat = setInterval(() => controller.enqueue(encoder.encode(": fixture hold\n\n")), 1000);
						persist();
					} else finish();
				},
				cancel() { abort(); },
			});
			return new Response(response, { headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-store" } });
		},
	});
	const baseUrl = `http://127.0.0.1:${server.port}/v1`;
	persist();
	return {
		baseUrl, providerToken, snapshot,
		holdNext() { holdNext = true; persist(); },
		release(id) {
			const finish = held.get(id);
			if (!finish) return false;
			records[id - 1]!.released = true;
			finish();
			return true;
		},
		async flush() { await writes; if (writeError) throw writeError; },
		async close() {
			for (const finish of held.values()) finish();
			await server.stop(true);
			await writes;
			if (writeError) throw writeError;
		},
	};
}
