/**
 * Single-owner target model, end to end (session single-owner design §12 "Required test" and
 * §13.1 item 3): the process that runs turns holds the session claim, and remote clients attach
 * to its in-process SDK endpoint through the broker. They never open a second writer.
 *
 * Every process here is real: an interactive TUI in a PTY owns session S under ownership mode
 * `observe`; `gjc acp` runs `initialize`, `session/load` S and a prompt; `gjc sdk session send S
 * --wait` sends another; a broker `session.resume` of S must reuse the TUI's endpoint. `gjc session
 * owners --json` probes the claim with the same HOME, and the
 * per-process ownership counters are read from the stats database after every process exited
 * cleanly, because a process only reports them at exit.
 *
 * Isolation: every child gets one environment from `buildChildEnv` rooted at an owned temp
 * directory (HOME, TMPDIR, XDG dirs and the agent dir), plus stubbed `open`/`xdg-open`. The model
 * is a local SSE fixture, and the broker is a fixture lease this process owns, so no child
 * spawns a detached broker and `cleanupFixtureRoots` stops it.
 */
import { Database } from "bun:sqlite";
import { afterAll, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
	type Client,
	ClientSideConnection,
	ndJsonStream,
	type RequestPermissionRequest,
	type RequestPermissionResponse,
	type SessionNotification,
} from "@agentclientprotocol/sdk";
import type { PtyRunResult } from "@gajae-code/natives";
import { PtySession } from "@gajae-code/natives";
import { withTimeout } from "@gajae-code/utils";
import { startFixtureBrokerWithLeaseForTest } from "../src/sdk/broker/ensure";
import { SdkClient, type SdkRequestOptions } from "../src/sdk/client";
import { SessionManager } from "../src/session/session-manager";
import { buildChildEnv } from "./helpers/acp-child-env";
import {
	cleanupFixtureRoots,
	createFixtureRootCleanup,
	type FixtureRootCleanup,
	registerFixtureRuntime,
	withFixtureBrokerEnvironment,
} from "./helpers/fixture-broker-cleanup";

const cli = path.resolve(import.meta.dir, "../src/cli.ts");
const cleanupRoots: FixtureRootCleanup[] = [];
const servers: Array<{ stop(closeActiveConnections?: boolean): void }> = [];
/** Short-lived `gjc` commands still running; a failed test kills them before its root is removed. */
const cliChildren = new Set<Bun.Subprocess>();
const STDERR_CAP = 64 * 1024;

// Bun's default hook timeout (5 s) is shorter than closing a launched host and stopping the TUI,
// ACP and broker; a cut-short cleanup would orphan them, so the hook gets its own bound.
afterAll(async () => {
	try {
		await cleanupFixtureRoots(cleanupRoots);
	} finally {
		for (const server of servers.splice(0)) server.stop(true);
	}
}, 120_000);

async function killCliChildren(): Promise<void> {
	const children = [...cliChildren];
	for (const child of children) if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
	await withTimeout(
		Promise.all(children.map(child => child.exited)),
		5_000,
		"gjc commands did not exit after SIGKILL",
	);
}

const strip = (value: string) => value.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, "").replace(/\x1b\][^\x07]*\x07/g, "");

async function waitFor(check: () => boolean | Promise<boolean>, timeoutMs: number, label: string): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (await check()) return;
		await Bun.sleep(100);
	}
	throw new Error(`timed out waiting for ${label}`);
}

type ChatBody = { messages?: { role?: string; content?: unknown }[] };

/**
 * Replies `<prompt>-reply` to the latest `attach-*` user prompt. A prompt listed in `holds` is
 * answered only after the test releases it, so the test can probe ownership while that turn is
 * in flight and its client process is still alive.
 */
function startFakeModel(holds: readonly string[]) {
	const prompts: string[] = [];
	const gates = new Map(holds.map(prompt => [prompt, Promise.withResolvers<void>()]));
	const reached = new Map(holds.map(prompt => [prompt, Promise.withResolvers<void>()]));
	const server = Bun.serve({
		port: 0,
		hostname: "127.0.0.1",
		idleTimeout: 0,
		async fetch(request) {
			const url = new URL(request.url);
			if (!url.pathname.endsWith("/chat/completions"))
				return new Response("{}", { headers: { "content-type": "application/json" } });
			const body = (await request.json()) as ChatBody;
			const latestUser = body.messages?.findLast(message => message.role === "user");
			const prompt = /attach-[a-z]+-[a-z]+/.exec(JSON.stringify(latestUser?.content) ?? "")?.[0] ?? "background";
			prompts.push(prompt);
			const gate = gates.get(prompt);
			if (gate) {
				reached.get(prompt)?.resolve();
				try {
					await withTimeout(gate.promise, 60_000, `the test never released ${prompt}`);
				} catch {
					return new Response("held turn was never released", { status: 400 });
				}
			}
			const chunk = (delta: object, finish: string | null) =>
				`data: ${JSON.stringify({
					id: "chunk",
					object: "chat.completion.chunk",
					created: 1,
					model: "fake-model",
					choices: [{ index: 0, delta, finish_reason: finish }],
				})}\n\n`;
			const reply = { role: "assistant", content: `${prompt}-reply` };
			return new Response(`${chunk(reply, null)}${chunk({}, "stop")}data: [DONE]\n\n`, {
				headers: { "content-type": "text/event-stream" },
			});
		},
	});
	servers.push(server);
	if (server.port === undefined) throw new Error("fake model server did not bind a port");
	return {
		port: server.port,
		prompts,
		reached: (prompt: string) => reached.get(prompt)!.promise,
		release: (prompt: string) => gates.get(prompt)!.resolve(),
		releaseAll: () => {
			for (const gate of gates.values()) gate.resolve();
		},
	};
}

class RecordingClient implements Client {
	readonly updates: SessionNotification[] = [];
	async requestPermission(_params: RequestPermissionRequest): Promise<RequestPermissionResponse> {
		return { outcome: { outcome: "selected", optionId: "allow_once" } };
	}
	async sessionUpdate(params: SessionNotification): Promise<void> {
		this.updates.push(params);
	}
	assistantText(): string {
		let text = "";
		for (const { update } of this.updates)
			if (update.sessionUpdate === "agent_message_chunk" && update.content.type === "text")
				text += update.content.text;
		return text;
	}
}

type CliResult = { exitCode: number; stdout: string; stderr: string };

/** Runs one short-lived `gjc` command in the fixture environment; output is captured through files. */
async function runGjc(
	env: Record<string, string>,
	cwd: string,
	args: string[],
	timeoutMs = 60_000,
): Promise<CliResult> {
	const capture = await fs.mkdtemp(path.join(env.TMPDIR!, "gjc-cli-capture-"));
	const stdoutPath = path.join(capture, "stdout");
	const stderrPath = path.join(capture, "stderr");
	const child = Bun.spawn([process.execPath, cli, ...args], {
		cwd,
		env,
		stdin: "ignore",
		stdout: Bun.file(stdoutPath),
		stderr: Bun.file(stderrPath),
	});
	cliChildren.add(child);
	try {
		const exitCode = await withTimeout(child.exited, timeoutMs, `gjc ${args.join(" ")} did not exit`);
		return { exitCode, stdout: await Bun.file(stdoutPath).text(), stderr: await Bun.file(stderrPath).text() };
	} finally {
		if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
		await child.exited;
		cliChildren.delete(child);
		await fs.rm(capture, { recursive: true, force: true });
	}
}

type OwnerRow = { sessionId?: string; state?: string; holder?: { pid?: number; surface?: string } };

async function sessionOwners(env: Record<string, string>, cwd: string): Promise<OwnerRow[]> {
	const result = await runGjc(env, cwd, ["session", "owners", "--json"]);
	if (result.exitCode !== 0) throw new Error(`gjc session owners failed: ${result.stderr}${result.stdout}`);
	const report = JSON.parse(result.stdout) as { owners?: OwnerRow[] };
	return report.owners ?? [];
}

type TranscriptEntry = { type?: string; id?: string; parentId?: string | null };

async function transcriptFiles(sessions: string): Promise<string[]> {
	const listed = (await fs.readdir(sessions, { recursive: true }).catch(() => [])) as string[];
	return listed.filter(entry => entry.endsWith(".jsonl")).map(entry => path.join(sessions, entry));
}

async function readTranscript(file: string) {
	const lines = (await Bun.file(file).text()).split("\n").filter(line => line.trim().length > 0);
	const header = JSON.parse(lines[0]!) as { id?: string };
	const entries = lines.slice(1).flatMap(line => {
		try {
			return [JSON.parse(line) as TranscriptEntry];
		} catch {
			return [];
		}
	});
	return { header, entries };
}

/** Message entries whose serialized form holds `text` as a complete JSON string value. */
function messageEntries(entries: TranscriptEntry[], text: string): TranscriptEntry[] {
	const needle = `"${text}"`;
	return entries.filter(entry => entry.type === "message" && JSON.stringify(entry).includes(needle));
}

async function findFiles(root: string, name: string): Promise<string[]> {
	const listed = (await fs.readdir(root, { recursive: true }).catch(() => [])) as string[];
	return listed.filter(entry => path.basename(entry) === name).map(entry => path.join(root, entry));
}

type BrokerRow = { sessionId?: unknown; pid?: unknown; live?: unknown; endpointGeneration?: unknown };

/** One broker request over a fresh SDK client; returns the `result` payload, or the frame without one. */
async function brokerGlobal(
	discovery: { url: string; token: string },
	operation: string,
	input: Record<string, unknown>,
	options: SdkRequestOptions = {},
): Promise<Record<string, unknown>> {
	const client = await SdkClient.connect(discovery.url, discovery.token);
	try {
		const response = (await client.global(operation, input, options)) as Record<string, unknown>;
		return (response.result as Record<string, unknown> | undefined) ?? response;
	} finally {
		await client.close();
	}
}

/** Liveness only: signal 0 delivers nothing, so this never acts on a pid read from the broker index. */
function processAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "EPERM";
	}
}

/** A host the broker launched for S instead of reusing the TUI; only a failing run has one. */
type LaunchedHost = { pid: number; endpointGeneration?: unknown; endpointIncarnation?: unknown };

/**
 * Closes, through the broker, every host serving `sessionId` other than the owner, and waits for
 * each to exit. The fixture lease stops only the broker, so a launched `session-host-internal`
 * (and its stderr drainer) would otherwise outlive the test and write into the removed root.
 */
async function closeLaunchedHosts(
	discovery: { url: string; token: string },
	sessionId: string,
	ownerPid: number,
	known: readonly LaunchedHost[],
): Promise<void> {
	const hosts = new Map<number, LaunchedHost>();
	for (const host of known) if (host.pid !== ownerPid) hosts.set(host.pid, host);
	for (const row of await brokerRows(discovery))
		if (row.sessionId === sessionId && typeof row.pid === "number" && row.pid !== ownerPid && !hosts.has(row.pid))
			hosts.set(row.pid, { pid: row.pid });
	const failures: unknown[] = [];
	for (const host of hosts.values()) {
		const authority =
			typeof host.endpointGeneration === "number" && typeof host.endpointIncarnation === "string"
				? { endpointGeneration: host.endpointGeneration, endpointIncarnation: host.endpointIncarnation }
				: {};
		// While the owner's row is still unresolved the broker refuses the close as ambiguous; retry
		// until the broker has reaped it.
		let closeError: unknown;
		const deadline = Date.now() + 30_000;
		do {
			try {
				await brokerGlobal(
					discovery,
					"session.close",
					{ sessionId, ...authority },
					{ idempotencyKey: `owner-attach-close-${host.pid}-${Date.now()}` },
				);
				closeError = undefined;
			} catch (error) {
				closeError = error;
				await Bun.sleep(250);
			}
		} while (closeError !== undefined && processAlive(host.pid) && Date.now() < deadline);
		if (closeError !== undefined) failures.push(closeError);
		try {
			await waitFor(() => !processAlive(host.pid), 30_000, `launched host ${host.pid} to exit`);
		} catch (error) {
			failures.push(error);
		}
	}
	if (failures.length > 0)
		throw new AggregateError(
			failures,
			`A host launched for the session was not closed: ${failures.map(failure => (failure instanceof Error ? failure.message : String(failure))).join("; ")}`,
		);
}

/** The first page of the broker's `session.list`; the fixture never holds more than one session. */
async function brokerRows(discovery: { url: string; token: string }): Promise<BrokerRow[]> {
	const page = await brokerGlobal(discovery, "session.list", {});
	return Array.isArray(page.sessions) ? (page.sessions as BrokerRow[]) : [];
}

function subprocessInput(proc: Bun.Subprocess<"pipe", "pipe", "pipe">): WritableStream<Uint8Array> {
	return new WritableStream({
		write(chunk) {
			proc.stdin.write(chunk);
			proc.stdin.flush();
		},
		close() {
			proc.stdin.end();
		},
		abort() {
			proc.stdin.end();
		},
	});
}

// The harness drives a real PTY and POSIX process groups; Windows keeps its own suites.
describe.skipIf(process.platform === "win32")("remote clients attach to the TUI that owns the session", () => {
	it("ACP session/load and an SDK send run in the owner's transcript and never claim", async () => {
		const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "gjc-owner-attach-")));
		const env = buildChildEnv(root);
		const agentDir = env.GJC_CODING_AGENT_DIR!;
		const workspace = path.join(root, "workspace");
		const stubs = path.join(root, "stub-bin");
		for (const dir of [
			env.TMPDIR,
			env.XDG_DATA_HOME,
			env.XDG_CONFIG_HOME,
			env.XDG_STATE_HOME,
			env.XDG_CACHE_HOME,
			env.XDG_RUNTIME_DIR,
			agentDir,
			workspace,
			stubs,
		])
			await fs.mkdir(dir!, { recursive: true, mode: 0o700 });
		// No child may open a browser: `open`/`xdg-open` resolve to no-op stubs first on PATH.
		for (const name of ["open", "xdg-open"]) {
			await Bun.write(path.join(stubs, name), "#!/bin/sh\nexit 0\n");
			await fs.chmod(path.join(stubs, name), 0o755);
		}
		env.PATH = `${stubs}:${env.PATH}`;

		const TUI_PROMPT = "attach-tui-one";
		const ACP_PROMPT = "attach-acp-two";
		const SDK_PROMPT = "attach-sdk-three";
		const model = startFakeModel([ACP_PROMPT, SDK_PROMPT]);
		await Bun.write(
			path.join(agentDir, "models.yml"),
			`providers:
  fake:
    baseUrl: http://127.0.0.1:${model.port}/v1
    apiKey: test-key
    api: openai-completions
    models:
      - id: fake-model
        name: Fake Model
        contextWindow: 200000
        maxTokens: 1000
        input: [text]
        output: [text]
`,
		);
		// The operator's global config (ownership settings are global-only).
		await Bun.write(path.join(agentDir, "config.yml"), "session:\n  ownership:\n    mode: observe\n");

		const started = await withFixtureBrokerEnvironment(() =>
			startFixtureBrokerWithLeaseForTest({ agentDir, env }),
		).catch(async error => {
			await fs.rm(root, { recursive: true, force: true });
			throw error;
		});
		const cleanup = createFixtureRootCleanup(root, agentDir, started.lease);
		cleanupRoots.push(cleanup);
		// Shutdown runs in registration order: release held turns, then stop the TUI, ACP and any CLI
		// command, and only then close the broker lease and remove the root.
		registerFixtureRuntime(cleanup, {
			key: "fake-model",
			requiredOwner: "runtime",
			shutdown: async () => model.releaseAll(),
		});
		registerFixtureRuntime(cleanup, { key: "cli-commands", requiredOwner: "runtime", shutdown: killCliChildren });

		// --- The owner: a real interactive TUI in a PTY. `exec` keeps the printed pid the TUI's own.
		const tuiEnv: Record<string, string> = { ...env, TERM: "xterm-256color", GJC_AUTOMATION: "1", GJC_NOTIFY: "off" };
		const pty = new PtySession();
		let raw = "";
		const tuiDone: Promise<PtyRunResult> = pty.start(
			{
				command: `printf 'gjc-tui-pid=%s\\n' $$; exec '${process.execPath}' '${cli}' --no-mcp --no-lsp --no-rules --no-title --model fake/fake-model`,
				shell: "bash",
				cwd: workspace,
				env: tuiEnv,
				unsetEnv: Object.keys(process.env).filter(key => !(key in tuiEnv)),
				cols: 120,
				rows: 36,
				timeoutMs: 240_000,
			},
			(_error, chunk) => {
				if (chunk) raw += chunk;
			},
		);
		let tuiExited = false;
		void tuiDone.finally(() => {
			tuiExited = true;
		});
		registerFixtureRuntime(cleanup, {
			key: "tui",
			requiredOwner: "runtime-and-broker",
			shutdown: async () => {
				// Quit first, so the TUI retires its broker row and a launched host's close is not
				// refused as ambiguous; kill only if it does not exit.
				if (!tuiExited) {
					pty.write("/quit\r");
					await Promise.race([tuiDone.catch(() => undefined), Bun.sleep(10_000)]);
				}
				if (!tuiExited) pty.kill();
				await withTimeout(
					tuiDone.catch(() => undefined),
					20_000,
					"TUI PTY did not settle",
				);
			},
		});
		const screen = () => strip(raw);
		await waitFor(() => /v\d+\.\d+\.\d+/.test(screen()), 60_000, "TUI footer");
		const tuiPid = Number(/gjc-tui-pid=(\d+)/.exec(raw)?.[1]);
		expect(tuiPid).toBeGreaterThan(0);

		// The TUI's own first prompt creates S on disk.
		const sessions = SessionManager.getDefaultSessionDirReadOnly(workspace, agentDir);
		pty.write(`${TUI_PROMPT}\r`);
		let transcript = "";
		await waitFor(
			async () => {
				const files = await transcriptFiles(sessions);
				if (files.length !== 1) return false;
				transcript = files[0]!;
				return messageEntries((await readTranscript(transcript)).entries, `${TUI_PROMPT}-reply`).length > 0;
			},
			60_000,
			"the TUI's own turn on disk",
		);
		const sessionId = (await readTranscript(transcript)).header.id!;
		expect(sessionId).toBeTruthy();

		// Attach only once the owner's endpoint is live in the broker index with a positive generation.
		// The generation-0 startup window is a separate, known gap (design §13 H3).
		let ownerRow: BrokerRow | undefined;
		await waitFor(
			async () => {
				const rows = await brokerRows(started.discovery);
				ownerRow = rows.find(row => row.sessionId === sessionId);
				return ownerRow?.live === true && Number(ownerRow.endpointGeneration ?? 0) > 0;
			},
			60_000,
			"the TUI endpoint in the broker index",
		);
		expect(ownerRow?.pid).toBe(tuiPid);

		const onlyTheTuiHolds = (owners: OwnerRow[]) =>
			expect(
				owners.map(owner => ({
					sessionId: owner.sessionId,
					surface: owner.holder?.surface,
					pid: owner.holder?.pid,
				})),
			).toEqual([{ sessionId, surface: "terminal", pid: tuiPid }]);
		onlyTheTuiHolds(await sessionOwners(env, workspace));

		// A failing run can make the broker launch a host for S instead of reusing the TUI. Close any
		// such host through the broker before the lease stops the broker itself.
		const launchedHosts: LaunchedHost[] = [];
		registerFixtureRuntime(cleanup, {
			key: "launched-hosts",
			requiredOwner: "runtime-and-broker",
			shutdown: () => closeLaunchedHosts(started.discovery, sessionId, tuiPid, launchedHosts),
		});

		// --- ACP client: `gjc acp`, initialize, session/load S, one prompt.
		const acp = Bun.spawn([process.execPath, cli, "acp"], {
			cwd: workspace,
			env,
			stdin: "pipe",
			stdout: "pipe",
			stderr: "pipe",
		});
		let acpStderr = "";
		const acpStderrDrain = (async () => {
			const decoder = new TextDecoder();
			for await (const chunk of acp.stderr)
				acpStderr = `${acpStderr}${decoder.decode(chunk, { stream: true })}`.slice(-STDERR_CAP);
		})();
		registerFixtureRuntime(cleanup, {
			key: "acp",
			requiredOwner: "runtime-and-broker",
			shutdown: async () => {
				if (acp.exitCode !== null) return;
				try {
					acp.stdin.end();
				} catch {}
				const graceful = await Promise.race([acp.exited.then(() => true), Bun.sleep(5_000).then(() => false)]);
				if (!graceful) acp.kill("SIGKILL");
				await withTimeout(acp.exited, 5_000, "ACP did not exit after SIGKILL");
			},
			dispose: () => acpStderrDrain,
		});
		const acpClient = new RecordingClient();
		const connection = new ClientSideConnection(() => acpClient, ndJsonStream(subprocessInput(acp), acp.stdout));
		try {
			await withTimeout(
				connection.initialize({ protocolVersion: 1, clientCapabilities: {} }),
				60_000,
				"ACP initialize",
			);
			await withTimeout(
				connection.loadSession({ sessionId, cwd: workspace, mcpServers: [] }),
				60_000,
				"ACP session/load",
			);
			const prompt = connection.prompt({ sessionId, prompt: [{ type: "text", text: ACP_PROMPT }] });
			// The ACP turn is at the model, run by the TUI: the ACP process is alive and holds nothing.
			await withTimeout(model.reached(ACP_PROMPT), 60_000, "the ACP prompt at the model");
			expect(acp.exitCode).toBeNull();
			onlyTheTuiHolds(await sessionOwners(env, workspace));
			model.release(ACP_PROMPT);
			const response = await withTimeout(prompt, 60_000, "ACP session/prompt");
			expect(response.stopReason).toBe("end_turn");
			expect(acpClient.assistantText()).toContain(`${ACP_PROMPT}-reply`);
		} catch (error) {
			throw new Error(`${error instanceof Error ? error.message : String(error)}\n[acp stderr]\n${acpStderr}`);
		}
		acp.stdin.end();
		expect(await withTimeout(acp.exited, 20_000, "ACP did not exit after stdin closed")).toBe(0);

		// --- SDK client: `gjc sdk session send S --wait`.
		const sent = runGjc(
			env,
			workspace,
			["sdk", "session", "send", sessionId, "--text", SDK_PROMPT, "--wait", "--json"],
			90_000,
		);
		// Awaited below; this only keeps an early failure from also reporting an unhandled rejection.
		sent.catch(() => undefined);
		await withTimeout(model.reached(SDK_PROMPT), 60_000, "the SDK prompt at the model");
		onlyTheTuiHolds(await sessionOwners(env, workspace));
		model.release(SDK_PROMPT);
		const send = await sent;
		expect(send.exitCode).toBe(0);
		expect(JSON.parse(send.stdout)).toMatchObject({ ok: true, result: { status: "terminal_ok" } });

		// --- Broker `session.resume` of S, as Telegram, Hermes and Mobile call it: it reuses the
		// owner's live endpoint instead of launching a host.
		const resumed = await brokerGlobal(
			started.discovery,
			"session.resume",
			// The input shape ACP's resume uses: the saved transcript and the target workspace.
			{ sessionId, cwd: workspace, sessionPath: transcript, target: { path: workspace } },
			{ idempotencyKey: `owner-attach-resume-${sessionId}` },
		);
		if (typeof resumed.pid === "number" && resumed.pid !== tuiPid)
			launchedHosts.push({
				pid: resumed.pid,
				endpointGeneration: resumed.endpointGeneration,
				endpointIncarnation: resumed.endpointIncarnation,
			});
		expect(resumed).toMatchObject({ sessionId, reused: true, pid: tuiPid });

		// Both remote prompts ran in the owner's transcript: one file, header S, each exactly once.
		expect(await transcriptFiles(sessions)).toEqual([transcript]);
		const merged = await readTranscript(transcript);
		expect(merged.header.id).toBe(sessionId);
		for (const text of [TUI_PROMPT, ACP_PROMPT, SDK_PROMPT]) {
			expect(messageEntries(merged.entries, text)).toHaveLength(1);
			expect(messageEntries(merged.entries, `${text}-reply`)).toHaveLength(1);
		}
		// The three attach prompts reached the model in order; other requests (none today) are ignored.
		const order = [TUI_PROMPT, ACP_PROMPT, SDK_PROMPT].map(prompt => model.prompts.indexOf(prompt));
		expect(order.every(index => index >= 0)).toBe(true);
		expect([...order].sort((a, b) => a - b)).toEqual(order);
		// No host was launched for S, by ACP, the SDK send or the resume: the broker still routes it
		// to the TUI alone.
		expect(
			(await brokerRows(started.discovery)).filter(row => row.sessionId === sessionId).map(row => row.pid),
		).toEqual([tuiPid]);
		// The claim is still the TUI's.
		onlyTheTuiHolds(await sessionOwners(env, workspace));

		// --- The owner quits: nothing is held.
		pty.write("/quit\r");
		expect(await withTimeout(tuiDone, 30_000, "TUI did not exit after /quit")).toMatchObject({ exitCode: 0 });
		expect(await sessionOwners(env, workspace)).toEqual([]);

		// Counters every exited process reported: every claim taken was released and none was
		// contended. A process reports only at a clean exit, so a client whose exit-time write is
		// dropped is invisible here; the owners probes above are the signal that does not depend on it.
		const statsDbs = await findFiles(root, "stats.db");
		expect(statsDbs).toHaveLength(1);
		const db = new Database(statsDbs[0]!, { readonly: true });
		try {
			const rows = db.prepare("SELECT name, count FROM session_ownership_events").all() as {
				name: string;
				count: number;
			}[];
			const total = (name: string) => rows.filter(row => row.name === name).reduce((sum, row) => sum + row.count, 0);
			expect(total("claim_conflict")).toBe(0);
			expect(total("held_at_exit")).toBe(0);
			expect(total("claim_failed")).toBe(0);
			expect(total("claim_taken")).toBeGreaterThanOrEqual(1);
			expect(total("claim_released")).toBe(total("claim_taken"));
		} finally {
			db.close();
		}
	}, 300_000);
});
