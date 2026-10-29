import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import * as readline from "node:readline";
import * as stream from "node:stream";
import type { DesktopBtwConversation } from "../../desktop-host/src/btw-protocol";
import type {
	DesktopActivityUpdate,
	DesktopFrame,
	DesktopMethod,
	DesktopModel,
	DesktopProject,
	DesktopSession,
} from "../../desktop-host/src/protocol";
import {
	assertFixtureEndpoint,
	assertFixtureMode,
	type FixtureGateSnapshot,
	type FixtureSnapshot,
	fixtureEnvironment,
	fixtureFetch,
	fixtureLayout,
	QA_KEY,
	QA_PROVIDER,
	readFixtureGateControl,
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

async function ownedFixture() {
	const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "gjc-host-ui-qa-")));
	const layout = fixtureLayout(root);
	const fixture = startModelFixture(layout.artifactPath);
	cleanups.push(async () => {
		try {
			await fixture.close();
		} finally {
			await fs.rm(root, { recursive: true, force: true });
		}
	});
	await seedFixture(layout, fixture.baseUrl, fixture.providerToken);
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

async function sdkHost() {
	const owned = await ownedFixture();
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
	await call("bootstrap");
	const project = await call<DesktopProject>("project.open", { path: owned.layout.project });
	const session = await call<DesktopSession>("session.create", { projectId: project.id });
	return { ...owned, child, send, call, frames, session };
}

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
	});
});

describe("deterministic loopback SSE", () => {
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
		sessions: Array<{ id: string; file: string }>;
	};
	expect(catalog.sessions).toHaveLength(3);
	const sdkIds = new Set<string>();
	for (const session of catalog.sessions) {
		const transcript = await Bun.file(path.join(metadata.modelFixture.dataDir, "sessions", session.file)).text();
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
	await call("thinking.set", { sessionId, level: "inherit" });
	await call("prompt", { sessionId, text: "inherited owned turn" });
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
