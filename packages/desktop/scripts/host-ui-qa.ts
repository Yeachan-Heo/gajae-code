// TEST ONLY: manual Ego QA transport. Never imported by the desktop product.
// Run with Bun; fetch bootstrapUrl from Node and pass its text as the CDP
// Page.addScriptToEvaluateOnNewDocument `source`, then navigate to the allowed origin.
// Zero-provider fixture: GJC_DESKTOP_QA_MODEL_FIXTURE=1 bun packages/desktop/scripts/host-ui-qa.ts
// LIVE=1 is incompatible. Fixture metadata is printed as one JSON bootstrap line.
// Browser controls: __qaFixture.status(), .hold(), .release(requestId),
// .gate(sessionId, 'approval'|'question'|'execution'), .gates(sessionId).
// Gate controls emit/wait on real SDK gates only; the app owns presentation, answers and retirement ACKs.
// Save status before teardown: the owned request/chunk artifact is removed with the QA root.
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import * as readline from "node:readline";
import * as stream from "node:stream";
import { type DesktopMethod, MAX_FRAME_BYTES, parseRequest } from "../../desktop-host/src/protocol";
import {
	assertFixtureMode,
	fixtureEnvironment,
	fixtureLayout,
	type ModelFixture,
	QA_KEY,
	QA_MODEL_IDS,
	QA_PROVIDER,
	readFixtureGateControl,
	seedFixture,
	startModelFixture,
} from "./qa-model-fixture";

const fixtureMode = process.env.GJC_DESKTOP_QA_MODEL_FIXTURE === "1";
if (fixtureMode) assertFixtureMode(process.env);

const origin = "http://127.0.0.1:1420";
const root = path.resolve(import.meta.dir, "../../..");
const token = crypto.randomUUID();
const allowed = new Set<DesktopMethod>([
	"bootstrap",
	"project.open",
	"session.create",
	"session.select",
	"session.rename",
	"session.star",
	"settings.get",
	"settings.set",
	"command.list",
	"command.run",
	"history.get",
	"session.delete",
	"queue.cancel",
	"abort",
	"models.list",
	"activity.get",
	"activity.detail",
	"activity.operate",
	"activity.acknowledge",
	"preferences.get",
	"preferences.apply",
	"gate.present",
	"gate.presented",
	"gate.answer",
	"gate.withdraw",
	"gate.retired",
	"operator.execute",
	"operator.get",
	"operator.abort",
	"operator.fold",
	"btw.open",
	"btw.get",
	"btw.submit",
	"btw.cancel",
	"btw.close",
	"mcp.get",
	"mcp.operate",
	"session.info",
	"model.set",
	"goal.operate",
	"session.export",
	"session.fork",
	// Allowed so the failure path is exercised: the isolated QA home has no
	// provider credentials, so a prompt fails before any network call.
	"prompt",
	"auth.providers",
	"auth.keyProviders",
	"auth.state",
	"tools.list",
	"diff.get",
	"shutdown",
]);
if (fixtureMode) {
	allowed.add("thinking.set");
	allowed.add("auth.setKey");
}
const clients = new Map<string, ReadableStreamDefaultController<Uint8Array>>();
const encoder = new TextEncoder();
let temporary: string | undefined;
let host: Bun.Subprocess<"pipe", "pipe", "pipe"> | undefined;
let fixture: ModelFixture | undefined;
let gateControl: string | undefined;
let server: Bun.Server<undefined> | undefined;
let timer: Timer | undefined;
let heartbeat: Timer | undefined;
let stopping = false;

async function cleanup() {
	if (stopping) return;
	stopping = true;
	if (timer) clearTimeout(timer);
	if (heartbeat) clearInterval(heartbeat);
	for (const client of clients.values()) client.close();
	clients.clear();
	await server?.stop(true);
	if (host && host.exitCode === null) {
		const child = host;
		const force = setTimeout(() => child.kill("SIGKILL"), 3000);
		try {
			child.kill("SIGTERM");
			await child.exited;
		} finally {
			clearTimeout(force);
		}
	}
	try {
		await fixture?.close();
	} finally {
		if (temporary) await fs.rm(temporary, { recursive: true, force: true });
	}
}

function injection(base: string) {
	// A self-contained JS source string: no browser automation closure serialization.
	return `(() => {
		if (location.origin !== ${JSON.stringify(origin)}) return;
		const base = ${JSON.stringify(base)};
		const token = ${JSON.stringify(token)};
		const client = crypto.randomUUID();
		let next = 0;
		const callbacks = new Map();
		const listeners = new Map();
		let events;
		let ready;
		const dispatch = payload => {
			// QA only: keep every frame so a test can assert protocol responses.
			(window.__qaFrames = window.__qaFrames || []).push(payload);
			for (const [id, listener] of listeners) {
				if (listener.event === 'engine-frame')
					callbacks.get(listener.handler)?.({event: 'engine-frame', id, payload});
			}
		};
		const connect = () => {
			if (!ready) {
				const {promise, resolve, reject} = Promise.withResolvers();
				ready = promise;
				events = new EventSource(base + '/events?token=' + token + '&client=' + client);
				events.onopen = () => resolve();
				events.onmessage = event => dispatch(JSON.parse(event.data));
				events.onerror = () => {
					events.close();
					const error = 'QA host event connection closed; reload to reconnect';
					dispatch({type: 'fatal', error});
					reject(new Error(error));
				};
			}
			return ready;
		};
		const post = async (route, body) => {
			await connect();
			if (events.readyState !== EventSource.OPEN) throw new Error('QA event stream is not open');
			const response = await fetch(base + route + '?token=' + token + '&client=' + client, {
				method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify(body)
			});
			if (!response.ok) throw new Error(await response.text());
			return response.json();
		};
		const remove = (event, id) => {
			const listener = listeners.get(id);
			if (listener?.event === event) {
				callbacks.delete(listener.handler);
				listeners.delete(id);
			}
		};
		window.isTauri = true;
		window.__TAURI_INTERNALS__ = {
			transformCallback(callback, once = false) {
				const id = ++next;
				callbacks.set(id, value => { if (once) callbacks.delete(id); callback(value); });
				return id;
			},
			unregisterCallback(id) { callbacks.delete(id); },
			async invoke(command, args = {}) {
				if (command === 'plugin:event|listen') {
					if (args.event !== 'engine-frame' || !callbacks.has(args.handler)) throw new Error('Forbidden QA event');
					const id = ++next;
					listeners.set(id, {event: args.event, handler: args.handler});
					try { await connect(); } catch (error) { remove(args.event, id); throw error; }
					return id;
				}
				if (command === 'plugin:event|unlisten') { remove(args.event, args.eventId); return; }
				if (command === 'select_project') return post('/select-project', {});
				if (command === 'engine_request') {
					await post('/request', args.request);
					return; // Write acknowledgment only; real responses arrive through engine-frame.
				}
				throw new Error('Forbidden QA invocation: ' + command);
			}
		};
		window.__TAURI_EVENT_PLUGIN_INTERNALS__ = {unregisterListener: remove};
		${
			fixtureMode
				? `window.__qaFixture = {
			status: () => post('/fixture/status', {}),
			hold: () => post('/fixture/hold', {}),
			release: requestId => post('/fixture/release', {requestId}),
			gate: (sessionId, kind) => post('/fixture/gate', {sessionId, kind}),
			gates: sessionId => post('/fixture/gates', {sessionId})
		};`
				: ""
		}
		addEventListener('pagehide', () => events?.close(), {once: true});
	})();`;
}

try {
	temporary = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "gjc-host-ui-qa-")));
	const project = path.join(temporary, "qa-project");
	await fs.mkdir(project);
	const cleanEnv = {
		PATH: "/usr/bin:/bin",
		HOME: temporary,
		TMPDIR: temporary,
		LANG: "en_US.UTF-8",
		GIT_CONFIG_NOSYSTEM: "1",
		GIT_CONFIG_GLOBAL: os.devNull,
		GIT_TERMINAL_PROMPT: "0",
	};
	const git: Bun.Subprocess<"ignore", "pipe", "pipe"> = Bun.spawn(["/usr/bin/git", "init", "--quiet", project], {
		cwd: temporary,
		env: cleanEnv,
		stdin: "ignore",
		stdout: "pipe",
		stderr: "pipe",
	});
	const gitTimeout = setTimeout(() => git.kill("SIGKILL"), 10000);
	try {
		if ((await git.exited) !== 0) throw new Error("Isolated git init failed");
	} finally {
		clearTimeout(gitTimeout);
	}
	await Bun.write(path.join(project, "qa-untracked.txt"), "Real isolated desktop QA untracked change.\n");
	// Seed a realistic catalog so the UI renders a non-trivial snapshot instead of
	// an empty workbench: three conversations, one of which is large enough that
	// its bootstrap frame crosses the 64 KiB pipe boundary.
	const dataDir = path.join(temporary, "desktop-data");
	const projectId = crypto.randomUUID();
	const seeded = [
		{ title: "긴 대화", messages: 120, filler: "가".repeat(600) },
		{ title: "짧은 대화", messages: 4, filler: "나".repeat(20) },
		{ title: "즐겨찾기 대화", messages: 2, filler: "다".repeat(20), starred: true },
	];
	const sessions = seeded.map(entry => {
		const id = crypto.randomUUID();
		const relative = `${projectId}/${id}.jsonl`;
		return {
			id,
			relative,
			entry,
			catalog: {
				id,
				projectId,
				title: entry.title,
				starred: entry.starred === true,
				file: relative,
			},
		};
	});
	for (const session of sessions) {
		const file = path.join(dataDir, "sessions", session.relative);
		await fs.mkdir(path.dirname(file), { recursive: true });
		// Match the SDK's transcript format: a session header followed by typed
		// message entries, so the engine loads real history instead of nothing.
		const header = {
			type: "session",
			version: 5,
			// Catalog IDs belong to the Host, not the SDK transcript identity.
			id: crypto.randomUUID(),
			timestamp: new Date(1_700_000_000_000).toISOString(),
			cwd: project,
		};
		const entries = [JSON.stringify(header)];
		for (let index = 0; index < session.entry.messages; index += 1) {
			entries.push(
				JSON.stringify({
					type: "message",
					id: `m${index}`,
					parentId: index === 0 ? null : `m${index - 1}`,
					timestamp: new Date(1_700_000_000_000 + index * 1000).toISOString(),
					message: {
						role: index % 2 === 0 ? "user" : "assistant",
						content: [{ type: "text", text: `[${session.entry.title}] 메시지 ${index} ${session.entry.filler}` }],
						// Real assistant turns always carry usage; a fixture without it is not
						// a faithful transcript and goal accounting rejects it.
						...(index % 2 === 0
							? {}
							: {
									usage: {
										input: 10,
										output: 20,
										cacheRead: 0,
										cacheWrite: 0,
										cost: { input: 0, output: 0, total: 0 },
									},
									model: "qa/fixture",
									stopReason: "stop",
								}),
					},
				}),
			);
		}
		await Bun.write(file, `${entries.join("\n")}\n`);
	}
	await Bun.write(
		path.join(dataDir, "catalog.json"),
		JSON.stringify({
			version: 1,
			projects: [{ id: projectId, name: path.basename(project), path: project }],
			sessions: sessions.map(session => session.catalog),
		}),
	);
	// QA runs against an isolated install by default so nothing touches the user's
	// state. Live mode instead uses the shared install (the product default), so a
	// real turn is driven with the same credentials and default preset as the app.
	const qaEnv: Record<string, string> = {
		...cleanEnv,
		// Shared mode must resolve the real install, so the real HOME is passed through.
		HOME: process.env.GJC_DESKTOP_QA_LIVE === "1" ? os.homedir() : cleanEnv.HOME,
		GJC_DESKTOP_DATA_DIR: dataDir,
		...(process.env.GJC_DESKTOP_QA_LIVE === "1" ? {} : { GJC_DESKTOP_ISOLATED: "1" }),
	};
	if (fixtureMode) {
		const layout = fixtureLayout(temporary);
		fixture = startModelFixture(layout.artifactPath);
		await seedFixture(layout, fixture.baseUrl, fixture.providerToken);
	}
	host = Bun.spawn(
		[
			process.execPath,
			path.join(
				root,
				fixtureMode
					? "packages/desktop-host/test/fixtures/qa-fixture-host.ts"
					: "packages/desktop-host/src/index.ts",
			),
		],
		{
			cwd: temporary,
			env: fixture ? fixtureEnvironment(fixtureLayout(temporary), fixture.baseUrl, fixture.providerToken) : qaEnv,
			stdin: "pipe",
			stdout: "pipe",
			stderr: "pipe",
		},
	);
	const child = host;
	// Drain diagnostics before waiting for the backend control endpoint to start,
	// keeping a tail so a child that dies before the control endpoint exists says
	// why instead of leaving the wait to time out silently.
	let childStderr = "";
	void (async () => {
		for await (const chunk of child.stderr) {
			childStderr = (childStderr + new TextDecoder().decode(chunk)).slice(-4000);
		}
	})();
	if (fixture) {
		const layout = fixtureLayout(temporary);
		const deadline = Date.now() + 30000;
		while (!(await Bun.file(layout.gateControlPath).exists())) {
			if (child.exitCode !== null || Date.now() >= deadline) {
				throw new Error(
					`Fixture gate control did not start${child.exitCode === null ? " within 30s" : ` (backend exited ${child.exitCode})`}${childStderr ? `: ${childStderr.trim()}` : ""}`,
				);
			}
			await Bun.sleep(25);
		}
		gateControl = await readFixtureGateControl(layout);
	}
	server = Bun.serve<undefined>({
		hostname: "127.0.0.1",
		port: 0,
		maxRequestBodySize: MAX_FRAME_BYTES,
		idleTimeout: 0,
		async fetch(request) {
			const url = new URL(request.url);
			const requestOrigin = request.headers.get("Origin");
			const headers = new Headers({ "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" });
			if (requestOrigin === origin) {
				headers.set("Access-Control-Allow-Origin", origin);
				headers.set("Vary", "Origin");
			}
			const reply = (body: string, status = 200) => new Response(body, { status, headers });
			if (url.hostname !== "127.0.0.1" || request.headers.get("host") !== `127.0.0.1:${server?.port}`)
				return reply("Forbidden host", 403);
			if (url.searchParams.get("token") !== token) return reply("Unauthorized", 401);
			if (requestOrigin !== origin && !(requestOrigin === null && url.pathname === "/bootstrap.js"))
				return reply("Forbidden origin", 403);
			const method =
				url.pathname === "/events" || url.pathname === "/bootstrap.js"
					? "GET"
					: url.pathname === "/request" ||
							url.pathname === "/select-project" ||
							(fixture &&
								[
									"/fixture/status",
									"/fixture/hold",
									"/fixture/release",
									"/fixture/gate",
									"/fixture/gates",
								].includes(url.pathname))
						? "POST"
						: null;
			if (!method) return reply("Not found", 404);
			if (request.method === "OPTIONS") {
				const requested =
					request.headers
						.get("Access-Control-Request-Headers")
						?.split(",")
						.map(value => value.trim().toLowerCase()) ?? [];
				if (
					requestOrigin !== origin ||
					request.headers.get("Access-Control-Request-Method") !== method ||
					requested.some(value => value !== "content-type")
				)
					return reply("Forbidden preflight", 403);
				headers.set("Access-Control-Allow-Methods", method);
				headers.set("Access-Control-Allow-Headers", "Content-Type");
				return new Response(null, { status: 204, headers });
			}
			if (request.method !== method) return reply("Method not allowed", 405);
			if (url.pathname === "/bootstrap.js") {
				headers.set("Content-Type", "text/javascript; charset=utf-8");
				return reply(injection(`http://127.0.0.1:${server?.port}`));
			}
			if (stopping || child.exitCode !== null) return reply("Host unavailable", 503);
			const client = url.searchParams.get("client");
			if (!client || !/^[a-f0-9-]{36}$/.test(client)) return reply("Invalid client", 400);
			if (url.pathname === "/events") {
				if (clients.has(client) || clients.size >= 8) return reply("Event stream limit", 409);
				headers.set("Content-Type", "text/event-stream");
				const body = new ReadableStream<Uint8Array>({
					start(controller) {
						clients.set(client, controller);
						controller.enqueue(encoder.encode(": connected\n\n"));
					},
					cancel() {
						clients.delete(client);
					},
				});
				return new Response(body, { headers });
			}
			if (!clients.has(client)) return reply("Open event stream first", 409);
			if (request.headers.get("Content-Type") !== "application/json") return reply("JSON required", 415);
			try {
				const text = await request.text();
				if (encoder.encode(text).byteLength > MAX_FRAME_BYTES) return reply("Request too large", 413);
				headers.set("Content-Type", "application/json");
				if (url.pathname === "/select-project") {
					if (text !== "{}") return reply("Invalid selection request", 400);
					return reply(JSON.stringify(project));
				}
				if (fixture && url.pathname.startsWith("/fixture/")) {
					if (url.pathname === "/fixture/gate" || url.pathname === "/fixture/gates") {
						if (!gateControl || encoder.encode(text).byteLength > 1024) return reply("Invalid gate control", 400);
						const response = await fetch(`${gateControl}${url.pathname.slice("/fixture".length)}`, {
							method: "POST",
							redirect: "error",
							signal: AbortSignal.timeout(5000),
							headers: { "Content-Type": "application/json", "X-Desktop-QA-Fixture": fixture.providerToken },
							body: text,
						});
						return reply(await response.text(), response.status);
					}
					if (url.pathname === "/fixture/status" || url.pathname === "/fixture/hold") {
						if (text !== "{}") return reply("Invalid fixture control", 400);
						if (url.pathname === "/fixture/hold") fixture.holdNext();
					} else {
						const value = JSON.parse(text);
						if (
							!value ||
							Object.keys(value).length !== 1 ||
							!Number.isSafeInteger(value.requestId) ||
							value.requestId < 1
						)
							return reply("Invalid fixture request ID", 400);
						if (!fixture.release(value.requestId)) return reply("Request is not held", 409);
					}
					await fixture.flush();
					return reply(JSON.stringify(fixture.snapshot()));
				}
				const envelope = parseRequest(text);
				if (!allowed.has(envelope.method)) return reply("Forbidden QA method", 403);
				if (
					fixture &&
					envelope.method === "model.set" &&
					!QA_MODEL_IDS.some(id => envelope.params.modelId === `${QA_PROVIDER}/${id}`)
				)
					return reply("Only fixture-owned models are permitted", 403);
				if (
					fixture &&
					envelope.method === "auth.setKey" &&
					(envelope.params.provider !== QA_PROVIDER || envelope.params.key !== QA_KEY)
				)
					return reply("Only the fixture-only fake credential is permitted", 403);
				if (envelope.method === "project.open" && envelope.params.path !== project)
					return reply("Only the isolated QA project may be opened", 403);
				child.stdin.write(`${JSON.stringify(envelope)}\n`);
				await child.stdin.flush();
				return reply("null");
			} catch {
				return reply("Invalid request or unavailable host transport", 400);
			}
		},
	});
	const lines = readline.createInterface({ input: stream.Readable.from(child.stdout), crlfDelay: Infinity });
	void (async () => {
		try {
			for await (const line of lines) {
				if (Buffer.byteLength(line) > MAX_FRAME_BYTES) throw new Error("Host frame exceeds limit");
				JSON.parse(line);
				const bytes = encoder.encode(`data: ${line}\n\n`);
				for (const [id, controller] of clients) {
					if ((controller.desiredSize ?? 0) < -32) {
						controller.close();
						clients.delete(id);
					} else controller.enqueue(bytes);
				}
			}
		} finally {
			await cleanup();
		}
	})().catch(() => {
		process.exitCode = 1;
	});
	heartbeat = setInterval(() => {
		for (const controller of clients.values()) controller.enqueue(encoder.encode(": heartbeat\n\n"));
	}, 15000);
	timer = setTimeout(
		() => {
			void cleanup();
		},
		15 * 60 * 1000,
	);
	process.once("SIGTERM", () => {
		void cleanup();
	});
	process.once("SIGINT", () => {
		void cleanup();
	});
	process.stdout.write(
		`${JSON.stringify({
			port: server.port,
			serverUrl: `http://127.0.0.1:${server.port}`,
			token,
			bootstrapUrl: `http://127.0.0.1:${server.port}/bootstrap.js?token=${token}`,
			pid: process.pid,
			project,
			...(fixture
				? {
						mode: "test-only-model-fixture",
						modelFixture: {
							baseUrl: fixture.baseUrl,
							models: QA_MODEL_IDS.map(id => `${QA_PROVIDER}/${id}`),
							profiles: [...QA_MODEL_IDS],
							artifactPath: fixtureLayout(temporary).artifactPath,
							gateArtifactPath: fixtureLayout(temporary).gateArtifactPath,
							dataDir,
							controls: {
								status: "/fixture/status",
								hold: "/fixture/hold",
								release: "/fixture/release",
								gate: "/fixture/gate",
								gates: "/fixture/gates",
							},
							initialHold: "first completion pauses after initial SSE text until release(requestId) or abort",
						},
					}
				: {}),
		})}\n`,
	);
} catch (error) {
	await cleanup();
	throw error;
}
