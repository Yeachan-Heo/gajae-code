// TEST ONLY: manual Ego QA transport. Never imported by the desktop product.
// Run with Bun; fetch bootstrapUrl from Node and pass its text as the CDP
// Page.addScriptToEvaluateOnNewDocument `source`, then navigate to the allowed origin.
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import * as readline from "node:readline";
import * as stream from "node:stream";
import { type DesktopMethod, MAX_FRAME_BYTES, parseRequest } from "../../desktop-host/src/protocol";

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
	"auth.providers",
	"auth.state",
	"tools.list",
	"diff.get",
	"shutdown",
]);
const clients = new Map<string, ReadableStreamDefaultController<Uint8Array>>();
const encoder = new TextEncoder();
let temporary: string | undefined;
let host: Bun.Subprocess<"pipe", "pipe", "pipe"> | undefined;
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
	if (temporary) await fs.rm(temporary, { recursive: true, force: true });
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
		addEventListener('pagehide', () => events?.close(), {once: true});
	})();`;
}

try {
	temporary = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-host-ui-qa-"));
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
	host = Bun.spawn([process.execPath, path.join(root, "packages/desktop-host/src/index.ts")], {
		cwd: temporary,
		env: { ...cleanEnv, GJC_DESKTOP_DATA_DIR: path.join(temporary, "desktop-data") },
		stdin: "pipe",
		stdout: "pipe",
		stderr: "pipe",
	});
	const child = host;
	// Drain diagnostics without logging credentials or unbounded output.
	void (async () => {
		for await (const _chunk of child.stderr) {
			/* discard */
		}
	})();
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
					: url.pathname === "/request" || url.pathname === "/select-project"
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
				const envelope = parseRequest(text);
				if (!allowed.has(envelope.method)) return reply("Forbidden QA method", 403);
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
			token,
			bootstrapUrl: `http://127.0.0.1:${server.port}/bootstrap.js?token=${token}`,
			pid: process.pid,
			project,
		})}\n`,
	);
} catch (error) {
	await cleanup();
	throw error;
}
