import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { PtyRunResult } from "@gajae-code/natives";
import { PtySession } from "@gajae-code/natives";
import { withTimeout } from "@gajae-code/utils";
import { SessionManager } from "../src/session/session-manager";

// Exercise real TUIs in PTYs against isolated HOME directories and local SSE model servers:
// both an explicit --session-dir and the default managed storage path.

const roots: string[] = [];
const retainedFailures = new Map<string, unknown>();
const live: Array<{ pty: PtySession; done: Promise<PtyRunResult> }> = [];

afterEach(async () => {
	const processes = live.splice(0);
	const fixtureRoots = roots.splice(0);
	const failedRoots = new Map(retainedFailures);
	retainedFailures.clear();
	const killErrors: unknown[] = [];
	for (const { pty } of processes) {
		try {
			pty.kill();
		} catch (error) {
			killErrors.push(error);
		}
	}
	try {
		const results = await withTimeout(
			Promise.allSettled(processes.map(process => process.done)),
			20_000,
			"PTY cleanup did not settle",
		);
		const failures: unknown[] = results.flatMap(result => (result.status === "rejected" ? [result.reason] : []));
		if (failures.length > 0) throw new AggregateError(failures, "PTY termination was not verified");
	} catch (error) {
		throw new AggregateError(
			[...failedRoots.values(), ...killErrors, error],
			`Retaining fixture roots because PTY cleanup is uncertain: ${fixtureRoots.join(", ")}`,
		);
	}
	for (const root of fixtureRoots) {
		if (!failedRoots.has(root)) await fs.rm(root, { recursive: true, force: true });
	}
});

const strip = (value: string) => value.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, "").replace(/\x1b\][^\x07]*\x07/g, "");

type FakeModelCompletion = { delta: object; finish: "tool_calls" | "stop" };
type FakeModelHandler = (request: Request) => Promise<FakeModelCompletion | Response>;

function startFakeModel(reply: string | FakeModelHandler) {
	const hits: string[] = [];
	const server = Bun.serve({
		port: 0,
		hostname: "127.0.0.1",
		async fetch(request) {
			const url = new URL(request.url);
			hits.push(`${request.method} ${url.pathname}`);
			if (!url.pathname.endsWith("/chat/completions")) {
				return new Response("{}", { headers: { "content-type": "application/json" } });
			}
			if (typeof reply === "string") await request.text();
			const completion =
				typeof reply === "string"
					? { delta: { role: "assistant", content: reply }, finish: "stop" }
					: await reply(request);
			if (completion instanceof Response) return completion;
			const chunk = (delta: object, finish: string | null) =>
				`data: ${JSON.stringify({
					id: "chunk",
					object: "chat.completion.chunk",
					created: 1,
					model: "fake-model",
					choices: [{ index: 0, delta, finish_reason: finish }],
				})}\n\n`;
			const body = `${chunk(completion.delta, null)}${chunk({}, completion.finish)}data: [DONE]\n\n`;
			return new Response(body, { headers: { "content-type": "text/event-stream" } });
		},
	});
	const port = server.port;
	if (port === undefined) throw new Error("fake model server did not bind a port");
	return { server, port, hits };
}

function startManagedFakeModel(readTarget: string) {
	type RequestBody = {
		messages?: { role?: string; content?: unknown }[];
		tools?: {
			type?: string;
			function?: { name?: string; parameters?: { required?: string[]; properties?: Record<string, unknown> } };
		}[];
	};
	const observed: { kind: string; roles: string[]; toolNames: string[] }[] = [];
	let toolRequested = false;
	let toolSupported = false;
	let discoveryRequested = false;
	const secondTurns = new Set<string>();
	const overlappingTurns = Promise.withResolvers<void>();
	const peerToolStarted = Promise.withResolvers<void>();
	const releasePeerTool = Promise.withResolvers<void>();
	const thirdTurnStarted = Promise.withResolvers<void>();
	const releaseThirdTurn = Promise.withResolvers<void>();
	let stopping = false;
	let barrierFailure: unknown;
	const model = startFakeModel(async request => {
		if (request.method === "GET") {
			peerToolStarted.resolve();
			try {
				await withTimeout(releasePeerTool.promise, 20_000, "A2 discovery must progress while B2 bash is active");
			} catch (error) {
				barrierFailure = error;
				return new Response("Peer tool barrier failed", { status: 400 });
			}
			return new Response("peer tool completed");
		}
		const body = (await request.json()) as RequestBody;
		const messages = body.messages ?? [];
		const last = messages.at(-1);
		const latestUser = messages.findLast(message => message.role === "user");
		const prompt = [
			"managed-A1",
			"managed-B1",
			"managed-A2",
			"managed-B2",
			"managed-survivor3",
			"managed-survivor4",
		].find(value => (JSON.stringify(latestUser?.content) ?? "").includes(`"${value}"`));
		const read = body.tools?.find(
			tool =>
				tool.type === "function" &&
				tool.function?.name === "read" &&
				tool.function.parameters?.properties?.path &&
				(tool.function.parameters.required ?? []).every(field => field === "path"),
		);
		if (prompt === "managed-A1" && read) toolSupported = true;
		const isToolResult = last?.role === "tool";
		if (isToolResult && prompt === "managed-A2") releasePeerTool.resolve();
		const kind = isToolResult ? "tool-result" : (prompt ?? "background");
		observed.push({
			kind,
			roles: messages.map(message => message.role ?? "?"),
			toolNames: (body.tools ?? []).map(tool => tool.function?.name ?? "?"),
		});
		const isSecondTurn = kind === "managed-A2" || kind === "managed-B2";
		if (isSecondTurn) {
			secondTurns.add(kind);
			if (secondTurns.size === 2) overlappingTurns.resolve();
		}
		if (kind === "managed-survivor3") thirdTurnStarted.resolve();
		const barrier =
			kind === "managed-survivor3"
				? releaseThirdTurn.promise
				: kind === "managed-A2"
					? Promise.all([overlappingTurns.promise, peerToolStarted.promise])
					: isSecondTurn
						? overlappingTurns.promise
						: undefined;
		if (barrier) {
			try {
				await withTimeout<unknown>(
					barrier,
					20_000,
					kind === "managed-survivor3"
						? "The closing peer must exit before the survivor receives its reply"
						: "Both TUIs must reach the provider before either second turn completes",
				);
			} catch (error) {
				barrierFailure = error;
				return Response.json({ error: { message: "Managed TUI barrier failed" } }, { status: 400 });
			}
		}
		if (stopping) return new Response(null, { status: 503 });
		let delta: object;
		let finish: "tool_calls" | "stop";
		if ((prompt === "managed-A1" && read && !toolRequested) || kind === "managed-B2") {
			const peerTool = kind === "managed-B2";
			if (!peerTool) toolRequested = true;
			delta = {
				role: "assistant",
				tool_calls: [
					{
						index: 0,
						id: peerTool ? "managed-peer-bash-call" : "managed-read-call",
						type: "function",
						function: peerTool
							? {
									name: "bash",
									arguments: JSON.stringify({
										command: `'${process.execPath.replaceAll("'", "'\\''")}' -e 'process.stdout.write(await (await fetch("http://127.0.0.1:${model.port}/v1/chat/completions")).text())'`,
									}),
								}
							: { name: "read", arguments: JSON.stringify({ path: readTarget }) },
					},
				],
			};
			finish = "tool_calls";
		} else if (kind === "managed-A2" && !discoveryRequested) {
			discoveryRequested = true;
			delta = {
				role: "assistant",
				tool_calls: [
					{
						index: 0,
						id: "managed-discovery-call",
						type: "function",
						function: {
							name: "search_tool_bm25",
							arguments: JSON.stringify({ query: "cron recurring schedule", limit: 1 }),
						},
					},
				],
			};
			finish = "tool_calls";
		} else {
			delta = {
				role: "assistant",
				content: prompt ? `${prompt}-reply` : "background-reply",
			};
			finish = "stop";
		}
		return { delta, finish };
	});
	return {
		server: model.server,
		port: model.port,
		observed,
		barrierFailure: () => barrierFailure,
		thirdTurnStarted: thirdTurnStarted.promise,
		releaseThirdTurn: () => releaseThirdTurn.resolve(),
		stop: async () => {
			stopping = true;
			overlappingTurns.resolve();
			peerToolStarted.resolve();
			releasePeerTool.resolve();
			releaseThirdTurn.resolve();
			await model.server.stop(true);
		},
		toolEvidence: () => ({ toolRequested, toolSupported }),
	};
}

type Tui = { pty: PtySession; done: Promise<PtyRunResult>; screen: () => string };

async function writeModelsConfig(agent: string, port: number, contextWindow = 8000) {
	await Bun.write(
		path.join(agent, "models.yml"),
		`providers:
  fake:
    baseUrl: http://127.0.0.1:${port}/v1
    apiKey: test-key
    api: openai-completions
    models:
      - id: fake-model
        name: Fake Model
        contextWindow: ${contextWindow}
        maxTokens: 1000
        input: [text]
        output: [text]
`,
	);
}

function startTui(options: {
	cli: string;
	cwd: string;
	root: string;
	agent: string;
	sessions?: string;
	noTitle?: boolean;
	extra?: string[];
}): Tui {
	// Explicit allowlist rather than the whole environment: the child must not inherit credentials
	// or an outer agent directory from the process running the suite.
	const env: Record<string, string> = {
		PATH: process.env.PATH ?? "/usr/bin:/bin",
		LANG: process.env.LANG ?? "en_US.UTF-8",
		TMPDIR: process.env.TMPDIR ?? "/tmp",
		HOME: options.root,
		TERM: "xterm-256color",
		GJC_CODING_AGENT_DIR: options.agent,
		GJC_AUTOMATION: "1",
		GJC_NOTIFY: "off",
	};
	const pty = new PtySession();
	let raw = "";
	const done = pty.start(
		{
			command: [
				process.execPath,
				options.cli,
				"--no-mcp",
				"--no-lsp",
				"--no-rules",
				...(options.noTitle === false ? [] : ["--no-title"]),
				"--model",
				"fake/fake-model",
				...(options.sessions ? ["--session-dir", options.sessions] : []),
				...(options.extra ?? []),
			].join(" "),
			shell: "bash",
			cwd: options.cwd,
			env,
			unsetEnv: Object.keys(process.env).filter(key => !(key in env)),
			cols: 120,
			rows: 36,
			timeoutMs: 120_000,
		},
		(_error, chunk) => {
			if (chunk) raw += chunk;
		},
	);
	live.push({ pty, done });
	return { pty, done, screen: () => strip(raw) };
}

async function waitFor(check: () => boolean | Promise<boolean>, timeoutMs: number, label: string) {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (await check()) return;
		await Bun.sleep(100);
	}
	throw new Error(`timed out waiting for ${label}`);
}

type TranscriptEntry = { type?: string; id?: string; parentId?: string | null };

async function sessionFiles(sessions: string): Promise<string[]> {
	const listed = (await fs.readdir(sessions, { recursive: true }).catch(() => [])) as string[];
	return listed.filter(entry => entry.endsWith(".jsonl"));
}

async function transcriptText(sessions: string): Promise<string | null> {
	const files = await sessionFiles(sessions);
	if (files.length !== 1) return null;
	return Bun.file(path.join(sessions, files[0]!)).text();
}

/** Reads the only transcript under the session dir, failing if a sibling file appeared. */
async function readSingleTranscript(sessions: string) {
	const raw = await transcriptText(sessions);
	expect(raw).not.toBeNull();
	const lines = raw!.split("\n").filter(line => line.trim().length > 0);
	const header = JSON.parse(lines[0]!) as { id?: string };
	const entries = lines.slice(1).map(line => JSON.parse(line) as TranscriptEntry);
	return { header, lines, entries };
}

/** Waits until the TUI has drawn its footer, which is not part of the spawned argv. */
const ready = (tui: Tui) => waitFor(() => /v\d+\.\d+\.\d+/.test(tui.screen()), 60_000, "TUI footer");

const committed = (sessions: string, needle: string) =>
	waitFor(async () => (await transcriptText(sessions))?.includes(needle) ?? false, 60_000, `entry ${needle}`);

/** Entries whose serialized form contains the prompt as a complete JSON string value. */
function promptEntries(entries: TranscriptEntry[], prompt: string) {
	const needle = `"${prompt}"`;
	return entries.filter(entry => entry.type === "message" && JSON.stringify(entry).includes(needle));
}

/** Ancestor chain of an entry, walking parentId to the root. */
function ancestors(entries: TranscriptEntry[], id: string): string[] {
	const chain: string[] = [];
	let cursor: string | undefined | null = id;
	while (typeof cursor === "string" && !chain.includes(cursor)) {
		chain.push(cursor);
		cursor = entries.find(entry => entry.id === cursor)?.parentId ?? null;
	}
	return chain;
}

function expectResolvableParents(entries: TranscriptEntry[]) {
	const ids = new Set(entries.flatMap(entry => (typeof entry.id === "string" ? [entry.id] : [])));
	for (const entry of entries) {
		if (typeof entry.parentId === "string") expect(ids.has(entry.parentId)).toBe(true);
	}
}

// The harness drives a real pty and relies on POSIX behaviour; Windows keeps its own suites.
describe.skipIf(process.platform === "win32")("two interactive TUIs on one session", () => {
	it.each(["creator", "resumed"] as const)("managed branches survive %s exit", async closingPeer => {
		const root = await fs.mkdtemp(path.join(import.meta.dirname, ".tmp-two-tui-managed-"));
		roots.push(root);
		const cwd = path.join(root, "workspace");
		const agent = path.join(root, "agent");
		await fs.mkdir(cwd, { recursive: true });
		await fs.mkdir(agent, { recursive: true });
		const sessions = SessionManager.getDefaultSessionDirReadOnly(cwd, agent);
		const cli = path.resolve(import.meta.dirname, "../src/cli.ts");
		const model = startManagedFakeModel(cli);
		const terminals: Tui[] = [];
		let failure: unknown;
		let shutdownFailure: unknown;
		try {
			await writeModelsConfig(agent, model.port, 200_000);
			const first = startTui({ cli, cwd, root, agent, noTitle: false });
			terminals.push(first);
			await ready(first);
			first.pty.write("managed-A1\r");
			await committed(sessions, "managed-A1-reply");
			const beforeSecond = await readSingleTranscript(sessions);
			const sessionId = beforeSecond.header.id!;
			expect(sessionId).toBeTruthy();
			const split = beforeSecond.entries.find(
				entry => entry.type === "message" && JSON.stringify(entry).includes('"managed-A1-reply"'),
			)?.id;
			if (!split) throw new Error("Completed A1 reply has no branch anchor");

			const second = startTui({ cli, cwd, root, agent, noTitle: false, extra: ["--resume", sessionId] });
			terminals.push(second);
			await ready(second);
			second.pty.write("managed-B1\r");
			await committed(sessions, "managed-B1-reply");
			first.pty.write("managed-A2\r");
			second.pty.write("managed-B2\r");
			await waitFor(
				async () => {
					const failure = model.barrierFailure();
					if (failure !== undefined) throw failure;
					const text = await transcriptText(sessions);
					return text?.includes("managed-A2-reply") === true && text.includes("managed-B2-reply");
				},
				60_000,
				"both completed overlapping turns",
			);

			const merged = await readSingleTranscript(sessions);
			expect(merged.header.id).toBe(sessionId);
			expect(await sessionFiles(sessions)).toHaveLength(1);
			expectResolvableParents(merged.entries);
			const ids = merged.entries.flatMap(entry => (typeof entry.id === "string" ? [entry.id] : []));
			expect(new Set(ids).size).toBe(ids.length);
			const idFor = (text: string) => {
				const matches = promptEntries(merged.entries, text);
				expect(matches).toHaveLength(1);
				return matches[0]!.id!;
			};
			const a1 = idFor("managed-A1");
			const b1 = idFor("managed-B1");
			const a2 = idFor("managed-A2");
			const b2 = idFor("managed-B2");
			for (const [promptId, reply] of [
				[a1, "managed-A1-reply"],
				[b1, "managed-B1-reply"],
				[a2, "managed-A2-reply"],
				[b2, "managed-B2-reply"],
			] as const) {
				expect(ancestors(merged.entries, idFor(reply))).toContain(promptId);
			}
			expect(ancestors(merged.entries, b1)).toContain(split);
			expect(ancestors(merged.entries, a2)).toContain(a1);
			expect(ancestors(merged.entries, a2)).not.toContain(b1);
			expect(ancestors(merged.entries, b2)).toContain(b1);
			expect(ancestors(merged.entries, b2)).not.toContain(a2);
			for (const promptId of [a2, b2]) {
				const prompt = merged.entries.find(entry => entry.id === promptId)!;
				expect(merged.entries.find(entry => entry.id === prompt.parentId)).toMatchObject({
					type: "custom",
					customType: "workflow-intent-diff",
				});
			}
			const { toolSupported, toolRequested } = model.toolEvidence();
			expect(toolSupported).toBe(true);
			expect(toolRequested).toBe(true);
			expect(
				merged.entries.some(
					entry => entry.type === "message" && JSON.stringify(entry).includes('"role":"toolResult"'),
				),
			).toBe(true);
			expect(model.observed.some(request => request.kind === "tool-result")).toBe(true);
			for (const id of ["managed-discovery-call", "managed-peer-bash-call"])
				expect(
					merged.entries.find(
						entry => entry.type === "message" && JSON.stringify(entry).includes(`"toolCallId":"${id}"`),
					),
				).toMatchObject({ message: { role: "toolResult", isError: false } });
			expect(
				model.observed.some(request => request.kind === "tool-result" && request.toolNames.includes("cron")),
			).toBe(true);
			// Background requests are recorded separately; eligibility varies with default settings.
			expect(model.observed.some(request => request.kind === "managed-A1")).toBe(true);
			expect(model.observed.some(request => request.kind === "managed-B2")).toBe(true);
			const survivor = closingPeer === "creator" ? second : first;
			const closer = closingPeer === "creator" ? first : second;
			survivor.pty.write("managed-survivor3\r");
			await withTimeout(model.thirdTurnStarted, 20_000, "Survivor must reach the provider while its peer is alive");
			expect(await transcriptText(sessions)).not.toContain("managed-survivor3-reply");
			closer.pty.write("/quit\r");
			expect(await withTimeout(closer.done, 20_000, "Closing peer did not exit cleanly")).toMatchObject({
				exitCode: 0,
				cancelled: false,
				timedOut: false,
			});
			expect(await transcriptText(sessions)).not.toContain("managed-survivor3-reply");
			model.releaseThirdTurn();
			await committed(sessions, "managed-survivor3-reply");
			survivor.pty.write("managed-survivor4\r");
			await committed(sessions, "managed-survivor4-reply");
			const continued = await readSingleTranscript(sessions);
			expect(continued.header.id).toBe(sessionId);
			expect(await sessionFiles(sessions)).toHaveLength(1);
			expectResolvableParents(continued.entries);
			const finalIds = continued.entries.flatMap(entry => (typeof entry.id === "string" ? [entry.id] : []));
			expect(new Set(finalIds).size).toBe(finalIds.length);
			for (const id of ids) expect(finalIds).toContain(id);
			const finalReply = promptEntries(continued.entries, "managed-survivor4-reply");
			expect(finalReply).toHaveLength(1);
			const continuedBranch = ancestors(continued.entries, finalReply[0]!.id!);
			expect(continuedBranch).toContain(closingPeer === "creator" ? b2 : a2);
			expect(continuedBranch).not.toContain(closingPeer === "creator" ? a2 : b2);
			if (closingPeer === "creator") expect(continuedBranch).toContain(b1);
			else expect(continuedBranch).not.toContain(b1);
			survivor.pty.write("/quit\r");
			expect(await withTimeout(survivor.done, 20_000, "Survivor did not exit cleanly")).toMatchObject({
				exitCode: 0,
				cancelled: false,
				timedOut: false,
			});
		} catch (error) {
			failure = new Error(
				`Managed TUI root: ${root}; requests: ${JSON.stringify(model.observed)}; tool: ${JSON.stringify(model.toolEvidence())}; screens: ${JSON.stringify(terminals.map(terminal => terminal.screen().slice(-12000)))}`,
				{
					cause: error,
				},
			);
		} finally {
			shutdownFailure = await withTimeout(model.stop(), 20_000, "Model server cleanup did not settle").then(
				() => undefined,
				error => error,
			);
		}
		if (shutdownFailure !== undefined)
			failure = new AggregateError(
				failure === undefined ? [shutdownFailure] : [failure, shutdownFailure],
				`Managed TUI cleanup failed; retained root: ${root}`,
			);
		if (failure !== undefined) {
			retainedFailures.set(root, failure);
			throw failure;
		}
	}, 240_000);

	it("appends to one transcript from both processes and keeps their branches separate", async () => {
		const root = await fs.mkdtemp(path.join(import.meta.dirname, ".tmp-two-tui-"));
		roots.push(root);
		const cwd = path.join(root, "workspace");
		const agent = path.join(root, "agent");
		const sessions = path.join(root, "sessions");
		for (const directory of [cwd, agent, sessions]) await fs.mkdir(directory, { recursive: true });

		const model = startFakeModel("first-reply");
		await writeModelsConfig(agent, model.port);
		// Resolved from the module, not the process cwd: this file must also run from the package
		// directory, which is what `bun run test:ts` and a local `bun test` do.
		const cli = path.resolve(import.meta.dirname, "../src/cli.ts");

		// A opens the session and completes a turn; it stays alive for the rest of the case.
		const first = startTui({ cli, cwd, root, agent, sessions });
		await ready(first);
		first.pty.write("prompt-from-A\r");
		await committed(sessions, "first-reply");
		const beforeSecond = await readSingleTranscript(sessions);
		const sessionId = beforeSecond.header.id;
		expect(typeof sessionId).toBe("string");
		// The reply is the leaf B will hydrate from; snapshotting only after it committed keeps the
		// expected split point from racing the turn's own persistence.
		const leafBeforeSecond = beforeSecond.entries.at(-1)!.id!;

		// B resumes the same session while A is still running, and completes its own turn.
		const second = startTui({ cli, cwd, root, agent, sessions, extra: ["--resume", sessionId!] });
		await ready(second);
		second.pty.write("prompt-from-B\r");
		await committed(sessions, "prompt-from-B");
		// A keeps its own cursor: a second turn from A after B committed is what makes that visible.
		first.pty.write("prompt-from-A2\r");
		await committed(sessions, "prompt-from-A2");

		const merged = await readSingleTranscript(sessions);
		expect(merged.header.id).toBe(sessionId);
		expect(merged.entries.length).toBeGreaterThan(beforeSecond.entries.length);
		expectResolvableParents(merged.entries);

		const fromB = promptEntries(merged.entries, "prompt-from-B");
		const fromA2 = promptEntries(merged.entries, "prompt-from-A2");
		expect(fromB).toHaveLength(1);
		expect(fromA2).toHaveLength(1);
		expect(fromB[0]!.id).not.toBe(fromA2[0]!.id);
		const branchOfB = ancestors(merged.entries, fromB[0]!.id!);
		const branchOfA = ancestors(merged.entries, fromA2[0]!.id!);
		// Neither prompt is on the other's chain, and their nearest common ancestor is exactly the
		// leaf A had committed before B opened the session: B did not move A, and A did not adopt
		// B's advance.
		expect(branchOfB).not.toContain(fromA2[0]!.id!);
		expect(branchOfA).not.toContain(fromB[0]!.id!);
		expect(branchOfB.find(id => branchOfA.includes(id))).toBe(leafBeforeSecond);

		second.pty.write("/quit\r");
		first.pty.write("/quit\r");
		await Promise.race([Promise.all([first.done, second.done]), Bun.sleep(20_000)]);
		model.server.stop(true);
	}, 180_000);

	it("lets a restarted TUI append after the first process is killed outright", async () => {
		const root = await fs.mkdtemp(path.join(import.meta.dirname, ".tmp-two-tui-crash-"));
		roots.push(root);
		const cwd = path.join(root, "workspace");
		const agent = path.join(root, "agent");
		const sessions = path.join(root, "sessions");
		for (const directory of [cwd, agent, sessions]) await fs.mkdir(directory, { recursive: true });

		const model = startFakeModel("reply-after-restart");
		await writeModelsConfig(agent, model.port);
		// Resolved from the module, not the process cwd: this file must also run from the package
		// directory, which is what `bun run test:ts` and a local `bun test` do.
		const cli = path.resolve(import.meta.dirname, "../src/cli.ts");

		const first = startTui({ cli, cwd, root, agent, sessions });
		await ready(first);
		first.pty.write("prompt-before-crash\r");
		await committed(sessions, "prompt-before-crash");
		const before = await readSingleTranscript(sessions);
		const sessionId = before.header.id!;

		// Kill the pinned PTY child itself: no quit, no graceful flush. `kill()` targets the exact
		// process tree the session started, and the run result reports the cancellation, so the
		// case proves the writer died rather than assuming it.
		first.pty.kill();
		const firstResult = await first.done;
		expect(firstResult.cancelled).toBe(true);

		const restarted = startTui({ cli, cwd, root, agent, sessions, extra: ["--resume", sessionId] });
		await ready(restarted);
		restarted.pty.write("prompt-after-crash\r");
		await committed(sessions, "prompt-after-crash");

		const after = await readSingleTranscript(sessions);
		expect(after.header.id).toBe(sessionId);
		expect(after.lines.length).toBeGreaterThan(before.lines.length);
		expect(after.lines.join("\n")).toContain("prompt-before-crash");
		expectResolvableParents(after.entries);

		restarted.pty.write("/quit\r");
		await Promise.race([restarted.done, Bun.sleep(20_000)]);
		model.server.stop(true);
	}, 180_000);

	it("appends to a transcript written by an older version without losing its turns", async () => {
		const root = await fs.mkdtemp(path.join(import.meta.dirname, ".tmp-two-tui-legacy-"));
		roots.push(root);
		const cwd = path.join(root, "workspace");
		const agent = path.join(root, "agent");
		const sessions = path.join(root, "sessions");
		for (const directory of [cwd, agent, sessions]) await fs.mkdir(directory, { recursive: true });

		// A history this build did not write: the checked-in legacy fixture, copied in under the
		// on-disk session name, so the TUI has to read and extend a pre-existing transcript.
		const fixture = await Bun.file(path.resolve(import.meta.dirname, "fixtures/before-compaction.jsonl")).text();
		const header = JSON.parse(fixture.split("\n")[0]!) as { id: string };
		const legacyName = `2025-12-09T00-53-29-825Z_${header.id}.jsonl`;
		await Bun.write(path.join(sessions, legacyName), fixture);
		const legacyLines = fixture.split("\n").filter(line => line.trim().length > 0);
		const roleCounts = (lines: string[]) => {
			const counts = new Map<string, number>();
			for (const line of lines.slice(1)) {
				const parsed = JSON.parse(line) as { type?: string; message?: { role?: string } };
				const key = `${parsed.type}:${parsed.message?.role ?? "-"}`;
				counts.set(key, (counts.get(key) ?? 0) + 1);
			}
			return counts;
		};
		const legacyCounts = roleCounts(legacyLines);

		const model = startFakeModel("reply-to-legacy");
		await writeModelsConfig(agent, model.port);
		// Resolved from the module, not the process cwd: this file must also run from the package
		// directory, which is what `bun run test:ts` and a local `bun test` do.
		const cli = path.resolve(import.meta.dirname, "../src/cli.ts");

		const tui = startTui({ cli, cwd, root, agent, sessions, extra: ["--resume", header.id] });
		await ready(tui);
		tui.pty.write("prompt-into-legacy\r");
		await waitFor(
			async () => (await Bun.file(path.join(sessions, legacyName)).text()).includes("prompt-into-legacy"),
			60_000,
			"append into the legacy transcript",
		);
		expect(model.hits).toContain("POST /v1/chat/completions");

		const after = (await Bun.file(path.join(sessions, legacyName)).text())
			.split("\n")
			.filter(line => line.trim().length > 0);
		// Migration restamps the header and can spill large payloads into the shared cold store, so
		// line identity is not the invariant and neither is raw payload text. What must hold is that
		// no recorded turn is lost: the per-role census of the older history is preserved exactly,
		// and anything the rewrite moved out of the file is accounted for by the spill notice
		// rather than dropped.
		expect((JSON.parse(after[0]!) as { id?: string }).id).toBe(header.id);
		const afterCounts = roleCounts(after);
		for (const [role, count] of legacyCounts) {
			// No role may shrink. The new turn's own records inflate some roles, and how a resumed
			// legacy session records the prompt is not what this case is pinning, so the guard is
			// loss, not equality - except for the payload-heavy tool results, which stay exact.
			const now = afterCounts.get(role) ?? 0;
			expect(`${role}:${now >= count}`).toBe(`${role}:true`);
			if (role === "message:toolResult") expect(now).toBe(count);
		}
		expect(after.join("\n")).toContain("[Compacted history content evicted to durable cold storage]");
		expect(after.length).toBeGreaterThan(legacyLines.length);
		expect(await sessionFiles(sessions)).toHaveLength(1);

		tui.pty.write("/quit\r");
		await Promise.race([tui.done, Bun.sleep(20_000)]);
		model.server.stop(true);
	}, 180_000);
	it("keeps both appends when two processes commit at the same time", async () => {
		const root = await fs.mkdtemp(path.join(import.meta.dirname, ".tmp-two-tui-race-"));
		roots.push(root);
		const cwd = path.join(root, "workspace");
		const agent = path.join(root, "agent");
		const sessions = path.join(root, "sessions");
		for (const directory of [cwd, agent, sessions]) await fs.mkdir(directory, { recursive: true });

		const model = startFakeModel("shared-reply");
		await writeModelsConfig(agent, model.port);
		const cli = path.resolve(import.meta.dirname, "../src/cli.ts");

		const first = startTui({ cli, cwd, root, agent, sessions });
		await ready(first);
		first.pty.write("open-the-session\r");
		await committed(sessions, "open-the-session");
		const opened = await readSingleTranscript(sessions);
		const sessionId = opened.header.id!;

		const second = startTui({ cli, cwd, root, agent, sessions, extra: ["--resume", sessionId] });
		await ready(second);
		// No await between the two writes: both processes commit without waiting for each other.
		first.pty.write("race-from-A\r");
		second.pty.write("race-from-B\r");

		await waitFor(
			async () => {
				const text = await transcriptText(sessions);
				return text?.includes("race-from-A") === true && text.includes("race-from-B");
			},
			90_000,
			"both simultaneous prompts",
		);

		const merged = await readSingleTranscript(sessions);
		expect(merged.header.id).toBe(sessionId);
		expect(promptEntries(merged.entries, "race-from-A")).toHaveLength(1);
		expect(promptEntries(merged.entries, "race-from-B")).toHaveLength(1);
		// A simultaneous commit must not lose, duplicate or orphan a record: ids stay unique and
		// every recorded parent still resolves.
		const ids = merged.entries.flatMap(entry => (typeof entry.id === "string" ? [entry.id] : []));
		expect(new Set(ids).size).toBe(ids.length);
		expectResolvableParents(merged.entries);
		expect(merged.entries.length).toBeGreaterThan(opened.entries.length);

		second.pty.write("/quit\r");
		first.pty.write("/quit\r");
		await Promise.race([Promise.all([first.done, second.done]), Bun.sleep(20_000)]);
		model.server.stop(true);
	}, 180_000);
});
