import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { PtyRunResult } from "@gajae-code/natives";
import { PtySession } from "@gajae-code/natives";
import {
	parseTranscript,
	promptEntries,
	type TranscriptEntry,
	type TranscriptObservation,
	transcriptObservationFailure,
} from "./fixtures/shared-session-transcript-observation-probe";

// Everything else in this series drove SessionManager directly, so nothing ran the writer a user
// actually runs. These cases start real TUIs in PTYs against an isolated HOME, an explicit
// --session-dir and a local SSE model server: offline and deterministic, but a real turn.

const roots: string[] = [];
const live: PtySession[] = [];

afterEach(async () => {
	for (const pty of live.splice(0)) {
		try {
			pty.kill();
		} catch {}
	}
	for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true });
});

const strip = (value: string) => value.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, "").replace(/\x1b\][^\x07]*\x07/g, "");

function startFakeModel(reply: string) {
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
			await request.text();
			const chunk = (delta: object, finish: string | null) =>
				`data: ${JSON.stringify({
					id: "chunk",
					object: "chat.completion.chunk",
					created: 1,
					model: "fake-model",
					choices: [{ index: 0, delta, finish_reason: finish }],
				})}\n\n`;
			const body = `${chunk({ role: "assistant", content: reply }, null) + chunk({}, "stop")}data: [DONE]\n\n`;
			return new Response(body, { headers: { "content-type": "text/event-stream" } });
		},
	});
	const port = server.port;
	if (port === undefined) throw new Error("fake model server did not bind a port");
	return { server, port, hits };
}

type Tui = { pty: PtySession; done: Promise<PtyRunResult>; screen: () => string };

async function writeModelsConfig(agent: string, port: number) {
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
        contextWindow: 8000
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
	sessions: string;
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
	live.push(pty);
	let raw = "";
	const done = pty.start(
		{
			command: [
				process.execPath,
				options.cli,
				"--no-mcp",
				"--no-lsp",
				"--no-rules",
				"--no-title",
				"--model",
				"fake/fake-model",
				"--session-dir",
				options.sessions,
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

async function sessionFiles(sessions: string): Promise<string[]> {
	const listed = (await fs.readdir(sessions, { recursive: true }).catch(() => [])) as string[];
	return listed.filter(entry => entry.endsWith(".jsonl"));
}

async function transcriptText(
	sessions: string,
	observe?: (buffer: Buffer, relativePath: string) => void,
): Promise<string | null> {
	const files = await sessionFiles(sessions);
	if (files.length !== 1) return null;
	if (!observe) return Bun.file(path.join(sessions, files[0]!)).text();
	const buffer = Buffer.from(await Bun.file(path.join(sessions, files[0]!)).arrayBuffer());
	observe(buffer, files[0]!);
	return buffer.toString("utf8");
}

/** Reads the only transcript under the session dir, failing if a sibling file appeared. */
async function readSingleTranscript(sessions: string, observe?: (buffer: Buffer, relativePath: string) => void) {
	const raw = await transcriptText(sessions, observe);
	expect(raw).not.toBeNull();
	return parseTranscript(raw!);
}

/** Waits until the TUI has drawn its footer, which is not part of the spawned argv. */
const ready = (tui: Tui) => waitFor(() => /v\d+\.\d+\.\d+/.test(tui.screen()), 60_000, "TUI footer");

const committed = (sessions: string, needle: string) =>
	waitFor(async () => (await transcriptText(sessions))?.includes(needle) ?? false, 60_000, `entry ${needle}`);

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

		const observations: TranscriptObservation[] = [];
		let sequence = 0;
		try {
			await waitFor(
				async () => {
					let candidate: TranscriptObservation | undefined;
					const text = await transcriptText(sessions, (buffer, relativePath) => {
						candidate = { phase: "wait-satisfied", sequence: ++sequence, relativePath, buffer };
					});
					const satisfied = text?.includes("race-from-A") === true && text.includes("race-from-B");
					if (satisfied && candidate) observations.push(candidate);
					return satisfied;
				},
				90_000,
				"both simultaneous prompts",
			);

			const merged = await readSingleTranscript(sessions, (buffer, relativePath) => {
				observations.push({ phase: "assertion", sequence: ++sequence, relativePath, buffer });
			});
			expect(merged.header.id).toBe(sessionId);
			expect(promptEntries(merged.entries, "race-from-A")).toHaveLength(1);
			expect(promptEntries(merged.entries, "race-from-B")).toHaveLength(1);
			// A simultaneous commit must not lose, duplicate or orphan a record: ids stay unique and
			// every recorded parent still resolves.
			const ids = merged.entries.flatMap(entry => (typeof entry.id === "string" ? [entry.id] : []));
			expect(new Set(ids).size).toBe(ids.length);
			expectResolvableParents(merged.entries);
			expect(merged.entries.length).toBeGreaterThan(opened.entries.length);
		} catch (error) {
			throw await transcriptObservationFailure(error, observations, ["race-from-A", "race-from-B"]);
		}

		second.pty.write("/quit\r");
		first.pty.write("/quit\r");
		await Promise.race([Promise.all([first.done, second.done]), Bun.sleep(20_000)]);
		model.server.stop(true);
	}, 180_000);
});
