// Manual packaged-runtime proof; external Bun orchestrates only.
// Usage: bun packages/desktop/scripts/standalone-qa.ts /absolute/path/Gajae\ Code.app
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import * as util from "node:util";
import type { DesktopActivityDetail, DesktopActivityJob } from "@gajae-code/desktop-host/activity-protocol";
import type { DesktopOperatorOperation } from "@gajae-code/desktop-host/operator-protocol";
import type {
	DesktopActivityUpdate,
	DesktopForkResult,
	DesktopFrame,
	DesktopHistory,
	DesktopMessage,
	DesktopProject,
	DesktopRequest,
	DesktopSession,
	DesktopSnapshot,
} from "@gajae-code/desktop-host/protocol";
import { childDiagnostics } from "./child-diagnostics";
import {
	FIXTURE_IMAGE,
	FIXTURE_MODEL,
	type FixtureTurn,
	QUESTION_ANSWER,
	QUESTION_PROMPT,
	QUESTION_TITLE,
	type StandaloneFixture,
	seedStandaloneFixture,
	startStandaloneFixture,
} from "./standalone-fixture";

function assert(condition: unknown, message: string): asserts condition {
	if (!condition) throw new Error(message);
}
async function bounded<T>(operation: Promise<T>, timeoutMs: number, label: string): Promise<T> {
	const deadline = Promise.withResolvers<T>();
	const timer = setTimeout(() => deadline.reject(new Error(`${label} timed out`)), timeoutMs);
	try {
		return await Promise.race([operation, deadline.promise]);
	} finally {
		clearTimeout(timer);
	}
}
async function waitFor<T>(read: () => Promise<T | undefined>, label: string, timeoutMs = 30_000): Promise<T> {
	const end = Date.now() + timeoutMs;
	do {
		const value = await read();
		if (value !== undefined) return value;
		await Bun.sleep(50);
	} while (Date.now() < end);
	throw new Error(`${label} timed out`);
}
function errorEvidence(error: unknown): unknown {
	if (!(error instanceof Error)) return String(error);
	return {
		name: error.name,
		message: error.message,
		...(error instanceof AggregateError ? { errors: error.errors.map(errorEvidence) } : {}),
	};
}
async function cancelTurn(
	host: StandaloneHost,
	sessionId: string,
	turn: Promise<unknown>,
	error: unknown,
): Promise<never> {
	const settled = await Promise.allSettled([
		host.request("abort", { sessionId }),
		bounded(turn, 6500, "Failed prompt settlement"),
	]);
	throw new AggregateError(
		[error, ...settled.flatMap(item => (item.status === "rejected" ? [item.reason] : []))],
		"Prompt scenario failed; cancellation/settlement evidence retained",
	);
}
const cleanupWarning = /\[postmortem\] cleanup deadline|Cleanup callback failed|Cleanup invoked recursively/;
function diagnostics(stream: ReadableStream<Uint8Array>) {
	// Retain warning evidence even if ordinary diagnostics later displace the tail.
	let scan = "";
	const warnings = new Set<string>();
	const decoder = new TextDecoder();
	const eof = Promise.withResolvers<void>();
	const watched = stream.pipeThrough(
		new TransformStream<Uint8Array, Uint8Array>({
			transform(chunk, controller) {
				scan += decoder.decode(chunk, { stream: true });
				for (const line of scan.split("\n")) if (cleanupWarning.test(line)) warnings.add(line);
				scan = scan.slice(-4096);
				controller.enqueue(chunk);
			},
			flush() {
				eof.resolve();
			},
		}),
	);
	const drain = childDiagnostics(watched);
	return {
		async wait(timeoutMs: number) {
			// A retained descendant pipe is not proof that final diagnostics drained.
			// Still cancel/reap the bounded tail reader on this failure path.
			let failure: unknown;
			try {
				await bounded(eof.promise, timeoutMs, "Child diagnostic EOF");
			} catch (error) {
				failure = error;
			}
			const tail = await drain.wait(timeoutMs);
			const text = [...warnings, tail].filter(Boolean).join("\n");
			if (failure) throw new Error(`Child diagnostic EOF was not observed: ${text}`, { cause: failure });
			return text;
		},
	};
}
async function stop(child: Bun.Subprocess): Promise<void> {
	if (child.exitCode !== null) return;
	child.kill("SIGTERM");
	try {
		await bounded(child.exited, 6500, "SIGTERM shutdown");
	} catch {
		if (child.exitCode === null) child.kill("SIGKILL");
		await bounded(child.exited, 2000, "SIGKILL reap");
	}
}

/** Shared by the functional run and verifier-only shutdown fault tests. */
export class StandaloneHost {
	readonly child: Bun.Subprocess<"pipe", "pipe", "pipe">;
	readonly sessions = new Map<string, DesktopSession>();
	readonly pending = new Map<string, PromiseWithResolvers<unknown>>();
	readonly stderr: { wait(timeoutMs: number): Promise<string> };
	readonly frames: Promise<void>;
	#nextId = 0;
	#failure: Error | undefined;
	#shutdownExpected = false;
	#closed = false;
	constructor(directory: string, project: string, environment: Record<string, string>) {
		this.child = Bun.spawn([path.join(directory, "gjc-desktop-host")], {
			cwd: project,
			env: { ...environment, PATH: `${directory}:${environment.PATH}` },
			stdin: "pipe",
			stdout: "pipe",
			stderr: "pipe",
		});
		this.stderr = diagnostics(this.child.stderr);
		this.frames = this.#readFrames();
	}
	async #readFrames(): Promise<void> {
		const reader = this.child.stdout.getReader();
		const decoder = new TextDecoder();
		let buffer = "";
		try {
			while (true) {
				const { value, done } = await reader.read();
				if (done) break;
				buffer += decoder.decode(value, { stream: true });
				let newline = buffer.indexOf("\n");
				while (newline >= 0) {
					assert(newline <= 8 * 1024 * 1024, "Host frame exceeded QA budget");
					const frame = JSON.parse(buffer.slice(0, newline)) as DesktopFrame;
					buffer = buffer.slice(newline + 1);
					newline = buffer.indexOf("\n");
					if (frame.type === "fatal") throw new Error(frame.error);
					if (frame.type === "session") this.sessions.set(frame.session.id, frame.session);
					if (frame.type === "snapshot")
						for (const session of frame.snapshot.sessions) this.sessions.set(session.id, session);
					if (frame.type !== "response") continue;
					const result = this.pending.get(frame.id);
					if (frame.ok) result?.resolve(frame.result);
					else result?.reject(new Error(frame.error));
				}
				assert(buffer.length <= 8 * 1024 * 1024, "Host frame exceeded QA budget");
			}
			buffer += decoder.decode();
			assert(!buffer.trim(), "Host ended with an incomplete frame");
			assert(this.#shutdownExpected, "Host frame stream closed before shutdown");
		} catch (error) {
			this.#failure = error instanceof Error ? error : new Error(String(error));
			for (const result of this.pending.values()) result.reject(this.#failure);
		} finally {
			reader.releaseLock();
		}
	}
	async request<T>(method: DesktopRequest["method"], params: Record<string, unknown> = {}): Promise<T> {
		if (this.#failure) throw this.#failure;
		assert(this.child.exitCode === null, "Host is not running");
		const id = `standalone-${++this.#nextId}`;
		const result = Promise.withResolvers<unknown>();
		this.pending.set(id, result);
		try {
			this.child.stdin.write(`${JSON.stringify({ id, method, params } satisfies DesktopRequest)}\n`);
			const [, response] = await bounded(
				Promise.all([
					bounded(Promise.resolve(this.child.stdin.flush()), 5000, "Host request flush"),
					result.promise,
				]),
				60_000,
				`Host ${method}`,
			);
			return response as T;
		} finally {
			this.pending.delete(id);
		}
	}
	async shutdown(): Promise<{ hostExitCode: number; hostDiagnostics: string }> {
		this.#shutdownExpected = true;
		await this.request("shutdown");
		await bounded(Promise.resolve(this.child.stdin.end()), 5000, "Host input shutdown");
		const code = await bounded(this.child.exited, 10_000, "Host shutdown exit");
		await bounded(this.frames, 5000, "Host final frame drain");
		if (this.#failure) throw this.#failure;
		const text = await this.stderr.wait(1000);
		assert(code === 0, `Host shutdown failed (${code}): ${text}`);
		assert(!cleanupWarning.test(text), `Host cleanup diagnostics: ${text}`);
		this.#closed = true;
		return { hostExitCode: code, hostDiagnostics: text };
	}
	async dispose(): Promise<void> {
		const failures: unknown[] = [];
		try {
			await stop(this.child);
		} catch (error) {
			failures.push(error);
		}
		try {
			await bounded(this.frames, 5000, "Host cleanup final frame drain");
		} catch (error) {
			failures.push(error);
		}
		if (!this.#closed && this.#failure) failures.push(this.#failure);
		let text: string | undefined;
		try {
			text = await this.stderr.wait(1000);
			if (cleanupWarning.test(text)) failures.push(new Error(`Host cleanup diagnostics: ${text}`));
		} catch (error) {
			failures.push(error);
		}
		if (failures.length) {
			const evidence = {
				hostExitCode: this.child.exitCode,
				hostSignalCode: this.child.signalCode,
				hostDiagnostics: text,
			};
			failures.push(new Error(`Host process evidence: ${JSON.stringify(evidence)}`));
			throw new AggregateError(failures, "Host disposal failed; process evidence retained");
		}
	}
}

async function bundledCli(
	directory: string,
	project: string,
	environment: Record<string, string>,
	args: string[],
	binary = "gjc",
) {
	const child = Bun.spawn([path.join(directory, binary), ...args], {
		cwd: project,
		env: environment,
		stdin: "ignore",
		stdout: "pipe",
		stderr: "pipe",
	});
	const output = diagnostics(child.stdout);
	const errors = diagnostics(child.stderr);
	const failures: unknown[] = [];
	let text = "";
	try {
		const code = await bounded(child.exited, 90_000, `Bundled ${binary} ${args.join(" ")}`);
		const [stdout, stderr] = await Promise.all([output.wait(1000), errors.wait(1000)]);
		text = stdout.trim();
		assert(code === 0, `Bundled ${binary} ${args.join(" ")} failed (${code}): ${stderr}`);
		assert(!cleanupWarning.test(stderr), `Host cleanup diagnostics: ${stderr}`);
	} catch (error) {
		failures.push(error);
	}
	try {
		await stop(child);
	} catch (error) {
		failures.push(error);
	}
	const drained = await Promise.allSettled([output.wait(1000), errors.wait(1000)]);
	for (const item of drained) {
		if (item.status === "rejected") failures.push(item.reason);
		else if (cleanupWarning.test(item.value)) failures.push(new Error(`Host cleanup diagnostics: ${item.value}`));
	}
	if (failures.length) throw new AggregateError(failures, `Bundled ${binary} ${args.join(" ")} failed`);
	return text;
}
async function operation(host: StandaloneHost, sessionId: string, text: string): Promise<DesktopOperatorOperation> {
	let value = await host.request<DesktopOperatorOperation>("operator.execute", { sessionId, text });
	return waitFor(async () => {
		if (value.status !== "running" && value.status !== "cancel_requested") return value;
		value = await host.request("operator.get", { sessionId, operationId: value.operationId });
		return undefined;
	}, "Operator settlement");
}
async function history(host: StandaloneHost, sessionId: string): Promise<DesktopMessage[]> {
	const messages: DesktopMessage[] = [];
	let total = 1;
	while (messages.length < total) {
		const page = await host.request<DesktopHistory>("history.get", {
			sessionId,
			offset: messages.length,
			limit: 100,
		});
		assert(!page.truncated, "History unexpectedly truncated");
		total = page.total;
		messages.push(...page.messages);
		assert(messages.length === total || page.messages.length > 0, "History pagination made no progress");
	}
	return messages;
}
// Canonical persisted entry IDs must survive a full fork. Display IDs, copy
// generations and revision-navigation metadata are projection-local, not ancestry.
function durableHistory(items: DesktopMessage[]) {
	return items.map(item => ({
		entryId: item.entryId,
		role: item.role,
		text: item.text,
		toolName: item.toolName,
		blocks: item.blocks,
		isError: item.isError === true,
		cancelled: item.cancelled === true,
		truncated: item.truncated === true,
		excludeFromContext: item.excludeFromContext === true,
	}));
}
function shellQuote(value: string): string {
	return `'${value.replaceAll("'", "'\\''")}'`;
}
function imageMessage(messages: DesktopMessage[]): DesktopMessage {
	const message = messages.find(item => item.role === "user" && item.blocks?.some(block => block.type === "image"));
	assert(message, "History did not retain the user image message");
	assert(
		message.blocks?.some(
			block => block.type === "image" && block.mimeType === "image/png" && block.data === FIXTURE_IMAGE,
		),
		"History did not retain exact image bytes",
	);
	return message;
}

export async function verifyStandalone(appArgument: string) {
	const app = await fs.realpath(appArgument);
	const directory = path.join(app, "Contents/MacOS");
	const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "gjc-desktop-standalone-")));
	const project = path.join(root, "project");
	const environment = {
		PATH: "/usr/bin:/bin",
		HOME: path.join(root, "home"),
		TMPDIR: root,
		LANG: "en_US.UTF-8",
		GJC_DESKTOP_ISOLATED: "1",
		GJC_DESKTOP_DATA_DIR: path.join(root, "data"),
	};
	let fixture: StandaloneFixture;
	try {
		fixture = startStandaloneFixture();
	} catch (error) {
		await fs.rm(root, { recursive: true, force: true });
		throw error;
	}
	const hosts: StandaloneHost[] = [];
	const scenarios: Array<{ scenario: string; assertions: string[]; evidence: unknown }> = [];
	let activeScenario = "bundle-preflight";
	let result: Record<string, unknown> | undefined;
	const failures: unknown[] = [];
	const record = (scenario: string, assertions: string[], evidence: unknown) =>
		scenarios.push({ scenario, assertions, evidence });
	const launch = (location = directory) => {
		const host = new StandaloneHost(location, project, environment);
		hosts.push(host);
		return host;
	};
	try {
		// Reject script fixtures in the functional verifier. Shutdown unit tests use
		// the exported transport directly, never a functional-success switch.
		for (const name of ["gjc", "gjc-desktop-host"]) {
			const executable = path.join(directory, name);
			assert((await fs.realpath(executable)).startsWith(`${app}${path.sep}`), `${name} resolves outside caller App`);
			const magic = Buffer.from(await Bun.file(executable).slice(0, 4).arrayBuffer()).toString("hex");
			assert(
				["cffaedfe", "feedfacf", "cafebabe", "bebafeca"].includes(magic),
				`${name} is not a packaged Mach-O binary`,
			);
		}
		await seedStandaloneFixture(root, fixture.baseUrl, fixture.token);
		const version = await bundledCli(directory, project, environment, ["--version"]);
		const smoke = await bundledCli(directory, project, environment, ["--smoke-test"]);
		const sdkDispatch = await bundledCli(directory, project, environment, ["sdk", "--help"], "gjc-desktop-host");
		assert(sdkDispatch.includes('"id":"sdk/overview/summary"'), "SDK child mode did not reach the CLI");
		const host = launch();
		await host.request("bootstrap");
		const workspace = await host.request<DesktopProject>("project.open", { path: project });
		const session = await host.request<DesktopSession>("session.create", { projectId: workspace.id });
		const sessionId = session.id;
		await host.request("model.set", { sessionId, modelId: FIXTURE_MODEL });
		const tools = await host.request<{ available: string[] }>("tools.list", { sessionId });
		for (const name of ["bash", "eval", "job"])
			assert(tools.available.includes(name), `Required public tool unavailable: ${name}`);
		await host.request("tools.set", { sessionId, names: ["bash", "eval", "job"] });
		const shell = await operation(host, sessionId, "! command -v gjc && gjc --version && gjc state ultragoal --help");
		assert(
			shell.status === "completed" && shell.exitCode === 0 && shell.output.includes(path.join(directory, "gjc")),
			`Bundled workflow command failed: ${JSON.stringify(shell)}`,
		);
		const turn = async (owner: string, spec: FixtureTurn, extra: Record<string, unknown> = {}) => {
			fixture.arm(spec);
			await host.request("prompt", { sessionId: owner, text: spec.prompt, ...extra });
			fixture.assertComplete();
			const messages = await history(host, owner);
			assert(
				messages.some(message => message.role === "assistant" && message.text === spec.answer),
				`Missing final answer: ${spec.answer}`,
			);
			assert(
				!messages.some(message => message.isError),
				`Tool error in ${spec.prompt}: ${JSON.stringify(messages)}`,
			);
			return messages;
		};

		activeScenario = "prompt-tool-child";
		const childMarker = path.join(project, "child-marker.txt");
		const childPath = path.join(directory, "gjc");
		const command = `resolved="$(command -v gjc)"; printf '%s\\n' "$resolved"; [ "$resolved" = ${shellQuote(childPath)} ] && "$resolved" --version && "$resolved" state ultragoal --help && printf standalone-child-ok > ${shellQuote(childMarker)} && printf standalone-child-ok`;
		let messages = await turn(sessionId, {
			prompt: "standalone prompt tool child",
			answer: "standalone child turn complete",
			tools: [{ name: "bash", arguments: { command, cwd: project, timeout: 30 }, result: "standalone-child-ok" }],
		});
		assert(
			(await Bun.file(childMarker).text()) === "standalone-child-ok",
			"Real child command did not write its marker",
		);
		assert(
			messages.some(
				message => message.role === "tool" && message.toolName === "bash" && message.text.includes(childPath),
			),
			"Tool transcript does not prove bundle-local child resolution",
		);
		record(
			activeScenario,
			[
				"exact provider prompt/tool/arguments/result linkage",
				"real bundled gjc child resolves inside App",
				"child marker persisted",
			],
			{ childPath, marker: await Bun.file(childMarker).text(), shell },
		);

		activeScenario = "images";
		messages = await turn(
			sessionId,
			{ prompt: "standalone image bytes", answer: "standalone image turn complete", image: true },
			{
				attachments: [{ kind: "image", name: "pixel.png", mimeType: "image/png", data: FIXTURE_IMAGE }],
			},
		);
		const image = imageMessage(messages);
		record(
			activeScenario,
			["exact PNG data URL reached real provider serializer", "exact image bytes retained in public history"],
			{ entryId: image.entryId },
		);

		activeScenario = "bundled-workers";
		const workerMessages = await turn(sessionId, {
			prompt: "standalone persistent worker",
			answer: "standalone worker turn complete",
			tools: [
				{
					name: "eval",
					arguments: {
						cells: [
							{
								language: "js",
								code: "globalThis.standaloneWorkerValue = 41; globalThis.standaloneWorkerIdentity = {execPath: process.execPath, pid: process.pid, threadId: require('node:worker_threads').threadId, isMainThread: require('node:worker_threads').isMainThread}; console.log('standalone-worker-identity=' + JSON.stringify(globalThis.standaloneWorkerIdentity)); 'standalone-worker-first'",
							},
						],
					},
					result: "standalone-worker-first",
				},
				{
					name: "eval",
					arguments: {
						cells: [{ language: "js", code: "'standalone-worker-' + (globalThis.standaloneWorkerValue + 1)" }],
					},
					result: "standalone-worker-42",
				},
			],
		});
		const identityOutput = workerMessages
			.filter(message => message.role === "tool" && message.toolName === "eval")
			.map(message => message.text)
			.join("\n");
		const identityJson = /standalone-worker-identity=(\{[^\r\n]+\})/.exec(identityOutput)?.[1];
		assert(identityJson, `Eval worker did not expose runtime identity: ${identityOutput}`);
		const workerIdentity: unknown = JSON.parse(identityJson);
		assert(
			workerIdentity &&
				typeof workerIdentity === "object" &&
				"execPath" in workerIdentity &&
				typeof workerIdentity.execPath === "string" &&
				"pid" in workerIdentity &&
				workerIdentity.pid === host.child.pid &&
				"threadId" in workerIdentity &&
				typeof workerIdentity.threadId === "number" &&
				workerIdentity.threadId > 0 &&
				"isMainThread" in workerIdentity &&
				workerIdentity.isMainThread === false,
			`Eval did not run in the real host's worker thread: ${identityJson}`,
		);
		const workerExecutor = await fs.realpath(workerIdentity.execPath);
		assert(
			workerExecutor === (await fs.realpath(path.join(directory, "gjc-desktop-host"))) &&
				workerExecutor.startsWith(`${app}${path.sep}`),
			`Eval worker used an external executor: ${workerExecutor}`,
		);
		record(
			activeScenario,
			[
				"compiled JS worker executes in App-contained host executor",
				"worker state survives separate eval calls",
				"CLI smoke executes bundled smoke coverage",
			],
			{ smoke, workerIdentity, workerExecutor },
		);

		activeScenario = "reverse-ui";
		fixture.arm({ prompt: QUESTION_PROMPT, answer: "standalone reverse UI complete" });
		// Service the real reverse request concurrently: prompt waits for this answer.
		let promptSettled = false;
		const prompting = host.request("prompt", { sessionId, text: QUESTION_PROMPT });
		void prompting.then(
			() => {
				promptSettled = true;
			},
			() => {
				promptSettled = true;
			},
		);
		try {
			const question = await waitFor(async () => {
				const current = host.sessions.get(sessionId);
				if (current?.error) throw new Error(current.error);
				return current?.question;
			}, "Reverse UI input question");
			assert(
				question.kind === "input" && question.title === QUESTION_TITLE,
				`Unexpected reverse UI question: ${JSON.stringify(question)}`,
			);
			// Flush a real subsequent observation so any eager prompt response is
			// processed before asserting that this answer releases a pending turn.
			await host.request("activity.get", { sessionId });
			assert(!promptSettled, "Reverse UI prompt settled before the answer");
			await host.request("question.answer", { sessionId, questionId: question.id, value: QUESTION_ANSWER });
			await prompting;
			const settledSession = await host.request<DesktopSession>("session.select", { sessionId });
			assert(
				!settledSession.question && !host.sessions.get(sessionId)?.question,
				"Reverse UI question was not retired after prompt completion",
			);
		} catch (error) {
			await cancelTurn(host, sessionId, prompting, error);
		}
		fixture.assertComplete();
		assert(
			(await Bun.file(path.join(root, "reverse-ui-answer.txt")).text()) === QUESTION_ANSWER,
			"Extension did not observe real UI answer",
		);
		assert(
			(await history(host, sessionId)).some(
				message => message.role === "assistant" && message.text === "standalone reverse UI complete",
			),
			"Reverse UI turn did not finish",
		);
		record(
			activeScenario,
			[
				"ordinary extension emits real UI input request",
				"prompt is pending before public question.answer and completes after it",
				"question retires after completion",
				"extension persists exact answer",
			],
			{ answer: QUESTION_ANSWER },
		);

		activeScenario = "background-job";
		const releaseFile = path.join(project, "release-job");
		const jobMarker = path.join(project, "job-marker.txt");
		await turn(sessionId, {
			prompt: "standalone background start",
			answer: "standalone background started",
			tools: [
				{
					name: "bash",
					arguments: {
						command: `while [ ! -f ${shellQuote(releaseFile)} ]; do /bin/sleep 0.1; done; printf standalone-job-complete > ${shellQuote(jobMarker)}; printf standalone-job-complete`,
						cwd: project,
						timeout: 45,
						async: true,
					},
					result: "Background job ",
				},
			],
		});
		const runningJob = await waitFor(async () => {
			const update = await host.request<DesktopActivityUpdate>("activity.get", { sessionId });
			assert(update.activity.available, `Activity unavailable: ${JSON.stringify(update.activity)}`);
			return update.activity.jobs.find(job => job.status === "running" && job.backgrounded);
		}, "Running background job projection");
		assert(!(await Bun.file(jobMarker).exists()), "Background job finished before release");
		const pollSpec: FixtureTurn = {
			prompt: "standalone background poll",
			answer: "standalone background complete",
			tools: [
				{
					name: "job",
					arguments: { poll: [runningJob.id], tail: [runningJob.id] },
					result: "standalone-job-complete",
				},
			],
		};
		fixture.arm(pollSpec);
		const polling = host.request("prompt", { sessionId, text: pollSpec.prompt });
		void polling.catch(() => {});
		try {
			await waitFor(
				async () =>
					fixture.snapshot().evidence.some(item => item.turn === pollSpec.prompt && item.tool === "job")
						? true
						: undefined,
				"Real provider job poll dispatch",
			);
			await Bun.write(releaseFile, "release\n");
			await polling;
		} catch (error) {
			await cancelTurn(host, sessionId, polling, error);
		}
		fixture.assertComplete();
		const finishedJob = await waitFor<DesktopActivityJob>(async () => {
			const update = await host.request<DesktopActivityUpdate>("activity.get", { sessionId });
			assert(update.activity.available, "Activity became unavailable");
			const job = update.activity.jobs.find(item => item.id === runningJob.id);
			assert(job, "Background job disappeared before terminal evidence");
			assert(job.status !== "failed" && job.status !== "cancelled", `Background job failed: ${JSON.stringify(job)}`);
			return job.status === "completed" ? job : undefined;
		}, "Background job completion");
		const detail = await host.request<DesktopActivityDetail>("activity.detail", { sessionId, ref: finishedJob.ref });
		assert((await Bun.file(jobMarker).text()) === "standalone-job-complete", "Background command marker missing");
		const jobHistory = await history(host, sessionId);
		assert(
			jobHistory.some(message => message.role === "assistant" && message.text === pollSpec.answer),
			"Background poll did not finish",
		);
		assert(!jobHistory.some(message => message.isError), "Background tool produced an error");
		record(
			activeScenario,
			[
				"real async bash remains running after prompt returns",
				"public activity exposes backgrounded job",
				"real job poll returns output",
				"job reaches completed and writes marker",
			],
			{ runningJob, finishedJob, detail },
		);

		activeScenario = "revise-fork";
		messages = await turn(sessionId, {
			prompt: "standalone original revision",
			answer: "standalone original answer",
		});
		const original = messages.find(
			message => message.role === "user" && message.text === "standalone original revision",
		);
		assert(original?.entryId, "Original prompt has no canonical entry ID");
		await turn(sessionId, { prompt: "standalone remembered continuation", answer: "standalone continuation answer" });
		messages = await turn(
			sessionId,
			{ prompt: "standalone revised prompt", answer: "standalone revised answer" },
			{ editEntryId: original.entryId },
		);
		const revised = messages.find(message => message.role === "user" && message.text === "standalone revised prompt");
		assert(
			revised?.entryId && revised.entryId !== original.entryId,
			"Edit did not create a distinct persisted sibling",
		);
		assert(
			!messages.some(message => message.text === "standalone continuation answer"),
			"Edited branch leaked original continuation",
		);
		const revisedBefore = await turn(sessionId, {
			prompt: "standalone revised continuation",
			answer: "standalone revised continuation answer",
		});
		await host.request("session.revision", { sessionId, entryId: original.entryId });
		messages = await history(host, sessionId);
		assert(
			messages.some(message => message.entryId === original.entryId) &&
				messages.some(message => message.text === "standalone continuation answer") &&
				!messages.some(message => message.entryId === revised.entryId),
			"Revision select did not restore remembered non-tail branch",
		);
		imageMessage(messages);
		const selectedSource = durableHistory(messages);
		assert(
			selectedSource.filter(message => message.role === "user").every(message => message.entryId),
			"Source ancestry contains a user message without canonical entry ID",
		);
		const fork = await host.request<DesktopForkResult>("session.fork", { sessionId });
		assert(!fork.cancelled && fork.session.id !== sessionId, "Fork did not create an independent conversation");
		const inheritedFork = durableHistory(await history(host, fork.session.id));
		assert(
			util.isDeepStrictEqual(selectedSource, inheritedFork),
			"Fork did not inherit the complete selected source transcript with canonical entry IDs",
		);
		await turn(fork.session.id, { prompt: "standalone fork-only prompt", answer: "standalone fork-only answer" });
		const sourceBefore = await history(host, sessionId);
		const forkBefore = await history(host, fork.session.id);
		assert(
			util.isDeepStrictEqual(selectedSource, durableHistory(sourceBefore)) &&
				util.isDeepStrictEqual(selectedSource, durableHistory(forkBefore).slice(0, selectedSource.length)),
			"Fork-only turn changed or truncated complete inherited ancestry",
		);
		assert(
			!sourceBefore.some(message => message.text === "standalone fork-only answer"),
			"Fork changed source branch",
		);
		assert(
			forkBefore.some(message => message.text === "standalone continuation answer"),
			"Fork lost selected non-tail source branch",
		);
		imageMessage(forkBefore);
		record(
			activeScenario,
			[
				"edit creates sibling persisted user entry",
				"revision select restores remembered continuation, not newest tail",
				"fork has independent identity and complete canonical source-prefix ancestry",
			],
			{
				originalEntryId: original.entryId,
				revisedEntryId: revised.entryId,
				sourceId: sessionId,
				forkId: fork.session.id,
			},
		);

		activeScenario = "cold-persistence";
		const firstShutdown = await host.shutdown();
		const reopened = launch();
		const snapshot = await reopened.request<DesktopSnapshot>("bootstrap");
		for (const id of [sessionId, fork.session.id])
			assert(
				snapshot.sessions.some(item => item.id === id),
				`Cold bootstrap lost session ${id}`,
			);
		await reopened.request("session.select", { sessionId });
		await reopened.request("session.select", { sessionId: fork.session.id });
		const sourceAfter = await history(reopened, sessionId);
		const forkAfter = await history(reopened, fork.session.id);

		assert(
			util.isDeepStrictEqual(durableHistory(sourceBefore), durableHistory(sourceAfter)),
			"Cold reopen changed source's selected non-tail transcript",
		);
		assert(
			util.isDeepStrictEqual(durableHistory(forkBefore), durableHistory(forkAfter)),
			"Cold reopen changed fork transcript",
		);
		await reopened.request("session.revision", { sessionId, entryId: revised.entryId });
		const revisedAfter = await history(reopened, sessionId);
		assert(
			util.isDeepStrictEqual(durableHistory(revisedBefore), durableHistory(revisedAfter)),
			"Cold reselect lost revised sibling or its remembered continuation",
		);
		assert(
			revisedAfter.some(message => message.text === "standalone revised continuation answer"),
			"Revised branch continuation disappeared after cold restart",
		);
		await reopened.request("session.revision", { sessionId, entryId: original.entryId });
		assert(
			util.isDeepStrictEqual(durableHistory(sourceBefore), durableHistory(await history(reopened, sessionId))),
			"Cold sibling roundtrip lost original branch or its remembered continuation",
		);
		assert(
			util.isDeepStrictEqual(durableHistory(forkBefore), durableHistory(await history(reopened, fork.session.id))),
			"Source sibling selection changed independent fork history",
		);
		imageMessage(sourceAfter);
		imageMessage(forkAfter);
		assert(
			(await Bun.file(childMarker).text()) === "standalone-child-ok" &&
				(await Bun.file(jobMarker).text()) === "standalone-job-complete",
			"Cold reopen lost tool filesystem effects",
		);
		record(
			activeScenario,
			[
				"fresh host process discovers both persisted sessions",
				"exact canonical history survives source non-tail and fork cold reopen",
				"both sibling branches cold-reselect with exact remembered continuations",
				"images and child/background filesystem effects survive",
			],
			{
				oldPid: host.child.pid,
				newPid: reopened.child.pid,
				sourceMessages: sourceAfter.length,
				forkMessages: forkAfter.length,
				revisedMessages: revisedAfter.length,
				firstShutdown,
			},
		);
		const finalShutdown = await reopened.shutdown();

		activeScenario = "missing-bundle-dependency";
		const callerFile = path.join(directory, "gjc");
		const hash = async (file: string) =>
			new Bun.CryptoHasher("sha256").update(await Bun.file(file).arrayBuffer()).digest("hex");
		const callerHash = await hash(callerFile);
		const copy = path.join(root, "dependency-copy", path.basename(app));
		await fs.mkdir(path.dirname(copy), { recursive: true });
		await fs.cp(app, copy, { recursive: true, dereference: true });
		const copiedDirectory = path.join(copy, "Contents/MacOS");
		const copiedDependency = path.join(copiedDirectory, "gjc");
		assert(
			(await fs.realpath(copiedDependency)).startsWith(`${root}${path.sep}`),
			"Missing-dependency target escaped owned QA root",
		);
		await fs.rm(copiedDependency);
		const broken = launch(copiedDirectory);
		await broken.request("bootstrap");
		const brokenSession = await broken.request<DesktopSession>("session.create", { projectId: workspace.id });
		const probe = "! command -v gjc; gjc --version";
		const missing = await operation(broken, brokenSession.id, probe);
		assert(
			missing.status !== "running" &&
				missing.exitCode === 127 &&
				!missing.output.includes(childPath) &&
				/command not found|not found|No such file/i.test(missing.output),
			`Missing dependency did not fail deterministically: ${JSON.stringify(missing)}`,
		);
		assert((await hash(callerFile)) === callerHash, "Caller bundle dependency changed");
		await broken.shutdown();
		record(
			activeScenario,
			[
				"destructive probe touches only owned App COPY",
				"no PATH fallback to caller/global gjc",
				"missing child fails exit 127 with missing-command evidence",
				"caller dependency hash unchanged",
			],
			{ removedRelativePath: "Contents/MacOS/gjc", copiedApp: copy, callerSha256: callerHash, operation: missing },
		);
		fixture.assertComplete();
		result = {
			app,
			globalPath: environment.PATH,
			version,
			smoke,
			sdkDispatch,
			shellStatus: shell.status,
			shellExitCode: shell.exitCode,
			shellOutput: shell.output,
			...finalShutdown,
			scenarios,
			provider: fixture.snapshot(),
			note: "Packaged host/CLI functional proof only; not native WebView, TUI/App roundtrip, or all34 acceptance.",
		};
	} catch (error) {
		failures.push(error);
	} finally {
		const cleanup = await Promise.allSettled(hosts.map(host => host.dispose()));
		for (const item of cleanup) if (item.status === "rejected") failures.push(item.reason);
		try {
			await fixture.close();
		} catch (error) {
			failures.push(error);
		}
		try {
			await fs.rm(root, { recursive: true, force: true });
		} catch (error) {
			failures.push(error);
		}
	}
	if (failures.length) {
		process.stderr.write(
			`${JSON.stringify(
				{
					app,
					failedScenario: activeScenario,
					errors: failures.map(errorEvidence),
					scenarios,
					provider: fixture.snapshot(),
				},
				null,
				2,
			)}\n`,
		);
		throw new AggregateError(failures, `Standalone verification failed during ${activeScenario}`);
	}
	assert(result, "Standalone verification produced no receipt");
	return result;
}

if (import.meta.main) {
	const app = path.resolve(
		process.argv[2] ?? path.join(import.meta.dir, "../src-tauri/target/release/bundle/macos/Gajae Code.app"),
	);
	const receipt = await verifyStandalone(app);
	process.stdout.write(`${JSON.stringify(receipt, null, 2)}\n`);
}
