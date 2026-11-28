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

/** A model that answers each prompt `<prompt>` with `<prompt>-reply`, and anything else with `background-reply`. */
function startEchoModel() {
	return startFakeModel(async request => {
		const body = (await request.json()) as { messages?: { role?: string; content?: unknown }[] };
		const latestUser = body.messages?.findLast(message => message.role === "user");
		const prompt = /"([a-z]+-[A-Za-z0-9]+)"/.exec(JSON.stringify(latestUser?.content) ?? "")?.[1];
		return { delta: { role: "assistant", content: prompt ? `${prompt}-reply` : "background-reply" }, finish: "stop" };
	});
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
	ownership?: "observe" | "enforce";
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
		// Two writers on one session exist only below the default `enforce`, which gives the second
		// TUI the held-session warning instead. Since single-owner step 10a both write on the legacy
		// route: a managed transcript's identity fence stops the one whose view is stale, while an
		// explicit `--session-dir` transcript has no such fence and takes both appends.
		GJC_SESSION_OWNERSHIP: options.ownership ?? "observe",
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

/**
 * Whether a message entry carrying `needle` is on disk. Raw text is not enough: the prompt's
 * workflow-intent record also quotes it and is published before the message itself.
 */
async function hasMessage(sessions: string, needle: string): Promise<boolean> {
	const raw = await transcriptText(sessions);
	if (!raw) return false;
	const entries = raw
		.split("\n")
		.slice(1)
		.flatMap(line => {
			try {
				return [JSON.parse(line) as TranscriptEntry];
			} catch {
				return [];
			}
		});
	return promptEntries(entries, needle).length > 0;
}

const committed = (sessions: string, needle: string) =>
	waitFor(() => hasMessage(sessions, needle), 60_000, `entry ${needle}`);

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
	/** A managed (default storage) session that `first` opened and answered `managed-A1` in. */
	async function managedSession(ownership: "observe" | "enforce") {
		const root = await fs.mkdtemp(path.join(import.meta.dirname, ".tmp-two-tui-managed-"));
		roots.push(root);
		const cwd = path.join(root, "workspace");
		const agent = path.join(root, "agent");
		await fs.mkdir(cwd, { recursive: true });
		await fs.mkdir(agent, { recursive: true });
		const sessions = SessionManager.getDefaultSessionDirReadOnly(cwd, agent);
		const cli = path.resolve(import.meta.dirname, "../src/cli.ts");
		const model = startEchoModel();
		await writeModelsConfig(agent, model.port);
		// Keep almost nothing recent so a manual /compact of this short session has work to do, with
		// automatic compaction off so no process rewrites the transcript behind the checks.
		await Bun.write(path.join(agent, "config.yml"), "compaction:\n  enabled: false\n  keepRecentTokens: 1\n");
		const first = startTui({ cli, cwd, root, agent, ownership });
		await ready(first);
		first.pty.write("managed-A1\r");
		await committed(sessions, "managed-A1-reply");
		const file = path.join(sessions, (await sessionFiles(sessions))[0]!);
		const sessionId = (await readSingleTranscript(sessions)).header.id!;
		const resume = () => startTui({ cli, cwd, root, agent, ownership, extra: ["--resume", sessionId] });
		return { sessions, model, first, file, sessionId, resume };
	}

	it("observe: the TUI whose view a peer changed stops saving with the identity-mismatch message; the transcript keeps both", async () => {
		const { sessions, model, first, sessionId, resume } = await managedSession("observe");
		try {
			// B loads the transcript after A's turn, so B's first write matches and lands.
			const second = resume();
			await ready(second);
			second.pty.write("managed-B1\r");
			await committed(sessions, "managed-B1-reply");
			// A's view predates B's turn: its next write is refused, and nothing of it reaches disk.
			const mark = first.screen().length;
			first.pty.write("managed-A2\r");
			await waitFor(
				() => first.screen().slice(mark).includes("Another process changed this session's transcript"),
				60_000,
				"the identity-mismatch message in A",
			);
			await Bun.sleep(1_000);
			const stopped = await readSingleTranscript(sessions);
			expect(stopped.header.id).toBe(sessionId);
			expect(promptEntries(stopped.entries, "managed-A1")).toHaveLength(1);
			expect(promptEntries(stopped.entries, "managed-B1")).toHaveLength(1);
			expect(promptEntries(stopped.entries, "managed-A2")).toHaveLength(0);
			expectResolvableParents(stopped.entries);
			// A full rewrite from the stopped TUI is refused as well and leaves the transcript as it is.
			const bytes = await transcriptText(sessions);
			const compactMark = first.screen().length;
			first.pty.write("/compact\r");
			await waitFor(
				() => /Compaction failed|Error:/.test(first.screen().slice(compactMark)),
				60_000,
				"the refused compaction in A",
			);
			await Bun.sleep(1_000);
			expect(first.screen().slice(compactMark)).not.toContain("Nothing to compact");
			expect(await transcriptText(sessions)).toBe(bytes);
			// B keeps writing the session.
			second.pty.write("managed-B2\r");
			await committed(sessions, "managed-B2-reply");
			expectResolvableParents((await readSingleTranscript(sessions)).entries);
		} finally {
			model.server.stop(true);
		}
	}, 180_000);

	it("enforce: a second TUI on a held session is warned, and Fork continues in a copy that leaves the original to its holder", async () => {
		const { sessions, model, first, file, resume } = await managedSession("enforce");
		try {
			const bytes = await Bun.file(file).text();
			const second = resume();
			await waitFor(() => second.screen().includes("Fork into a new session"), 60_000, "the held-session warning");
			second.pty.write("\r");
			await waitFor(async () => (await sessionFiles(sessions)).length === 2, 60_000, "the fork's transcript");
			await ready(second);
			second.pty.write("forked-B1\r");
			const forked = path.join(sessions, (await sessionFiles(sessions)).find(name => !file.endsWith(name))!);
			await waitFor(
				async () => (await Bun.file(forked).text()).includes('"forked-B1-reply"'),
				60_000,
				"the fork's turn",
			);
			expect(await Bun.file(file).text()).toBe(bytes);
			// The holder keeps writing its session.
			first.pty.write("managed-A2\r");
			await waitFor(async () => (await Bun.file(file).text()).includes('"managed-A2-reply"'), 60_000, "A's turn");
			expect(await Bun.file(forked).text()).not.toContain('"managed-A2"');
		} finally {
			model.server.stop(true);
		}
	}, 180_000);

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
			async () => (await hasMessage(sessions, "race-from-A")) && (await hasMessage(sessions, "race-from-B")),
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
