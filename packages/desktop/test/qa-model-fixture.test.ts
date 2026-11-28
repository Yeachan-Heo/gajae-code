import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import * as readline from "node:readline";
import * as stream from "node:stream";
import type { DesktopBtwConversation } from "@gajae-code/desktop-host/btw-protocol";
import type { DesktopMcpOperationResult, DesktopMcpSnapshot } from "@gajae-code/desktop-host/mcp-protocol";
import type {
	DesktopActivityUpdate,
	DesktopFrame,
	DesktopMethod,
	DesktopModel,
	DesktopProject,
	DesktopSession,
	DesktopSnapshot,
} from "@gajae-code/desktop-host/protocol";
import {
	assertFixtureEndpoint,
	assertFixtureMode,
	type FixtureGateSnapshot,
	type FixtureSnapshot,
	fixtureEnvironment,
	fixtureFetch,
	fixtureLayout,
	type ModelFixtureOptions,
	observeFixtureSession,
	QA_DEMONSTRATIONS,
	QA_EDIT_DEMO_FILE,
	QA_KEY,
	QA_MODEL_IDS,
	QA_PROVIDER,
	QA_UNREGISTERED_KEY_ENV,
	readFixtureGateControl,
	type SeedOptions,
	seedFixture,
	startModelFixture,
	validateFixtureEnvironment,
} from "../scripts/qa-model-fixture";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
	while (cleanups.length) await cleanups.pop()?.();
});

async function waitFor(predicate: () => boolean, label: string): Promise<void> {
	const deadline = Date.now() + 25000;
	while (!predicate()) {
		if (Date.now() >= deadline) throw new Error(`Timed out: ${label}`);
		await Bun.sleep(10);
	}
}

async function ownedFixture(options: ModelFixtureOptions = {}, seed: SeedOptions = {}) {
	const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "gjc-host-ui-qa-")));
	const layout = fixtureLayout(root);
	const fixture = startModelFixture(layout.artifactPath, options);
	cleanups.push(async () => {
		try {
			await fixture.close();
		} finally {
			await fs.rm(root, { recursive: true, force: true });
		}
	});
	await seedFixture(layout, fixture.baseUrl, fixture.providerToken, seed);
	const environment = fixtureEnvironment(layout, fixture.baseUrl, fixture.providerToken);
	return { layout, fixture, environment };
}

function completion(baseUrl: string, providerToken: string, signal?: AbortSignal, model = "qa-reasoning") {
	return fetch(`${baseUrl}/chat/completions`, {
		method: "POST",
		signal,
		headers: {
			"Content-Type": "application/json",
			Authorization: `Bearer ${QA_KEY}`,
			"X-Desktop-QA-Fixture": providerToken,
		},
		body: JSON.stringify({
			model,
			stream: true,
			reasoning_effort: "high",
			messages: [{ role: "user", content: "owned fixture prompt" }],
		}),
	});
}

async function stopChild(child: Bun.Subprocess<"pipe", "pipe", "pipe">) {
	if (child.exitCode !== null) return;
	const force = setTimeout(() => child.kill("SIGKILL"), 3000);
	try {
		child.kill("SIGTERM");
		await child.exited;
	} finally {
		clearTimeout(force);
	}
}

async function sdkHost(seed: SeedOptions = {}) {
	const owned = await ownedFixture({}, seed);
	const child = Bun.spawn(
		[process.execPath, path.resolve(import.meta.dir, "../../desktop-host/test/fixtures/qa-fixture-host.ts")],
		{
			cwd: owned.layout.root,
			env: owned.environment,
			stdin: "pipe",
			stdout: "pipe",
			stderr: "pipe",
		},
	);
	cleanups.push(() => stopChild(child));
	const responses = new Map<string, Extract<DesktopFrame, { type: "response" }>>();
	const frames: DesktopFrame[] = [];
	let stderr = "";
	void (async () => {
		for await (const chunk of child.stderr) stderr = (stderr + new TextDecoder().decode(chunk)).slice(-4000);
	})();
	const lines = readline.createInterface({ input: stream.Readable.from(child.stdout), crlfDelay: Infinity });
	const reading = (async () => {
		for await (const line of lines) {
			const frame = JSON.parse(line) as DesktopFrame;
			frames.push(frame);
			if (frame.type === "response") responses.set(frame.id, frame);
		}
	})();
	cleanups.push(async () => {
		await stopChild(child);
		await reading;
	});
	const send = (method: DesktopMethod, params: Record<string, unknown> = {}) => {
		const id = crypto.randomUUID();
		child.stdin.write(`${JSON.stringify({ id, method, params })}\n`);
		const response = (async () => {
			await child.stdin.flush();
			await waitFor(() => {
				if (child.exitCode !== null && !responses.has(id)) throw new Error(`Fixture host exited: ${stderr}`);
				return responses.has(id);
			}, `${method} response; diagnostics: ${stderr}`);
			return responses.get(id)!;
		})();
		return response;
	};
	const call = async <T>(method: DesktopMethod, params: Record<string, unknown> = {}): Promise<T> => {
		const response = await send(method, params);
		if (!response.ok) throw new Error(response.error);
		return response.result as T;
	};
	const bootstrap = await call<DesktopSnapshot>("bootstrap");
	const project = await call<DesktopProject>("project.open", { path: owned.layout.project });
	const session = await call<DesktopSession>("session.create", { projectId: project.id });
	return { ...owned, child, send, call, frames, bootstrap, session, diagnostics: () => stderr };
}

test("real discovered extension startup question does not block publication or prompt admission", async () => {
	const { layout, fixture, call, send, frames, session } = await sdkHost();
	await Bun.write(path.join(layout.root, "extension-question"), "enabled");
	const created = await call<DesktopSession>("session.create", { projectId: session.projectId });
	await waitFor(
		() =>
			frames.some(
				frame =>
					frame.type === "session" &&
					frame.session.id === created.id &&
					frame.session.question?.title === "TEST ONLY extension startup question",
			),
		"extension startup question",
	);
	const question = frames
		.flatMap(frame =>
			frame.type === "session" && frame.session.id === created.id && frame.session.question
				? [frame.session.question]
				: [],
		)
		.at(-1);
	if (!question) throw new Error("Startup question missing");
	const before = fixture.snapshot().requests.length;
	const prompt = send("prompt", { sessionId: created.id, text: "extension barrier turn" });
	await Bun.sleep(100);
	expect(fixture.snapshot().requests.length).toBe(before);
	await call("question.answer", { sessionId: created.id, questionId: question.id, value: "owned answer" });
	await waitFor(
		() => fixture.snapshot().requests.length === before + 1 && fixture.snapshot().requests[before]?.held === true,
		"held post-startup prompt",
	);
	expect(fixture.release(fixture.snapshot().requests[before]!.id)).toBe(true);
	expect((await prompt).ok).toBe(true);
	await waitFor(
		() =>
			frames.some(
				frame =>
					frame.type === "session" &&
					frame.session.id === created.id &&
					frame.session.messages.some(message => message.text === "TEST ONLY extension answered: owned answer"),
			),
		"extension answer notice",
	);
	expect(await Bun.file(path.join(layout.root, "extension-answers.txt")).text()).toBe("owned answer\n");
	expect((await Bun.file(path.join(layout.root, "extension-starts.txt")).text()).trim().split("\n")).toHaveLength(2);
	expect(await Bun.file(path.join(layout.root, "project-extension-loaded")).exists()).toBe(false);
}, 90000);

test("session_start can await an extension-originated user message without self-deadlock", async () => {
	const { layout, fixture, call, send, frames, session } = await sdkHost();
	await Bun.write(path.join(layout.root, "extension-send"), "enabled");
	await Bun.write(path.join(layout.root, "extension-question"), "enabled");
	const created = await call<DesktopSession>("session.create", { projectId: session.projectId });
	await waitFor(
		() => fixture.snapshot().requests.length === 1 && fixture.snapshot().requests[0]?.held === true,
		"extension-originated held turn",
	);
	expect(JSON.stringify(fixture.snapshot().requests[0]!.body.messages)).toContain(
		"TEST ONLY extension startup message",
	);
	const external = send("prompt", { sessionId: created.id, text: "external startup turn" });
	await Bun.sleep(100);
	expect(fixture.snapshot().requests).toHaveLength(1);
	expect(fixture.release(fixture.snapshot().requests[0]!.id)).toBe(true);
	await waitFor(
		() =>
			frames.some(
				frame =>
					frame.type === "session" &&
					frame.session.id === created.id &&
					frame.session.question?.title === "TEST ONLY extension startup question",
			),
		"question after extension send",
	);
	const question = frames
		.flatMap(frame =>
			frame.type === "session" && frame.session.id === created.id && frame.session.question
				? [frame.session.question]
				: [],
		)
		.at(-1);
	if (!question) throw new Error("Startup question missing");
	expect(await Bun.file(path.join(layout.root, "extension-sent.txt")).text()).toBe("sent\n");
	expect(fixture.snapshot().requests).toHaveLength(1);
	await call("question.answer", { sessionId: created.id, questionId: question.id, value: "after send" });
	expect((await external).ok).toBe(true);
	await waitFor(() => fixture.snapshot().requests.length === 2, "external turn after startup");
	expect(JSON.stringify(fixture.snapshot().requests[1]!.body.messages)).toContain("external startup turn");
}, 90000);

test("clear retains one extension runner, refreshes UI ownership and reports one hook error", async () => {
	const { layout, fixture, call, send, frames, session } = await sdkHost();
	const sessionId = session.id;
	await waitFor(
		() =>
			frames.some(
				frame =>
					frame.type === "session" &&
					frame.session.id === sessionId &&
					frame.session.messages.some(message => message.text === "TEST ONLY extension started"),
			),
		"initial extension startup",
	);
	await call("command.run", { sessionId, text: "/clear" });
	const successor = await call<DesktopSession>("session.select", { sessionId });
	expect(successor.controlGeneration).not.toBe(session.controlGeneration);
	const control = await readFixtureGateControl(layout);
	const runner = await fetch(`${control}/runner`, {
		method: "POST",
		headers: { "Content-Type": "application/json", "X-Desktop-QA-Fixture": fixture.providerToken },
		body: JSON.stringify({ sessionId }),
	});
	expect(await runner.json()).toEqual({ sameRunner: true });
	expect(await Bun.file(path.join(layout.root, "extension-starts.txt")).text()).toBe("start\n");
	// clearContext changes generation without switching the session identity.
	expect(await Bun.file(path.join(layout.root, "extension-switches.txt")).exists()).toBe(false);
	const prompt = send("prompt", { sessionId, text: "TEST ONLY generation probe" });
	await waitFor(
		() =>
			frames.some(
				frame =>
					frame.type === "session" &&
					frame.session.id === sessionId &&
					frame.session.question?.title === "TEST ONLY refreshed extension UI",
			),
		"refreshed extension question",
	);
	const question = frames
		.flatMap(frame =>
			frame.type === "session" &&
			frame.session.id === sessionId &&
			frame.session.question?.title === "TEST ONLY refreshed extension UI"
				? [frame.session.question]
				: [],
		)
		.at(-1)!;
	await call("question.answer", { sessionId, questionId: question.id, value: "new owner" });
	await waitFor(() => fixture.snapshot().requests[0]?.held === true, "held generation probe turn");
	expect(fixture.release(fixture.snapshot().requests[0]!.id)).toBe(true);
	await prompt;
	const current = await call<DesktopSession>("session.select", { sessionId });
	expect(await Bun.file(path.join(layout.root, "extension-generation-answers.txt")).text()).toBe("new owner\n");
	expect(
		current.messages.filter(message => message.text.includes("TEST ONLY generation handler failure")),
	).toHaveLength(1);
	expect(current.messages.some(message => message.text === "TEST ONLY stale extension UI")).toBe(false);
	expect(await Bun.file(path.join(layout.root, "extension-starts.txt")).text()).toBe("start\n");
}, 90000);

test("extension initialization failure refuses a first provider turn", async () => {
	const { layout, fixture, call, send, frames, session } = await sdkHost();
	await Bun.write(path.join(layout.root, "extension-init-failure"), "enabled");
	const created = await call<DesktopSession>("session.create", { projectId: session.projectId });
	await waitFor(
		() =>
			frames.some(
				frame =>
					frame.type === "session" &&
					frame.session.id === created.id &&
					frame.session.messages.some(message =>
						message.text.includes("TEST ONLY extension initialization failure"),
					),
			),
		"extension initialization error",
	);
	const before = fixture.snapshot().requests.length;
	const result = await send("prompt", { sessionId: created.id, text: "must not run" });
	expect(result.ok).toBe(false);
	expect(fixture.snapshot().requests.length).toBe(before);
}, 90000);

test("deleting a session cancels its pending extension question without stale notices", async () => {
	const { layout, call, send, frames, session } = await sdkHost();
	await Bun.write(path.join(layout.root, "extension-question"), "enabled");
	const created = await call<DesktopSession>("session.create", { projectId: session.projectId });
	await waitFor(
		() => frames.some(frame => frame.type === "session" && frame.session.id === created.id && frame.session.question),
		"question before deletion",
	);
	const question = frames
		.flatMap(frame =>
			frame.type === "session" && frame.session.id === created.id && frame.session.question
				? [frame.session.question]
				: [],
		)
		.at(-1)!;
	await call("session.delete", { sessionId: created.id });
	expect((await send("question.answer", { sessionId: created.id, questionId: question.id, value: "late" })).ok).toBe(
		false,
	);
	const answers = Bun.file(path.join(layout.root, "extension-answers.txt"));
	const deadline = Date.now() + 10000;
	while (!(await answers.exists())) {
		if (Date.now() > deadline) throw new Error("Cancelled extension continuation did not settle");
		await Bun.sleep(10);
	}
	expect(await answers.text()).toBe("undefined\n");
	expect(
		frames.some(
			frame =>
				frame.type === "session" &&
				frame.session.id === created.id &&
				frame.session.messages.some(message => message.text.includes("extension answered")),
		),
	).toBe(false);
}, 90000);

test("signal shutdown reports a close failure and still terminates the fixture host", async () => {
	const { layout, child, diagnostics } = await sdkHost();
	await Bun.write(path.join(layout.root, "signal-close-failure"), "enabled");
	child.kill("SIGTERM");
	expect(await child.exited).not.toBe(0);
	await waitFor(
		() => diagnostics().includes("QA fixture host signal shutdown failed"),
		"signal close failure diagnostic",
	);
}, 90000);

test("owned real MCP control lifecycle and LSP diagnostics cross the SDK", async () => {
	const { layout, fixture, child, call, send, session } = await sdkHost();
	await Bun.write(path.join(layout.root, "enable-services"), "enabled");
	const created = await call<DesktopSession>("session.create", { projectId: session.projectId });
	const endpoint = await readFixtureGateControl(layout);
	const services = (sessionId = created.id) =>
		fetch(`${endpoint}/services`, {
			method: "POST",
			headers: { "Content-Type": "application/json", "X-Desktop-QA-Fixture": fixture.providerToken },
			body: JSON.stringify({ sessionId }),
		});
	const lifecycle = async (name: string): Promise<Array<{ event: string; pid?: number; sessionId?: string }>> => {
		const file = Bun.file(path.join(layout.root, `${name}-lifecycle.jsonl`));
		if (!(await file.exists())) return [];
		return (await file.text())
			.trim()
			.split("\n")
			.filter(Boolean)
			.map(line => JSON.parse(line));
	};
	const waitLifecycle = async (
		name: string,
		predicate: (events: Array<{ event: string; pid?: number; sessionId?: string }>) => boolean,
	) => {
		const deadline = Date.now() + 15000;
		for (;;) {
			const events = await lifecycle(name);
			if (predicate(events)) return events;
			if (Date.now() >= deadline)
				throw new Error(`Timed out waiting for ${name} lifecycle: ${JSON.stringify(events)}`);
			await Bun.sleep(20);
		}
	};
	expect(
		(
			await fetch(`${endpoint}/services`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ sessionId: created.id }),
			})
		).status,
	).toBe(403);
	const effect = await services();
	expect(effect.status).toBe(200);
	const result = (await effect.json()) as {
		mcpResult: unknown;
		lspResult: unknown;
		mcpCalls: string[];
		mcpUrl: string;
	};
	const mcpBody = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} });
	const invalidHeaders: Record<string, string>[] = [
		{ "Content-Type": "application/json" },
		{ "Content-Type": "application/json", Authorization: "Bearer wrong" },
		{
			"Content-Type": "application/json",
			Authorization: `Bearer ${fixture.providerToken}`,
			Origin: "http://example.invalid",
		},
	];
	for (const headers of invalidHeaders)
		expect((await fetch(result.mcpUrl, { method: "POST", headers, body: mcpBody })).status).toBe(403);
	expect(
		(
			await fetch(`${result.mcpUrl}?other=1`, {
				method: "POST",
				headers: { Authorization: `Bearer ${fixture.providerToken}` },
				body: mcpBody,
			})
		).status,
	).toBe(403);
	expect(JSON.stringify(result.mcpResult)).toContain("owned MCP effect");
	expect(JSON.stringify(result.lspResult)).toContain(`fixture workspace ${layout.project}`);
	expect(result.mcpCalls).toContain("tools/call");
	const initialMcpEvents = await waitLifecycle("mcp", events => events.some(event => event.event === "call"));
	const initialMcpId = initialMcpEvents.findLast(event => event.event === "call")!.sessionId;
	if (!initialMcpId) throw new Error("Initial MCP session ID missing");
	const auth = { Authorization: `Bearer ${fixture.providerToken}`, "Mcp-Session-Id": crypto.randomUUID() };
	expect((await fetch(result.mcpUrl, { method: "DELETE", headers: auth })).status).toBe(404);
	const snapshot = await call<DesktopMcpSnapshot>("mcp.get", { sessionId: created.id });
	expect(snapshot.available).toBe(true);
	const server = snapshot.servers.find(entry => entry.state === "connected");
	if (!server) throw new Error("Owned MCP server not connected");
	const suspended = await call<DesktopMcpOperationResult>("mcp.operate", {
		sessionId: created.id,
		ref: server.ref,
		action: "suspend",
	});
	expect(suspended.status).toBe("suspended");
	const suspendedServer = suspended.snapshot.servers.find(entry => entry.state === "suspended");
	if (!suspendedServer) throw new Error("Owned MCP server not suspended");
	const resumed = await call<DesktopMcpOperationResult>("mcp.operate", {
		sessionId: created.id,
		ref: suspendedServer.ref,
		action: "resume",
	});
	expect(resumed.status).toBe("resumed");
	// A resume reports the server as live before the session catalog is republished,
	// so the resumed tools settle one publication later. Wait for that settlement
	// instead of racing it.
	const awaitResumedCatalog = async () => {
		const deadline = Date.now() + 15000;
		for (;;) {
			const response = await services();
			if (response.status === 200 || Date.now() >= deadline) return response;
			await Bun.sleep(25);
		}
	};
	const afterResume = await awaitResumedCatalog();
	expect(afterResume.status).toBe(200);
	expect(JSON.stringify(await afterResume.json())).toContain("owned MCP effect");
	const waitProcessGone = async (pid: number | undefined) => {
		if (!pid) throw new Error("Owned LSP PID missing");
		const deadline = Date.now() + 15000;
		for (;;) {
			try {
				process.kill(pid, 0);
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code === "ESRCH") return;
				throw error;
			}
			if (Date.now() >= deadline) throw new Error(`Owned LSP process ${pid} did not exit`);
			await Bun.sleep(20);
		}
	};
	const lspBeforeDelete = await waitLifecycle("lsp", events => events.some(event => event.event === "start"));
	const deletePid = lspBeforeDelete.findLast(event => event.event === "start")!.pid;
	const mcpBeforeDelete = await waitLifecycle(
		"mcp",
		events =>
			events.filter(event => event.event === "open").length >= 2 &&
			events.some(event => event.event === "close" && event.sessionId === initialMcpId) &&
			events.some(event => event.event === "terminate" && event.sessionId === initialMcpId),
	);
	const resumedMcpId = mcpBeforeDelete.findLast(event => event.event === "call")?.sessionId;
	if (!resumedMcpId || resumedMcpId === initialMcpId)
		throw new Error("Resumed MCP session identity missing or reused");
	expect(mcpBeforeDelete.some(event => event.event === "open" && event.sessionId === resumedMcpId)).toBe(true);
	// A predecessor's delayed close/termination cannot count for the resumed owner.
	expect(mcpBeforeDelete.some(event => event.event === "close" && event.sessionId === initialMcpId)).toBe(true);
	expect(mcpBeforeDelete.some(event => event.event === "terminate" && event.sessionId === initialMcpId)).toBe(true);
	expect(
		mcpBeforeDelete.some(
			event => (event.event === "close" || event.event === "terminate") && event.sessionId === resumedMcpId,
		),
	).toBe(false);
	await call("session.delete", { sessionId: created.id });
	expect((await send("mcp.operate", { sessionId: created.id, ref: server.ref, action: "suspend" })).ok).toBe(false);
	await waitLifecycle(
		"mcp",
		events =>
			events.some(event => event.event === "close" && event.sessionId === resumedMcpId) &&
			events.some(event => event.event === "terminate" && event.sessionId === resumedMcpId),
	);
	await waitProcessGone(deletePid);
	const next = await call<DesktopSession>("session.create", { projectId: session.projectId });
	expect((await services(next.id)).status).toBe(200);
	const lspBeforeShutdown = await waitLifecycle(
		"lsp",
		events => events.filter(event => event.event === "start").length >= 2,
	);
	const shutdownPid = lspBeforeShutdown.findLast(event => event.event === "start")!.pid;
	expect(shutdownPid).not.toBe(deletePid);
	const mcpBeforeShutdown = await waitLifecycle(
		"mcp",
		events => events.filter(event => event.event === "open").length >= 3,
	);
	const shutdownMcpId = mcpBeforeShutdown.findLast(event => event.event === "call")?.sessionId;
	if (!shutdownMcpId || shutdownMcpId === resumedMcpId || shutdownMcpId === initialMcpId)
		throw new Error("Shutdown MCP session identity missing or reused");
	expect(mcpBeforeShutdown.some(event => event.event === "open" && event.sessionId === shutdownMcpId)).toBe(true);
	expect(
		mcpBeforeShutdown.some(
			event => (event.event === "close" || event.event === "terminate") && event.sessionId === shutdownMcpId,
		),
	).toBe(false);
	child.kill("SIGTERM");
	expect(await child.exited).toBe(143);
	await waitLifecycle(
		"mcp",
		events =>
			events.some(event => event.event === "close" && event.sessionId === shutdownMcpId) &&
			events.some(event => event.event === "terminate" && event.sessionId === shutdownMcpId),
	);
	await waitProcessGone(shutdownPid);
}, 90000);

test("a desktop turn executes a real builtin tool from the full registry", async () => {
	const { layout, call, send, fixture, frames, session } = await sdkHost();
	const available = await call<{ available: string[]; active: string[] }>("tools.list", { sessionId: session.id });
	// The registry the SDK ships is larger than the list below, so the floor fails if a session
	// is built from a reduced tool list that happens to contain exactly these names.
	expect(available.available.length).toBeGreaterThan(11);
	for (const name of ["read", "write", "edit", "bash", "search", "find", "task", "job", "todo_write", "goal", "ask"])
		expect(available.available).toContain(name);
	await call("tools.set", { sessionId: session.id, names: ["read", "bash"] });

	const target = path.join(layout.root, "tool-target.txt");
	await Bun.write(target, "fixture tool line\n");
	const prompt = send("prompt", {
		sessionId: session.id,
		text: `qa-tool-call:read:{"path":${JSON.stringify(target)}}`,
	});
	await waitFor(() => fixture.snapshot().requests.length === 1, "fixture request");
	const request = fixture.snapshot().requests[0]!;
	expect((request.body.tools as Array<{ function: { name: string } }>).map(tool => tool.function.name).sort()).toEqual(
		["bash", "read"],
	);
	expect(fixture.release(request.id)).toBe(true);
	await waitFor(
		() =>
			frames.some(
				frame =>
					frame.type === "session" &&
					frame.session.id === session.id &&
					frame.session.messages.some(
						message =>
							message.role === "tool" &&
							message.toolName === "read" &&
							message.text.includes("fixture tool line"),
					),
			),
		"read tool result",
	);
	// The second model call sees the tool result and finishes the turn normally.
	await waitFor(() => fixture.snapshot().requests.length === 2, "post-tool request");
	expect(fixture.snapshot().requests[1]!.held).toBe(false);
	expect((await prompt).ok).toBe(true);
}, 60000);

test("fixture observation reads exact old/revised/continuation leaves without provider calls or manager mutation", async () => {
	const { layout, fixture, child, call, frames, session } = await sdkHost();
	const observe = (pid = child.pid, sessionId = session.id) =>
		observeFixtureSession(layout, fixture.baseUrl, fixture.providerToken, sessionId, pid);
	const first = call("prompt", { sessionId: session.id, text: "original fixture branch" });
	await waitFor(() => fixture.snapshot().requests.length === 1, "first fixture request");
	expect(fixture.release(1)).toBe(true);
	await first;
	const original = frames
		.flatMap(frame => (frame.type === "session" && frame.session.id === session.id ? frame.session.messages : []))
		.find(message => message.role === "user" && message.text === "original fixture branch");
	if (!original?.entryId) throw new Error("Missing persisted original prompt");
	await call("prompt", { sessionId: session.id, text: "original branch continuation" });
	const old = await observe();
	await call("prompt", { sessionId: session.id, text: "revised fixture branch", editEntryId: original.entryId });
	const revised = await observe();
	expect(revised.selectedLeafId).not.toBe(old.selectedLeafId);
	expect(revised.sdkSessionId).toBe(old.sdkSessionId);
	expect(revised.transcriptFile).toBe(old.transcriptFile);
	await call("session.revision", { sessionId: session.id, entryId: original.entryId });
	expect(await observe()).toEqual(old);
	expect(fixture.snapshot().requests).toHaveLength(3);
	await expect(observe(child.pid + 1)).rejects.toThrow("Stale fixture observer");
	await expect(observe(child.pid, crypto.randomUUID())).rejects.toThrow("Unknown fixture session");
	const control = (await Bun.file(path.join(layout.root, "session-observers", `${old.sdkSessionId}.json`)).json()) as {
		baseUrl: string;
	};
	const request = (headers: Record<string, string>, body = "{}") =>
		fetch(`${control.baseUrl}/observe`, {
			method: "POST",
			headers: { "Content-Type": "application/json", ...headers },
			body,
		});
	expect((await request({ "X-Desktop-QA-Fixture": "wrong" })).status).toBe(403);
	expect(
		(await request({ "X-Desktop-QA-Fixture": fixture.providerToken, Origin: "http://127.0.0.1:1420" })).status,
	).toBe(403);
	expect((await request({ "X-Desktop-QA-Fixture": fixture.providerToken }, '{"leaf":"other"}')).status).toBe(400);
	expect((await fetch(`${control.baseUrl}/observe`)).status).toBe(403);
	expect(await observe()).toEqual(old);
	expect(fixture.snapshot().requests).toHaveLength(3);
	const catalogPath = path.join(layout.dataDir, "catalog.json");
	const catalogText = await Bun.file(catalogPath).text();
	const catalog = JSON.parse(catalogText) as { sessions: Array<{ id: string; file: string }> };
	const saved = catalog.sessions.find(entry => entry.id === session.id);
	if (!saved) throw new Error("Missing owned catalog row");
	saved.file = "../../../outside.jsonl";
	try {
		await Bun.write(catalogPath, JSON.stringify(catalog));
		await expect(observe()).rejects.toThrow("Non-owned fixture transcript");
	} finally {
		await Bun.write(catalogPath, catalogText);
	}
	expect(await observe()).toEqual(old);
}, 90000);

describe("test-only desktop model fixture safety", () => {
	test("requires explicit fixture opt-in and refuses LIVE before creating state", () => {
		expect(() => assertFixtureMode({})).toThrow("explicit fixture");
		expect(() => assertFixtureMode({ GJC_DESKTOP_QA_MODEL_FIXTURE: "1", GJC_DESKTOP_QA_LIVE: "1" })).toThrow(
			"forbids LIVE",
		);
		for (const endpoint of [
			"https://example.com/v1",
			"http://localhost:1234/v1",
			"http://127.0.0.2:1234/v1",
			"http://127.0.0.1:1234/v1?target=external",
			"http://user@127.0.0.1:1234/v1",
			"http://127.0.0.1:1234/v1/",
		])
			expect(() => assertFixtureEndpoint(endpoint)).toThrow("owned loopback");
	});

	test("owns every discovery root and rejects inherited credentials, routing, live mode and symlinks", async () => {
		const { layout, environment } = await ownedFixture();
		expect((await validateFixtureEnvironment(environment)).layout).toEqual(layout);
		for (const key of [
			"HOME",
			"USERPROFILE",
			"XDG_CONFIG_HOME",
			"XDG_DATA_HOME",
			"XDG_STATE_HOME",
			"XDG_CACHE_HOME",
			"GJC_CODING_AGENT_DIR",
			"PI_CODING_AGENT_DIR",
			"GJC_DESKTOP_DATA_DIR",
		])
			expect(environment[key]!.startsWith(`${layout.root}${path.sep}`)).toBe(true);
		for (const patch of [
			{ HOME: os.homedir() },
			{ OPENAI_API_KEY: "must-not-inherit" },
			{ HTTPS_PROXY: "http://example.invalid" },
			{ GJC_DESKTOP_QA_LIVE: "1" },
			{ GJC_DESKTOP_QA_FIXTURE_URL: "http://127.0.0.1:1234/v1" },
			// Wrapper-only controls and the onboarding credential reference never reach the Host.
			{ GJC_DESKTOP_QA_ONBOARDING: "1" },
			{ [QA_UNREGISTERED_KEY_ENV]: QA_KEY },
		])
			await expect(validateFixtureEnvironment({ ...environment, ...patch })).rejects.toThrow();
		const cache = environment.XDG_CACHE_HOME!;
		await fs.rmdir(cache);
		await fs.symlink(layout.project, cache);
		await expect(validateFixtureEnvironment(environment)).rejects.toThrow("symlinked");
	});

	test("network fence rejects other ports, paths, credentials and redirects before transport", async () => {
		const { fixture } = await ownedFixture();
		let calls = 0;
		let redirect: RequestRedirect | undefined;
		const transport = Object.assign(
			async (_input: string | URL | Request, init?: RequestInit) => {
				calls += 1;
				redirect = init?.redirect;
				return new Response("owned");
			},
			{ preconnect: () => {} },
		) as typeof fetch;
		const guarded = fixtureFetch(fixture.baseUrl, fixture.providerToken, transport);
		const headers = { Authorization: `Bearer ${QA_KEY}`, "X-Desktop-QA-Fixture": fixture.providerToken };
		for (const endpoint of [
			"https://example.invalid/v1/chat/completions",
			"http://127.0.0.1:1/v1/chat/completions",
			`${fixture.baseUrl}/models`,
			`${fixture.baseUrl}/chat/completions?x=1`,
		])
			await expect(guarded(endpoint, { method: "POST", headers })).rejects.toThrow("non-owned");
		await expect(guarded(`${fixture.baseUrl}/chat/completions`, { method: "POST" })).rejects.toThrow("non-owned");
		expect(calls).toBe(0);
		expect(await (await guarded(`${fixture.baseUrl}/chat/completions`, { method: "POST", headers })).text()).toBe(
			"owned",
		);
		expect(calls).toBe(1);
		expect(redirect).toBe("error");
		const mcpUrl = "http://127.0.0.1:12345/mcp";
		const mcpGuard = fixtureFetch(fixture.baseUrl, fixture.providerToken, transport, mcpUrl);
		await expect(mcpGuard(mcpUrl, { method: "POST" })).rejects.toThrow("non-owned");
		await expect(
			mcpGuard(mcpUrl, {
				method: "POST",
				headers: { Authorization: `Bearer ${fixture.providerToken}`, Origin: "http://example.invalid" },
			}),
		).rejects.toThrow("non-owned");
		expect(
			(await mcpGuard(mcpUrl, { method: "POST", headers: { Authorization: `Bearer ${fixture.providerToken}` } }))
				.status,
		).toBe(200);
		expect(calls).toBe(2);
	});
});

describe("deterministic loopback SSE", () => {
	test("only the forced title tool contract bypasses the main hold", async () => {
		const { fixture } = await ownedFixture();
		const headers = {
			"Content-Type": "application/json",
			Authorization: `Bearer ${QA_KEY}`,
			"X-Desktop-QA-Fixture": fixture.providerToken,
		};
		const body = {
			model: "qa-reasoning",
			stream: true,
			messages: [
				{
					role: "developer",
					content: "Generate a 3-6 word title for a coding session from the supplied user message",
				},
				{ role: "user", content: "digest evidence" },
			],
			tool_choice: { type: "function", function: { name: "set_title" } },
			tools: [
				{
					type: "function",
					function: {
						name: "set_title",
						parameters: {
							type: "object",
							properties: { title: { type: "string" } },
							required: ["title"],
							additionalProperties: false,
						},
					},
				},
			],
		};
		const title = await fetch(`${fixture.baseUrl}/chat/completions`, {
			method: "POST",
			headers,
			body: JSON.stringify(body),
		});
		const text = await title.text();
		expect(text).toContain('"name":"set_title"');
		expect(text).toContain("Fixture Generated Session Title");
		expect(text).toContain('"finish_reason":"tool_calls"');
		expect(text).toContain("data: [DONE]\n\n");
		expect(fixture.snapshot()).toMatchObject({
			holdNext: true,
			requests: [],
			titleRequests: [{ id: 1, held: false, state: "completed", body }],
		});
		const impostor = await fetch(`${fixture.baseUrl}/chat/completions`, {
			method: "POST",
			headers,
			body: JSON.stringify({ ...body, tools: [] }),
		});
		expect(fixture.snapshot().requests[0]).toMatchObject({ id: 1, state: "held", held: true });
		expect(fixture.snapshot().titleRequests).toHaveLength(1);
		expect(fixture.release(1)).toBe(true);
		await impostor.text();
		await Promise.all(
			Array.from({ length: 63 }, async () => {
				const response = await fetch(`${fixture.baseUrl}/chat/completions`, {
					method: "POST",
					headers,
					body: JSON.stringify(body),
				});
				expect(response.status).toBe(200);
				await response.text();
			}),
		);
		const excessTitle = await fetch(`${fixture.baseUrl}/chat/completions`, {
			method: "POST",
			headers,
			body: JSON.stringify(body),
		});
		expect(excessTitle.status).toBe(429);
		expect(fixture.snapshot().titleRequests).toHaveLength(64);
		const nextMain = await completion(fixture.baseUrl, fixture.providerToken);
		expect(nextMain.status).toBe(200);
		await nextMain.text();
		expect(fixture.snapshot().requests.map(record => record.id)).toEqual([1, 2]);
	});

	test("streams before holding, records exact body, releases once and persists terminal chunks", async () => {
		const { layout, fixture } = await ownedFixture();
		const response = await completion(fixture.baseUrl, fixture.providerToken);
		expect(response.headers.get("Content-Type")).toBe("text/event-stream");
		const reader = response.body!.getReader();
		let text = "";
		while (!text.includes("started.")) text += new TextDecoder().decode((await reader.read()).value);
		expect(text).toContain("reasoning_content");
		expect(text).not.toContain("[DONE]");
		expect(fixture.snapshot().requests[0]).toMatchObject({
			id: 1,
			state: "held",
			held: true,
			released: false,
			body: { model: "qa-reasoning", reasoning_effort: "high" },
		});
		expect(fixture.release(2)).toBe(false);
		expect(fixture.release(1)).toBe(true);
		expect(fixture.release(1)).toBe(false);
		while (true) {
			const part = await reader.read();
			if (part.done) break;
			text += new TextDecoder().decode(part.value);
		}
		expect(text).toContain("Fixture turn 1 complete.");
		expect(text).toContain('"total_tokens":20');
		expect(text).toContain("[DONE]");
		await fixture.flush();
		const artifact = (await Bun.file(layout.artifactPath).json()) as FixtureSnapshot;
		expect(artifact.requests[0]).toMatchObject({ state: "completed", released: true });
		expect(artifact.requests[0]!.chunks.at(-1)).toBe("[DONE]");
	});

	test("abort releases held resources without a fake successful completion; hold can be rearmed", async () => {
		const { fixture } = await ownedFixture();
		const controller = new AbortController();
		const response = await completion(fixture.baseUrl, fixture.providerToken, controller.signal);
		await response.body!.getReader().read();
		controller.abort();
		await waitFor(() => fixture.snapshot().requests[0]?.state === "aborted", "fixture cancellation");
		expect(fixture.release(1)).toBe(false);
		expect(fixture.snapshot().requests[0]!.chunks).not.toContain("[DONE]");
		fixture.holdNext();
		const next = await completion(fixture.baseUrl, fixture.providerToken, undefined, "qa-plain");
		expect(fixture.snapshot().requests[1]).toMatchObject({ state: "held", held: true });
		expect(fixture.release(2)).toBe(true);
		expect(await next.text()).not.toContain("reasoning_content");
	});

	test("an interactive run can skip the initial hold and still arm one later", async () => {
		const { fixture } = await ownedFixture({ initialHold: false });
		expect(fixture.snapshot()).toMatchObject({ holdNext: false, requestLimit: 64 });
		const first = await completion(fixture.baseUrl, fixture.providerToken);
		expect(await first.text()).toContain("Fixture turn 1 complete.");
		expect(fixture.snapshot().requests[0]).toMatchObject({ state: "completed", held: false, released: false });
		fixture.holdNext();
		const second = await completion(fixture.baseUrl, fixture.providerToken);
		expect(fixture.snapshot().requests[1]).toMatchObject({ state: "held", held: true });
		expect(fixture.release(2)).toBe(true);
		expect(await second.text()).toContain("Fixture turn 2 complete.");
	});

	test("the completion cap is configurable within bounds", async () => {
		for (const requestLimit of [0, 513, 1.5, Number.NaN])
			expect(() => startModelFixture(path.join(os.tmpdir(), "never-written.json"), { requestLimit })).toThrow(
				"request limit must be an integer from 1 to 512",
			);
		const { fixture } = await ownedFixture({ initialHold: false, requestLimit: 2 });
		for (const id of [1, 2]) {
			const response = await completion(fixture.baseUrl, fixture.providerToken);
			expect(await response.text()).toContain(`Fixture turn ${id} complete.`);
		}
		expect((await completion(fixture.baseUrl, fixture.providerToken)).status).toBe(429);
		expect(fixture.snapshot()).toMatchObject({ requestLimit: 2, requests: [{ id: 1 }, { id: 2 }] });
	});

	test("provider route refuses browser origins, bad auth, unknown models and non-completion routes", async () => {
		const { fixture } = await ownedFixture();
		const headers = {
			Authorization: `Bearer ${QA_KEY}`,
			"X-Desktop-QA-Fixture": fixture.providerToken,
			"Content-Type": "application/json",
		};
		for (const init of [
			{ headers: {} },
			{ headers: { ...headers, Origin: "http://127.0.0.1:1420" } },
			{ headers: { ...headers, "X-Desktop-QA-Fixture": "wrong" } },
		])
			expect(
				(await fetch(`${fixture.baseUrl}/chat/completions`, { method: "POST", body: "{}", ...init })).status,
			).toBe(403);
		expect((await fetch(`${fixture.baseUrl}/models`, { method: "POST", headers, body: "{}" })).status).toBe(403);
		expect((await completion(fixture.baseUrl, fixture.providerToken, undefined, "external-model")).status).toBe(400);
		expect(fixture.snapshot().requests).toEqual([]);
	});
});

interface StreamedToolCall {
	index: number;
	id: string;
	type: string;
	function: { name: string; arguments: string };
}

function markerCompletion(
	fixture: { baseUrl: string; providerToken: string },
	messages: Array<Record<string, unknown>>,
	tools: string[],
) {
	return fetch(`${fixture.baseUrl}/chat/completions`, {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			Authorization: `Bearer ${QA_KEY}`,
			"X-Desktop-QA-Fixture": fixture.providerToken,
		},
		body: JSON.stringify({
			model: "qa-plain",
			stream: true,
			messages,
			tools: tools.map(name => ({ type: "function", function: { name, parameters: { type: "object" } } })),
		}),
	});
}

async function streamed(response: Response) {
	expect(response.status).toBe(200);
	const events = (await response.text())
		.split("\n\n")
		.filter(event => event.startsWith("data: {"))
		.map(
			event =>
				JSON.parse(event.slice(6)) as {
					choices: Array<{
						delta: { content?: string; tool_calls?: StreamedToolCall[] };
						finish_reason: string | null;
					}>;
				},
		);
	const choices = events.flatMap(event => event.choices);
	return {
		calls: choices.flatMap(choice => choice.delta.tool_calls ?? []),
		text: choices.map(choice => choice.delta.content ?? "").join(""),
		finish: choices.map(choice => choice.finish_reason).filter(Boolean),
	};
}

async function refusal(response: Response): Promise<string> {
	expect(response.status).toBe(400);
	const body = (await response.json()) as { error: { message: string; code: string } };
	expect(body.error.code).toBe("qa_fixture_refused");
	return body.error.message;
}

const user = (content: string) => ({ role: "user", content: [{ type: "text", text: content }] });
const answered = (...names: string[]) => [
	{
		role: "assistant",
		content: "earlier step",
		tool_calls: names.map((name, index) => ({
			id: `earlier-${index}`,
			type: "function",
			function: { name, arguments: "{}" },
		})),
	},
	...names.map((_, index) => ({ role: "tool", tool_call_id: `earlier-${index}`, content: "earlier result" })),
];

describe("scripted tool-call markers", () => {
	test("qa-tool-calls streams several calls in one response and only while its message is newest", async () => {
		const { fixture } = await ownedFixture();
		const marker = `qa-tool-calls:${JSON.stringify([
			{ name: "read", arguments: { path: "probe.move" } },
			{ name: "find", arguments: { paths: ["*.move"] } },
			{ name: "search", arguments: { pattern: "OWNED" } },
		])}`;
		const tools = ["read", "find", "search", "bash"];
		const first = await markerCompletion(fixture, [user(marker)], tools);
		expect(fixture.release(1)).toBe(true);
		const response = await streamed(first);
		expect(response.calls).toEqual([
			{
				index: 0,
				id: "qa-tool-call-1-1",
				type: "function",
				function: { name: "read", arguments: '{"path":"probe.move"}' },
			},
			{
				index: 1,
				id: "qa-tool-call-1-2",
				type: "function",
				function: { name: "find", arguments: '{"paths":["*.move"]}' },
			},
			{
				index: 2,
				id: "qa-tool-call-1-3",
				type: "function",
				function: { name: "search", arguments: '{"pattern":"OWNED"}' },
			},
		]);
		expect(response.finish).toEqual(["tool_calls"]);
		// Once the three results follow, the same marker closes the turn instead of re-firing.
		const closing = await streamed(
			await markerCompletion(fixture, [user(marker), ...answered("read", "find", "search")], tools),
		);
		expect(closing.calls).toEqual([]);
		expect(closing.text).toContain("Fixture turn 2 complete.");
		expect(closing.finish).toEqual(["stop"]);
	});

	test("qa-tool-chain answers step k after k responses and checks each step against that request's tools", async () => {
		const { fixture } = await ownedFixture();
		const marker = `qa-tool-chain:${JSON.stringify([
			{ name: "search_tool_bm25", arguments: { query: "todo", limit: 1 } },
			{ name: "todo_write", arguments: { ops: [{ op: "init", list: [{ phase: "One", items: ["a"] }] }] } },
			[
				{ name: "read", arguments: { path: "a.txt" } },
				{ name: "read", arguments: { path: "b.txt" } },
			],
		])}`;
		const first = await markerCompletion(fixture, [user(marker)], ["read", "search_tool_bm25"]);
		expect(fixture.release(1)).toBe(true);
		expect((await streamed(first)).calls.map(call => call.function)).toEqual([
			{ name: "search_tool_bm25", arguments: '{"query":"todo","limit":1}' },
		]);
		// Step 2 is refused while the request does not offer todo_write, and answered once it does.
		const unoffered = await refusal(
			await markerCompletion(fixture, [user(marker), ...answered("search_tool_bm25")], ["read", "search_tool_bm25"]),
		);
		expect(unoffered).toContain("qa-tool-chain step 2: tool todo_write is not offered in this request");
		expect(fixture.snapshot().requests[1]).toMatchObject({ id: 2, state: "refused", held: false, chunks: [] });
		const activated = await streamed(
			await markerCompletion(
				fixture,
				[user(marker), ...answered("search_tool_bm25")],
				["read", "search_tool_bm25", "todo_write"],
			),
		);
		expect(activated.calls.map(call => call.function.name)).toEqual(["todo_write"]);
		// A step may hold several calls; the chain counts responses, not results.
		const grouped = await streamed(
			await markerCompletion(
				fixture,
				[user(marker), ...answered("search_tool_bm25"), ...answered("todo_write")],
				["read", "todo_write"],
			),
		);
		expect(grouped.calls.map(call => [call.id, call.function.arguments])).toEqual([
			["qa-tool-call-4-1", '{"path":"a.txt"}'],
			["qa-tool-call-4-2", '{"path":"b.txt"}'],
		]);
		const closing = await streamed(
			await markerCompletion(
				fixture,
				[user(marker), ...answered("search_tool_bm25"), ...answered("todo_write"), ...answered("read", "read")],
				["read"],
			),
		);
		expect(closing.calls).toEqual([]);
		expect(closing.finish).toEqual(["stop"]);
		// A newer user message ends the chain.
		const later = await streamed(
			await markerCompletion(
				fixture,
				[user(marker), ...answered("search_tool_bm25"), user("plain")],
				["todo_write"],
			),
		);
		expect(later.calls).toEqual([]);
	});

	test("malformed, ambiguous or unoffered markers are refused before streaming and keep the pending hold", async () => {
		const { layout, fixture } = await ownedFixture();
		const cases: Array<[string, string]> = [
			['qa-tool-calls:[{"name":"read"', "qa-tool-calls is not valid JSON"],
			['qa-tool-chain:[{"name":"read"}] trailing words', "qa-tool-chain is not valid JSON"],
			["qa-tool-calls:[]", "qa-tool-calls must list 1 to 16 calls"],
			['qa-tool-calls:[{"name":"read","args":{}}]', "qa-tool-calls call 1 must be"],
			['qa-tool-chain:[{"name":"read","arguments":[1]}]', "qa-tool-chain step 1 call 1 must be"],
			["qa-tool-call:read:[1]", "qa-tool-call arguments must be a JSON object"],
			["qa-tool-call:edit", "qa-tool-call: tool edit is not offered in this request (offered: read)"],
			['qa-tool-call:read qa-tool-chain:[{"name":"read"}]', "only one qa-tool marker"],
		];
		for (const [marker, reason] of cases)
			expect(await refusal(await markerCompletion(fixture, [user(marker)], ["read"]))).toContain(reason);
		const snapshot = fixture.snapshot();
		expect(snapshot.holdNext).toBe(true);
		expect(snapshot.requests.map(record => [record.state, record.held, record.chunks.length])).toEqual(
			cases.map(() => ["refused", false, 0]),
		);
		expect(snapshot.requests.every(record => record.error?.startsWith("TEST ONLY fixture refused"))).toBe(true);
		// The first completion that actually streams still takes the initial hold.
		const valid = await markerCompletion(fixture, [user("qa-tool-call:read")], ["read"]);
		expect(fixture.snapshot().requests.at(-1)).toMatchObject({ state: "held", held: true });
		expect(fixture.release(cases.length + 1)).toBe(true);
		expect((await streamed(valid)).calls.map(call => call.function)).toEqual([{ name: "read", arguments: "{}" }]);
		await fixture.flush();
		expect(((await Bun.file(layout.artifactPath).json()) as FixtureSnapshot).requests[0]?.state).toBe("refused");
	});
});

test("a refused chain step settles the real Host turn with the reason and leaves nothing held", async () => {
	const { fixture, call, send, session } = await sdkHost();
	// todo_write stays hidden behind tool search, so step 2 is never offered.
	const marker = `qa-tool-chain:${JSON.stringify([
		{ name: "read", arguments: { path: "probe.move" } },
		{ name: "todo_write", arguments: { ops: [{ op: "init", list: [{ phase: "One", items: ["a"] }] }] } },
	])}`;
	const prompt = send("prompt", { sessionId: session.id, text: marker });
	await waitFor(() => fixture.snapshot().requests.length === 1, "chain step 1");
	expect(fixture.release(1)).toBe(true);
	await prompt;
	const requests = fixture.snapshot().requests;
	expect(requests.map(record => record.state)).toEqual(["completed", "refused"]);
	expect(requests[1]!.error).toContain("qa-tool-chain step 2: tool todo_write is not offered");
	const settled = await call<DesktopSession>("session.select", { sessionId: session.id });
	expect(settled.status).not.toBe("running");
	expect(settled.messages.some(message => message.role === "tool" && message.toolName === "read")).toBe(true);
	expect(settled.messages.some(message => message.text.includes("todo_write is not offered"))).toBe(true);
}, 60000);

test("the onboarding seed starts with no models until the app stores the fixture key", async () => {
	const { fixture, call, send, frames, bootstrap, session } = await sdkHost({ credential: "unregistered" });
	expect(bootstrap.models).toEqual([]);
	expect(session.model).toBeUndefined();
	expect(await call<string[]>("auth.keyProviders")).toContain(QA_PROVIDER);
	const before = frames.length;
	expect(await call<Record<string, unknown>>("auth.setKey", { provider: QA_PROVIDER, key: QA_KEY })).toEqual({
		provider: QA_PROVIDER,
		saved: true,
		catalogRefreshed: true,
	});
	const published = frames.slice(before).findLast(frame => frame.type === "snapshot");
	if (published?.type !== "snapshot") throw new Error("No snapshot after the key was stored");
	expect(published.snapshot.models.map(model => model.id)).toEqual(QA_MODEL_IDS.map(id => `${QA_PROVIDER}/${id}`));
	const created = await call<DesktopSession>("session.create", { projectId: session.projectId });
	expect(created.model).toBe(`${QA_PROVIDER}/qa-reasoning`);
	// The stored key is the one the fenced transport and the fixture both demand.
	const prompt = send("prompt", { sessionId: created.id, text: "first onboarded turn" });
	await waitFor(() => fixture.snapshot().requests.length === 1, "onboarded completion");
	expect(fixture.release(1)).toBe(true);
	expect((await prompt).ok).toBe(true);
	expect(fixture.snapshot().requests[0]).toMatchObject({ state: "completed", body: { model: "qa-reasoning" } });
}, 60000);

test("the tool search demonstration activates todo_write between completions of one turn", async () => {
	const { fixture, call, send, session } = await sdkHost();
	const prompt = send("prompt", { sessionId: session.id, text: QA_DEMONSTRATIONS.searchThenTodo.prompt });
	await waitFor(() => fixture.snapshot().requests.length === 1, "search step");
	expect(fixture.release(1)).toBe(true);
	expect((await prompt).ok).toBe(true);
	const offered = fixture
		.snapshot()
		.requests.map(record =>
			(record.body.tools as Array<{ function: { name: string } }>).map(tool => tool.function.name),
		);
	// Search, todo_write, closing text: no hidden reminder turns follow the unfinished list.
	expect(offered).toHaveLength(3);
	expect(offered[0]).toContain("search_tool_bm25");
	expect(offered[0]).not.toContain("todo_write");
	expect(offered[1]).toContain("todo_write");
	const searchResult = (fixture.snapshot().requests[1]!.body.messages as Array<{ role: string; content: unknown }>)
		.filter(message => message.role === "tool")
		.at(-1);
	expect(JSON.parse(String(searchResult?.content))).toMatchObject({ activated_tools: ["todo_write"] });
	const settled = await call<DesktopSession>("session.select", { sessionId: session.id });
	expect(settled.messages.flatMap(message => (message.role === "tool" ? [message.toolName] : []))).toEqual([
		"search_tool_bm25",
		"todo_write",
	]);
	expect(settled.todos?.map(phase => [phase.name, phase.tasks.map(task => task.status)])).toEqual([
		["Investigate", ["completed", "in_progress"]],
		["Fix", ["pending", "pending"]],
		["Verify", ["pending", "pending"]],
	]);
}, 60000);

test("the printed tool demonstrations run as documented against the real Host", async () => {
	const { layout, fixture, child, call, send, session } = await sdkHost();
	const editTarget = path.join(layout.project, QA_EDIT_DEMO_FILE);
	const original = await Bun.file(editTarget).text();
	const toolNames = async () =>
		(await call<DesktopSession>("session.select", { sessionId: session.id })).messages.flatMap(message =>
			message.role === "tool" && message.toolName ? [message.toolName] : [],
		);
	// Evidence the fixture owns: the completions of the turn and the tool results the SDK sent back.
	const run = async (prompt: string) => {
		const rowsBefore = (await toolNames()).length;
		const requestsBefore = fixture.snapshot().requests.length;
		const started = Date.now();
		const response = send("prompt", { sessionId: session.id, text: prompt });
		if (requestsBefore === 0) {
			await waitFor(() => fixture.snapshot().requests.length === 1, "first demonstration");
			expect(fixture.release(1)).toBe(true);
		}
		expect((await response).ok).toBe(true);
		const requests = fixture.snapshot().requests.slice(requestsBefore);
		const closing = requests.at(-1)!.body.messages as Array<{ role: string; content: unknown }>;
		return {
			requests,
			results: closing.filter(message => message.role === "tool").map(message => String(message.content)),
			rows: (await toolNames()).slice(rowsBefore),
			elapsed: Date.now() - started,
		};
	};

	const failing = await run(QA_DEMONSTRATIONS.failingRead.prompt);
	expect(failing.rows).toEqual(["read"]);
	expect(failing.results).toHaveLength(1);
	expect(failing.results[0]).toContain("qa-missing-file.txt' not found");

	// Two seconds after the model asked for the call, the turn is still running without its result.
	const callRequest = fixture.snapshot().requests.length + 1;
	const probe = (async () => {
		await waitFor(() => fixture.snapshot().requests[callRequest - 1]?.state === "completed", "slow call emitted");
		await Bun.sleep(2000);
		return call<DesktopSession>("session.select", { sessionId: session.id });
	})();
	const slow = await run(QA_DEMONSTRATIONS.slowShell.prompt);
	expect(slow.rows).toEqual(["bash"]);
	expect(slow.results.at(-1)).toContain("slow call finished");
	expect(slow.elapsed).toBeGreaterThanOrEqual(3500);
	const midway = await probe;
	expect(midway.status).toBe("running");
	// Two seconds in, the call has no result yet: its row is the live one, still running.
	expect(
		midway.messages
			.filter(message => message.role === "tool" && message.toolName === "bash")
			.map(row => row.tool?.status),
	).toEqual(["running"]);

	const edited = await run(QA_DEMONSTRATIONS.edit.prompt);
	expect(edited.rows).toEqual(["edit"]);
	expect(edited.results.at(-1)).toContain("Successfully replaced text");
	expect(await Bun.file(editTarget).text()).toBe(
		original.replace("status: draft\nreviewer: none", "status: reviewed\nreviewer: desktop-qa"),
	);
	// The edit result carries the diff that tool rows render; read it from the SDK transcript.
	const { transcriptFile } = await observeFixtureSession(
		layout,
		fixture.baseUrl,
		fixture.providerToken,
		session.id,
		child.pid,
	);
	const editDiffs = (await Bun.file(transcriptFile).text())
		.split("\n")
		.filter(Boolean)
		.map(line => JSON.parse(line) as { message?: { role?: string; toolName?: string; details?: { diff?: string } } })
		.flatMap(entry =>
			entry.message?.role === "toolResult" && entry.message.toolName === "edit" ? [entry.message.details?.diff] : [],
		);
	expect(editDiffs).toHaveLength(1);
	expect(editDiffs[0]).toContain("status: draft");
	expect(editDiffs[0]).toContain("status: reviewed");

	const undone = await run(QA_DEMONSTRATIONS.editUndo.prompt);
	expect(undone.rows).toEqual(["edit"]);
	expect(await Bun.file(editTarget).text()).toBe(original);

	const grouped = await run(QA_DEMONSTRATIONS.multiCall.prompt);
	expect(grouped.rows.toSorted()).toEqual(["find", "read", "search"]);
	// One response carried all three calls; the next completion received three results and closed the turn.
	expect(grouped.requests).toHaveLength(2);
	expect(grouped.requests[0]!.chunks.filter(chunk => chunk.includes('"tool_calls":[{')).length).toBe(3);
	expect(grouped.results.slice(-3)).toEqual(
		expect.arrayContaining([
			original,
			"definition.move\nprobe.move",
			expect.stringContaining("OWNED_DEFINITION_MARKER"),
		]),
	);
}, 90000);

test("QA driver fixture controls retain Origin/token/method and SSE-first admission fences", async () => {
	const child = Bun.spawn([process.execPath, path.resolve(import.meta.dir, "../scripts/host-ui-qa.ts")], {
		cwd: os.tmpdir(),
		env: { PATH: "/usr/bin:/bin", GJC_DESKTOP_QA_MODEL_FIXTURE: "1" },
		stdin: "pipe",
		stdout: "pipe",
		stderr: "pipe",
	});
	cleanups.push(() => stopChild(child));
	void (async () => {
		for await (const _chunk of child.stderr) {
			/* Drain the bounded test child pipe. */
		}
	})();
	const lines = readline.createInterface({ input: stream.Readable.from(child.stdout), crlfDelay: Infinity });
	const iterator = lines[Symbol.asyncIterator]();
	const line = await iterator.next();
	if (line.done) throw new Error("No QA bootstrap metadata");
	const metadata = JSON.parse(line.value) as {
		port: number;
		token: string;
		bootstrapUrl: string;
		mode: string;
		modelFixture: { artifactPath: string; dataDir: string };
	};
	expect(metadata.mode).toBe("test-only-model-fixture");
	const catalog = (await Bun.file(path.join(metadata.modelFixture.dataDir, "catalog.json")).json()) as {
		sessions: Array<{ id: string; file: string; scope?: string }>;
	};
	expect(catalog.sessions).toHaveLength(3);
	const sdkIds = new Set<string>();
	for (const session of catalog.sessions) {
		// Seeded conversations stay private; host-created ones live in the SDK store.
		const root =
			session.scope === "managed"
				? path.join(metadata.modelFixture.dataDir, "agent", "sessions")
				: path.join(metadata.modelFixture.dataDir, "sessions");
		const transcript = await Bun.file(path.join(root, session.file)).text();
		const header = JSON.parse(transcript.split("\n", 1)[0]!) as { type: string; version: number; id: string };
		expect(header).toMatchObject({ type: "session", version: 5 });
		expect(header.id).not.toBe(session.id);
		sdkIds.add(header.id);
	}
	expect(sdkIds.size).toBe(3);
	const base = `http://127.0.0.1:${metadata.port}`;
	const origin = "http://127.0.0.1:1420";
	const client = crypto.randomUUID();
	const route = (name: string) => `${base}${name}?token=${metadata.token}&client=${client}`;
	const post = (name: string, body: unknown) =>
		fetch(route(name), {
			method: "POST",
			headers: { Origin: origin, "Content-Type": "application/json" },
			body: JSON.stringify(body),
		});
	expect((await fetch(`${base}/fixture/status`, { method: "POST", headers: { Origin: origin } })).status).toBe(401);
	expect(
		(await fetch(route("/fixture/status"), { method: "POST", headers: { Origin: "http://example.invalid" } })).status,
	).toBe(403);
	expect((await post("/fixture/status", {})).status).toBe(409);
	expect((await post("/fixture/gate", { sessionId: crypto.randomUUID(), kind: "approval" })).status).toBe(409);
	const source = await (await fetch(metadata.bootstrapUrl)).text();
	expect(source).toContain(`if (location.origin !== "${origin}") return;`);
	expect(source).toContain("await connect()");
	expect(source).toContain("window.__qaFixture");
	const connection = new AbortController();
	const events = await fetch(route("/events"), { headers: { Origin: origin }, signal: connection.signal });
	const reader = events.body!.getReader();
	await reader.read();
	cleanups.push(async () => {
		connection.abort();
		await reader.cancel().catch(() => {});
	});
	expect((await fetch(route("/fixture/status"), { headers: { Origin: origin } })).status).toBe(405);
	expect((await post("/fixture/status", {})).status).toBe(200);
	expect((await post("/fixture/hold", { arbitrary: "target" })).status).toBe(400);
	expect((await post("/fixture/release", { requestId: 1 })).status).toBe(409);
	expect((await post("/fixture/gate", { sessionId: crypto.randomUUID(), kind: "approval" })).status).toBe(400);
	expect((await post("/fixture/gates", { sessionId: crypto.randomUUID(), provider: "external" })).status).toBe(400);
	expect(
		(await post("/request", { id: crypto.randomUUID(), method: "auth.login", params: { provider: "openai" } }))
			.status,
	).toBe(403);
	expect(
		(
			await post("/request", {
				id: crypto.randomUUID(),
				method: "auth.setKey",
				params: { provider: QA_PROVIDER, key: "not-the-fixture-key" },
			})
		).status,
	).toBe(403);
	expect(
		(await post("/request", { id: crypto.randomUUID(), method: "model.set", params: { modelId: "openai/external" } }))
			.status,
	).toBe(403);
	const status = (await (await post("/fixture/hold", {})).json()) as FixtureSnapshot;
	expect(status.holdNext).toBe(true);
	expect(status.requests).toEqual([]);
	expect(await Bun.file(metadata.modelFixture.artifactPath).json()).toEqual(status);
}, 60000);

test("gate fixture emits genuine public SDK gates without answering, ACKing or advancing their continuations", async () => {
	const { layout, fixture, call, frames, session } = await sdkHost();
	const controlUrl = await readFixtureGateControl(layout);
	const post = (route: string, body: unknown, token = fixture.providerToken) =>
		fetch(`${controlUrl}${route}`, {
			method: "POST",
			headers: { "Content-Type": "application/json", "X-Desktop-QA-Fixture": token },
			body: JSON.stringify(body),
		});
	expect((await post("/gate", { sessionId: session.id, kind: "approval" }, "wrong")).status).toBe(403);
	expect((await post("/gate", { sessionId: crypto.randomUUID(), kind: "approval" })).status).toBe(400);
	expect(
		(await post("/gate", { sessionId: session.id, kind: "approval", answer: { decision: "approve" } })).status,
	).toBe(400);
	expect((await post("/answer", { sessionId: session.id })).status).toBe(403);
	const before = frames.length;
	for (const kind of ["approval", "question", "execution"] as const) {
		const target =
			kind === "approval" ? session : await call<DesktopSession>("session.create", { projectId: session.projectId });
		const response = await post("/gate", { sessionId: target.id, kind });
		expect(response.status).toBe(200);
		const status = (await response.json()) as FixtureGateSnapshot;
		expect(status.continuations).toHaveLength(1);
		expect(status.continuations[0]).toMatchObject({ sessionId: target.id, kind, state: "pending", advanced: false });
		const update = await call<DesktopActivityUpdate>("activity.get", { sessionId: target.id });
		expect(update.sessionId).toBe(target.id);
		const gates = update.activity.sessionState?.gates;
		if (!gates?.available) throw new Error("Genuine session workflow gates unavailable");
		expect(gates.pending.map(gate => gate.kind)).toContain(kind);
		expect((await post("/gate", { sessionId: target.id, kind })).status).toBe(409);
		const stillPending = (await (await post("/gates", { sessionId: target.id })).json()) as FixtureGateSnapshot;
		expect(stillPending.continuations[0]).toMatchObject({ state: "pending", advanced: false });
	}
	await waitFor(() => frames.slice(before).some(frame => frame.type === "activity"), "real gate activity frames");
	expect(frames.slice(before).some(frame => frame.type === "gate")).toBe(false);
	expect(fixture.snapshot().requests).toEqual([]);
	const artifact = (await Bun.file(layout.gateArtifactPath).json()) as FixtureGateSnapshot;
	expect(artifact.continuations).toHaveLength(3);
	expect(artifact.continuations.every(entry => entry.state === "pending" && !entry.advanced)).toBe(true);
	// No fake presentation/retirement ACKs here. Parent browser QA must commit
	// actual App DOM surfaces and observe these real promises settle through it.
}, 90000);

test("real Host→transport→SDK frames files, serializes PNG images and settles held image follow-ups through cancel/delivery/abort", async () => {
	const { fixture, call, send, session } = await sdkHost();
	const sessionId = session.id;
	const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC";
	const image = { kind: "image", name: "fixture-pixel.png", mimeType: "image/png", data: png };
	const content = 'const greeting = "안녕";\r\n\treturn greeting;\n';
	const current = () => call<DesktopSession>("session.select", { sessionId });
	const expectImageMessage = (body: Record<string, unknown>, marker: string) => {
		expect(body.messages).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					role: "user",
					content: expect.arrayContaining([
						expect.objectContaining({ type: "text", text: expect.stringContaining(marker) }),
						expect.objectContaining({
							type: "image_url",
							image_url: expect.objectContaining({
								url: expect.stringMatching(/^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/]+=*$/),
							}),
						}),
					]),
				}),
			]),
		);
	};
	await call("model.set", { sessionId, modelId: `${QA_PROVIDER}/qa-discrete`, thinkingLevel: "high" });
	expect((await current()).imageInput).toEqual({ supported: true, blocked: false });
	const mixed = send("prompt", {
		sessionId,
		text: "mixed owned attachment turn",
		attachments: [{ kind: "text", name: 'review "draft".ts', text: content }, image],
	});
	await waitFor(() => fixture.snapshot().requests.length === 1, "real mixed attachment completion");
	const mixedBody = fixture.snapshot().requests[0]!.body;
	expect(mixedBody).toMatchObject({ model: "qa-discrete", reasoning_effort: "high" });
	expectImageMessage(
		mixedBody,
		`--- Attached UTF-8 file: ${JSON.stringify('review "draft".ts')} ---\n${content}\n--- End attached file ---`,
	);
	expect(fixture.release(1)).toBe(true);
	expect((await mixed).ok).toBe(true);

	await call("model.set", { sessionId, modelId: `${QA_PROVIDER}/qa-plain`, thinkingLevel: "off" });
	expect((await current()).imageInput).toEqual({ supported: false, blocked: false });
	const beforeRefusal = fixture.snapshot().requests.length;
	const refused = await send("prompt", { sessionId, text: "unsupported owned image", attachments: [image] });
	expect(refused.ok).toBe(false);
	if (refused.ok) throw new Error("Text-only model accepted image input");
	expect(refused.error).toContain("does not support image input");
	expect(fixture.snapshot().requests).toHaveLength(beforeRefusal);

	await call("model.set", { sessionId, modelId: `${QA_PROVIDER}/qa-discrete`, thinkingLevel: "max" });
	fixture.holdNext();
	const beforeQueue = fixture.snapshot().requests.length;
	const held = send("prompt", { sessionId, text: "held image queue owner" });
	await waitFor(() => fixture.snapshot().requests.length === beforeQueue + 1, "held image queue owner completion");
	const canceled = await call<{ queued: boolean; submissionId: string }>("prompt", {
		sessionId,
		text: "canceled image follow-up",
		attachments: [image],
		deliverAs: "followUp",
	});
	expect(canceled.queued).toBe(true);
	expect((await current()).queued).toEqual(
		expect.arrayContaining([
			expect.objectContaining({ id: canceled.submissionId, deliverAs: "followUp", cancelable: true }),
		]),
	);
	expect(await call<{ removed: boolean }>("queue.cancel", { sessionId, queueId: canceled.submissionId })).toEqual({
		removed: true,
	});
	expect((await current()).queued?.some(entry => entry.id === canceled.submissionId) ?? false).toBe(false);
	const delivered = await call<{ queued: boolean; submissionId: string }>("prompt", {
		sessionId,
		text: "delivered image follow-up",
		attachments: [image],
		deliverAs: "followUp",
	});
	expect(delivered.queued).toBe(true);
	expect(fixture.snapshot().requests).toHaveLength(beforeQueue + 1);
	expect(fixture.release(beforeQueue + 1)).toBe(true);
	expect((await held).ok).toBe(true);
	await waitFor(
		() =>
			fixture.snapshot().requests.length === beforeQueue + 2 &&
			fixture.snapshot().requests.at(-1)?.state === "completed",
		"real image follow-up completion",
	);
	expectImageMessage(fixture.snapshot().requests.at(-1)!.body, "delivered image follow-up");
	expect(JSON.stringify(fixture.snapshot().requests.map(entry => entry.body.messages))).not.toContain(
		"canceled image follow-up",
	);
	let afterDelivery = await current();
	const idleDeadline = Date.now() + 25000;
	while (
		afterDelivery.status === "running" ||
		afterDelivery.queued?.some(entry => entry.id === delivered.submissionId)
	) {
		if (Date.now() >= idleDeadline) throw new Error("Image follow-up SDK did not settle");
		await Bun.sleep(10);
		afterDelivery = await current();
	}
	expect(afterDelivery.queued?.some(entry => entry.id === delivered.submissionId) ?? false).toBe(false);

	fixture.holdNext();
	const beforeAbort = fixture.snapshot().requests.length;
	const aborted = send("prompt", { sessionId, text: "held abort image owner", attachments: [image] });
	await waitFor(() => fixture.snapshot().requests.length === beforeAbort + 1, "held abort image completion");
	expectImageMessage(fixture.snapshot().requests.at(-1)!.body, "held abort image owner");
	const abortQueue = await call<{ queued: boolean; submissionId: string }>("prompt", {
		sessionId,
		text: "aborted queued image follow-up",
		attachments: [image],
		deliverAs: "followUp",
	});
	expect(abortQueue.queued).toBe(true);
	expect((await current()).queued).toEqual(
		expect.arrayContaining([expect.objectContaining({ id: abortQueue.submissionId, deliverAs: "followUp" })]),
	);
	await call("abort", { sessionId });
	await aborted;
	await waitFor(() => fixture.snapshot().requests.at(-1)?.state === "aborted", "image SDK HTTP abort");
	expect((await current()).queued ?? []).toEqual([]);
	expect(fixture.snapshot().requests).toHaveLength(beforeAbort + 1);
	expect(fixture.snapshot().requests.at(-1)!.chunks).not.toContain("[DONE]");
	// Recovery is an observable real SDK run, not a claimed image lease/quota proof.
	await call("prompt", { sessionId, text: "image input after abort", attachments: [image] });
	expectImageMessage(fixture.snapshot().requests.at(-1)!.body, "image input after abort");
	expect(JSON.stringify(fixture.snapshot().requests.map(entry => entry.body.messages))).not.toContain(
		"aborted queued image follow-up",
	);
}, 90000);

test("real Host→SDK title request completes independently of the held main turn", async () => {
	const { fixture, layout, send, frames, session } = await sdkHost();
	const first = send("prompt", { sessionId: session.id, text: "investigate title request ownership" });
	await waitFor(
		() => fixture.snapshot().requests.length === 1 && fixture.snapshot().titleRequests.length === 1,
		"main and title HTTP requests",
	);
	await waitFor(
		() =>
			frames.some(
				frame =>
					frame.type === "session" &&
					frame.session.id === session.id &&
					frame.session.title === "Fixture Generated Session Title",
			),
		"SDK-generated title applied",
	);
	const snapshot = fixture.snapshot();
	expect(snapshot.requests).toHaveLength(1);
	expect(snapshot.requests[0]).toMatchObject({ id: 1, state: "held", held: true, released: false });
	expect(snapshot.titleRequests).toHaveLength(1);
	const title = snapshot.titleRequests[0]!;
	expect(title).toMatchObject({
		id: 1,
		method: "POST",
		path: "/v1/chat/completions",
		state: "completed",
		held: false,
		released: false,
		body: { stream: true, tool_choice: { type: "function", function: { name: "set_title" } } },
	});
	expect(JSON.stringify(title.body.messages)).toContain("investigate title request ownership");
	expect(JSON.stringify(title.body.tools)).toContain("set_title");
	expect(title.chunks.join("\n")).toContain("Fixture Generated Session Title");
	expect(title.chunks.at(-1)).toBe("[DONE]");
	await fixture.flush();
	const artifact = (await Bun.file(layout.artifactPath).json()) as FixtureSnapshot;
	expect(artifact.titleRequests).toEqual(snapshot.titleRequests);
	expect(artifact.requests).toEqual(snapshot.requests);
	expect(fixture.release(1)).toBe(true);
	expect((await first).ok).toBe(true);
	await waitFor(() => fixture.snapshot().requests[0]?.state === "completed", "main completion cleanup");
	expect(fixture.snapshot().requests).toHaveLength(1);
	expect(fixture.release(1)).toBe(false);
}, 90000);

test("real DesktopHost→transport→SDK serializes reasoning/model transitions and admits queue/steer/abort during held SSE", async () => {
	const { fixture, call, send, session } = await sdkHost();
	const sessionId = session.id;
	const models = await call<DesktopModel[]>("models.list", { sessionId });
	const discrete = models.find(model => model.id === `${QA_PROVIDER}/qa-discrete`)!;
	expect(discrete.thinking.options.map(option => option.value)).toEqual(["off", "low", "high", "max"]);
	await call("auth.setKey", { provider: QA_PROVIDER, key: QA_KEY });
	expect(await call<DesktopModel[]>("models.list", { sessionId })).toEqual(models);
	await call("thinking.set", { sessionId, level: "high" });
	const first = send("prompt", { sessionId, text: "first owned turn" });
	await waitFor(() => fixture.snapshot().requests.length === 1, "first SDK completion");
	expect(fixture.snapshot().requests[0]).toMatchObject({
		state: "held",
		body: { model: "qa-reasoning", reasoning_effort: "high", stream: true },
	});
	expect((await send("thinking.set", { sessionId, level: "low" })).ok).toBe(false);
	expect((await send("model.set", { sessionId, modelId: `${QA_PROVIDER}/qa-plain` })).ok).toBe(false);
	const followUp = await call<{ queued: true; submissionId: string }>("prompt", {
		sessionId,
		text: "canceled owned follow-up",
		deliverAs: "followUp",
	});
	expect(followUp.queued).toBe(true);
	expect(await call<{ removed: boolean }>("queue.cancel", { sessionId, queueId: followUp.submissionId })).toEqual({
		removed: true,
	});
	const steer = await call<{ queued: true }>("prompt", {
		sessionId,
		text: "owned steering input",
		deliverAs: "steer",
	});
	expect(steer.queued).toBe(true);
	expect(fixture.release(1)).toBe(true);
	expect((await first).ok).toBe(true);
	await waitFor(() => fixture.snapshot().requests.length >= 2, "SDK steering completion");
	expect(JSON.stringify(fixture.snapshot().requests[1]!.body.messages)).toContain("owned steering input");
	expect(JSON.stringify(fixture.snapshot().requests.map(record => record.body.messages))).not.toContain(
		"canceled owned follow-up",
	);
	// The reasoning menu offers concrete levels only, so the session's effort always comes from
	// an explicit selection. Re-applying the same level keeps the request shape stable.
	await call("thinking.set", { sessionId, level: "low" });
	await call("prompt", { sessionId, text: "explicitly low owned turn" });
	expect(fixture.snapshot().requests.at(-1)!.body).toMatchObject({ model: "qa-reasoning", reasoning_effort: "low" });

	await call("model.set", { sessionId, modelId: `${QA_PROVIDER}/qa-plain`, thinkingLevel: "off" });
	const plain = await call<DesktopSession>("session.select", { sessionId });
	expect(plain.thinking).toMatchObject({ available: false, level: "off" });
	await call("prompt", { sessionId, text: "plain owned turn" });
	const plainBody = fixture.snapshot().requests.at(-1)!.body;
	expect(plainBody.model).toBe("qa-plain");
	expect(plainBody).not.toHaveProperty("reasoning_effort");

	await call("model.set", { sessionId, modelId: `${QA_PROVIDER}/qa-discrete`, thinkingLevel: "max" });
	fixture.holdNext();
	const count = fixture.snapshot().requests.length;
	const aborted = send("prompt", { sessionId, text: "abort owned discrete turn" });
	await waitFor(() => fixture.snapshot().requests.length > count, "discrete SDK completion");
	expect(fixture.snapshot().requests.at(-1)!.body).toMatchObject({ model: "qa-discrete", reasoning_effort: "max" });
	await call("abort", { sessionId });
	await aborted;
	await waitFor(() => fixture.snapshot().requests.at(-1)?.state === "aborted", "SDK HTTP abort");
	expect(fixture.snapshot().requests.at(-1)!.chunks).not.toContain("[DONE]");
}, 90000);

test("real side chat keeps main execution independent, freezes context and retires across clear and delete", async () => {
	const { fixture, call, send, frames, session } = await sdkHost();
	const sessionId = session.id;
	const scope = { sessionId, sessionGeneration: session.controlGeneration };
	const main = send("prompt", { sessionId, text: "main-owned-held-question" });
	await waitFor(() => fixture.snapshot().requests.length === 1, "held main request");
	fixture.holdNext();
	const opened = await call<DesktopBtwConversation>("btw.open", {
		...scope,
		question: "side-only-cancelled-question",
	});
	expect(opened.turns[0]?.status).toBe("running");
	await waitFor(
		() => fixture.snapshot().requests.length === 2 && fixture.snapshot().requests[1]?.state === "held",
		"concurrent side request",
	);
	const cancelled = await call<DesktopBtwConversation>("btw.cancel", {
		...scope,
		conversationId: opened.conversationId,
		turnId: opened.turns[0]!.turnId,
	});
	expect(cancelled.turns[0]?.status).toBe("cancel_requested");
	await waitFor(() => fixture.snapshot().requests[1]?.state === "aborted", "side-only HTTP abort");
	await waitFor(
		() => frames.some(frame => frame.type === "btw" && frame.event.conversation?.turns[0]?.status === "cancelled"),
		"side cancellation event",
	);
	expect(fixture.snapshot().requests[0]?.state).toBe("held");
	expect((await call<DesktopSession>("session.select", { sessionId })).status).toBe("running");
	await call("btw.submit", {
		...scope,
		conversationId: opened.conversationId,
		question: "side-only-successful-follow-up",
	});
	await waitFor(
		() =>
			frames.some(frame => frame.type === "btw" && frame.event.conversation?.turns.at(-1)?.status === "completed"),
		"successful side follow-up",
	);
	expect(fixture.snapshot().requests).toHaveLength(3);
	expect(JSON.stringify(fixture.snapshot().requests[2]!.body.messages)).not.toContain("side-only-cancelled-question");
	expect(fixture.release(1)).toBe(true);
	expect((await main).ok).toBe(true);
	await call("prompt", { sessionId, text: "later-main-question" });
	expect(JSON.stringify(fixture.snapshot().requests[3]!.body.messages)).not.toContain("side-only-");
	expect(JSON.stringify((await call<DesktopSession>("session.select", { sessionId })).messages)).not.toContain(
		"side-only-",
	);
	await call("model.set", { sessionId, modelId: `${QA_PROVIDER}/qa-plain`, thinkingLevel: "off" });
	await call("btw.submit", {
		...scope,
		conversationId: opened.conversationId,
		question: "side-frozen-model-question",
	});
	await waitFor(
		() => fixture.snapshot().requests.length === 5 && fixture.snapshot().requests[4]?.state === "completed",
		"frozen side model request",
	);
	expect(fixture.snapshot().requests[4]!.body.model).toBe("qa-reasoning");
	expect(JSON.stringify(fixture.snapshot().requests[4]!.body.messages)).toContain("side-only-successful-follow-up");
	expect(JSON.stringify(fixture.snapshot().requests[4]!.body.messages)).not.toContain("later-main-question");
	await waitFor(
		() =>
			frames.some(
				frame =>
					frame.type === "btw" &&
					frame.event.conversation?.turns.at(-1)?.question === "side-frozen-model-question" &&
					frame.event.conversation.turns.at(-1)?.status === "completed",
			),
		"frozen model terminal event",
	);
	const privateFrames = JSON.stringify(frames.filter(frame => frame.type === "btw"));
	for (const secret of [
		QA_KEY,
		"credentialSessionId",
		"providerAffinitySessionId",
		"systemPrompt",
		"assistantMessage",
	])
		expect(privateFrames).not.toContain(secret);
	const stale = await send("btw.get", { sessionId, sessionGeneration: -1 });
	expect(stale.ok).toBe(false);
	fixture.holdNext();
	await call("btw.submit", { ...scope, conversationId: opened.conversationId, question: "side-retired-by-clear" });
	await waitFor(
		() => fixture.snapshot().requests.length === 6 && fixture.snapshot().requests[5]?.state === "held",
		"side clear owner",
	);
	await call("command.run", { sessionId, text: "/clear" });
	await waitFor(() => fixture.snapshot().requests[5]?.state === "aborted", "clear side HTTP cancellation");
	const cleared = await call<DesktopSession>("session.select", { sessionId });
	expect(cleared.controlGeneration).not.toBe(session.controlGeneration);
	const successor = { sessionId, sessionGeneration: cleared.controlGeneration };
	expect(await call("btw.get", successor)).toBeNull();
	expect(
		(await send("btw.submit", { ...scope, conversationId: opened.conversationId, question: "stale side callback" }))
			.ok,
	).toBe(false);
	fixture.holdNext();
	await call("btw.open", { ...successor, question: "side-retired-by-delete" });
	await waitFor(
		() => fixture.snapshot().requests.length === 7 && fixture.snapshot().requests[6]?.state === "held",
		"side delete owner",
	);
	await call("session.delete", { sessionId });
	await waitFor(() => fixture.snapshot().requests[6]?.state === "aborted", "delete side HTTP cancellation");
	expect((await send("btw.get", successor)).ok).toBe(false);
}, 90000);
