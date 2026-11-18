import { expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { FIXTURE_IMAGE, FIXTURE_KEY, startStandaloneFixture } from "../scripts/standalone-fixture";

async function bounded<T>(operation: Promise<T>, timeoutMs: number, label: string): Promise<T> {
	const timeout = Promise.withResolvers<T>();
	const timer = setTimeout(() => timeout.reject(new Error(`${label} timed out`)), timeoutMs);
	try {
		return await Promise.race([operation, timeout.promise]);
	} finally {
		clearTimeout(timer);
	}
}
function signalGroup(pid: number, signal: NodeJS.Signals | 0): boolean {
	try {
		process.kill(-pid, signal);
		return true;
	} catch (error) {
		if (error && typeof error === "object" && "code" in error && error.code === "ESRCH") return false;
		throw error;
	}
}
async function groupGone(pid: number, timeoutMs: number): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (signalGroup(pid, 0)) {
		if (Date.now() >= deadline) throw new Error(`Owned process group ${pid} remains alive`);
		await Bun.sleep(25);
	}
}
async function reapDriver(child: Bun.Subprocess): Promise<void> {
	// detached:true makes one owned POSIX group containing driver + fixture host.
	// The driver handles TERM by disposing/reaping its direct host first. Group
	// escalation also covers a broken/unresponsive driver without leaking a host.
	signalGroup(child.pid, "SIGTERM");
	try {
		await bounded(child.exited, 4000, "Driver TERM reap");
	} catch {
		signalGroup(child.pid, "SIGKILL");
		await bounded(child.exited, 2000, "Driver KILL reap");
	}
	try {
		await groupGone(child.pid, 2000);
	} catch {
		signalGroup(child.pid, "SIGKILL");
		await groupGone(child.pid, 2000);
	}
}
async function collectDriver(child: Bun.Subprocess<"ignore", "pipe", "pipe">) {
	const output = new Response(child.stdout).text();
	const errors = new Response(child.stderr).text();
	try {
		return await bounded(Promise.all([child.exited, output, errors]), 12_000, "Verifier driver collection");
	} finally {
		await reapDriver(child);
		await bounded(Promise.all([output, errors]), 1000, "Verifier driver final pipe drain");
	}
}

// Verifier-only fixtures drive the SAME StandaloneHost lifecycle used by the
// functional run. They do not fabricate functional scenario success: the full
// verifier accepts only actual packaged Mach-O binaries, never these scripts.
for (const fault of [
	"fatal_after_shutdown",
	"malformed_after_shutdown",
	"early_eof",
	"startup_syntax_error",
	"cleanup_deadline",
	"cleanup_rejected",
	"cleanup_hidden_by_tail",
	"incomplete_after_shutdown",
	"normal_eof",
] as const) {
	test(fault === "normal_eof"
		? "standalone verifier closes stdin after acknowledged shutdown"
		: fault === "startup_syntax_error"
			? "standalone verifier retains bounded startup stderr and exit evidence alongside protocol failure"
			: `standalone verifier rejects ${fault} even with an exit-zero host`, async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "desktop-verifier-fault-"));
		const app = path.join(root, "Fixture.app");
		const directory = path.join(app, "Contents/MacOS");
		try {
			await fs.mkdir(directory, { recursive: true });
			const source = `#!${process.execPath}
import * as path from "node:path";
if (path.basename(process.argv[1]) === "gjc") { process.stdout.write("fixture-cli\\n"); process.exit(0); }
if (process.argv[2] === "sdk") { process.stdout.write('{"id":"sdk/overview/summary"}\\n'); process.exit(0); }
if (${JSON.stringify(fault)} === "early_eof") process.exit(0);
if (${JSON.stringify(fault)} === "startup_syntax_error") {
  process.stderr.write("discarded startup prefix\\n" + "ordinary startup diagnostic\\n".repeat(1000) + "SyntaxError: Unexpected identifier 'ep'\\n");
  process.exit(1);
}
let buffer = "";
for await (const chunk of Bun.stdin.stream()) {
  buffer += new TextDecoder().decode(chunk);
  let newline = buffer.indexOf("\\n");
  while (newline >= 0) {
    const request = JSON.parse(buffer.slice(0, newline)); buffer = buffer.slice(newline + 1); newline = buffer.indexOf("\\n");
    const result = request.method === "project.open" ? { id: "p" } : request.method === "session.create" ? { id: "s" } : request.method === "operator.execute" ? { operationId: "o", status: "completed", exitCode: 0, output: ${JSON.stringify(path.join(directory, "gjc"))} } : null;
    process.stdout.write(JSON.stringify({ type: "response", id: request.id, ok: true, result }) + "\\n");
    if (request.method === "shutdown" && ["fatal_after_shutdown", "malformed_after_shutdown"].includes(${JSON.stringify(fault)})) {
      process.stdout.write(${JSON.stringify(fault)} === "fatal_after_shutdown" ? JSON.stringify({ type: "fatal", error: "late fixture fatal" }) + "\\n" : "not-json\\n");
      await Bun.sleep(20); process.exit(0);
    }
  }
}
if (${JSON.stringify(fault)} === "cleanup_deadline") process.stderr.write("[postmortem] cleanup deadline (1ms) expired for manual; exiting without waiting for remaining callbacks.\\n");
if (${JSON.stringify(fault)} === "cleanup_rejected") process.stderr.write("Cleanup callback failed\\n");
if (${JSON.stringify(fault)} === "cleanup_hidden_by_tail") process.stderr.write("Cleanup callback failed\\n" + "ordinary diagnostic\\n".repeat(1000));
if (${JSON.stringify(fault)} === "incomplete_after_shutdown") process.stdout.write('{"type":');
`;
			for (const name of ["gjc", "gjc-desktop-host"]) {
				const file = path.join(directory, name);
				await Bun.write(file, source);
				await fs.chmod(file, 0o700);
			}
			const driver = `
import { StandaloneHost } from ${JSON.stringify(path.resolve(import.meta.dir, "../scripts/standalone-qa.ts"))};
const host = new StandaloneHost(${JSON.stringify(directory)}, ${JSON.stringify(root)}, {
  PATH: "/usr/bin:/bin", HOME: ${JSON.stringify(root)}, GJC_DESKTOP_ISOLATED: "1",
  GJC_DESKTOP_DATA_DIR: ${JSON.stringify(path.join(root, "data"))}
});
process.once("SIGTERM", () => {
  void host.dispose().then(() => process.exit(1), error => {
    process.stderr.write(String(error) + "\\n"); process.exit(1);
  });
});
let receipt;
try {
  await host.request("bootstrap");
  const project = await host.request("project.open", {path: ${JSON.stringify(root)}});
  const session = await host.request("session.create", {projectId: project.id});
  const shell = await host.request("operator.execute", {sessionId: session.id, text: "! command -v gjc && gjc --version && gjc state ultragoal --help"});
  if (shell.status !== "completed" || shell.exitCode !== 0 || !shell.output.includes(${JSON.stringify(path.join(directory, "gjc"))}))
    throw new Error("Bundled workflow command failed");
  receipt = await host.shutdown();
} finally {
  await host.dispose();
}
process.stdout.write(JSON.stringify(receipt));
`;
			const child = Bun.spawn([process.execPath, "--eval", driver], {
				detached: true,
				cwd: root,
				env: { PATH: "/usr/bin:/bin", HOME: root },
				stdin: "ignore",
				stdout: "pipe",
				stderr: "pipe",
			});
			const [code, output, error] = await collectDriver(child);
			if (fault === "normal_eof") {
				expect(code).toBe(0);
				expect(JSON.parse(output).hostExitCode).toBe(0);
				expect(JSON.parse(output).hostDiagnostics).toBe("");
				expect(error).toBe("");
			} else {
				expect(code).not.toBe(0);
				expect(output).toBe("");
				if (fault === "startup_syntax_error") {
					expect(error).toContain("Host frame stream closed before shutdown");
					expect(error).toContain("SyntaxError: Unexpected identifier 'ep'");
					expect(error).toContain('"hostExitCode":1');
					expect(error).toContain('"hostSignalCode":null');
					expect(error).not.toContain("discarded startup prefix");
				}
				expect(error).toContain(
					fault === "fatal_after_shutdown"
						? "late fixture fatal"
						: fault === "malformed_after_shutdown"
							? "JSON"
							: fault.startsWith("cleanup_")
								? "Host cleanup diagnostics"
								: "Host",
				);
			}
		} finally {
			await fs.rm(root, { recursive: true, force: true });
		}
	}, 30_000);
}

test("functional verifier never treats script startup fixtures as packaged proof", async () => {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "desktop-verifier-startup-"));
	const app = path.join(root, "Startup.app");
	try {
		for (const name of ["gjc", "gjc-desktop-host"]) {
			const file = path.join(app, "Contents/MacOS", name);
			await Bun.write(file, `#!${process.execPath}\nprocess.stdout.write("startup-only\\n");\n`);
			await fs.chmod(file, 0o700);
		}
		const child = Bun.spawn([process.execPath, path.resolve(import.meta.dir, "../scripts/standalone-qa.ts"), app], {
			detached: true,
			cwd: root,
			env: { PATH: "/usr/bin:/bin", HOME: root },
			stdin: "ignore",
			stdout: "pipe",
			stderr: "pipe",
		});
		const [code, output, error] = await collectDriver(child);
		expect(code).not.toBe(0);
		expect(output).toBe("");
		expect(error).toContain("not a packaged Mach-O binary");
	} finally {
		await fs.rm(root, { recursive: true, force: true });
	}
}, 30_000);

function completion(baseUrl: string, token: string, messages: unknown[], tools: unknown[] = []) {
	return fetch(`${baseUrl}/chat/completions`, {
		method: "POST",
		headers: {
			Authorization: `Bearer ${FIXTURE_KEY}`,
			"X-Standalone-Fixture": token,
			"Content-Type": "application/json",
		},
		body: JSON.stringify({ model: "offline", stream: true, messages, tools }),
	});
}

test("standalone provider verifies actual tool results with order-independent arguments", async () => {
	const fixture = startStandaloneFixture();
	try {
		fixture.arm({
			prompt: "tool prompt",
			answer: "finished",
			tools: [{ name: "bash", arguments: { command: "printf marker", cwd: "/tmp" }, result: "marker" }],
		});
		const user = { role: "user", content: "tool prompt" };
		const first = await completion(
			fixture.baseUrl,
			fixture.token,
			[user],
			[{ type: "function", function: { name: "bash" } }],
		);
		expect(first.status).toBe(200);
		const chunks = (await first.text())
			.split("\n\n")
			.filter(line => line.startsWith("data: {"))
			.map(line => JSON.parse(line.slice(6)));
		expect(chunks.length).toBe(4);
		expect(chunks.at(-1)?.usage?.total_tokens).toBe(48);
		expect(new Set(chunks.map(chunk => chunk.id)).size).toBe(1);
		const call = chunks.flatMap(chunk => chunk.choices?.[0]?.delta?.tool_calls ?? [])[0];
		expect(call.function.name).toBe("bash");
		const final = await completion(fixture.baseUrl, fixture.token, [
			user,
			{
				role: "assistant",
				tool_calls: [
					{
						id: call.id,
						type: "function",
						function: {
							name: "bash",
							arguments: JSON.stringify({ cwd: "/tmp", command: "printf marker" }),
						},
					},
				],
			},
			{ role: "tool", tool_call_id: call.id, content: "actual marker result" },
		]);
		expect(final.status).toBe(200);
		expect(await final.text()).toContain('"content":"finished"');
		fixture.assertComplete();
		expect(fixture.snapshot().evidence.at(-1)?.observedResult).toBe("actual marker result");
	} finally {
		await fixture.close();
	}
});

test("standalone provider rejects a fabricated tool result", async () => {
	const fixture = startStandaloneFixture();
	try {
		fixture.arm({
			prompt: "tool prompt",
			answer: "finished",
			tools: [{ name: "bash", arguments: { command: "printf marker" }, result: "marker" }],
		});
		const user = { role: "user", content: "tool prompt" };
		await (
			await completion(fixture.baseUrl, fixture.token, [user], [{ type: "function", function: { name: "bash" } }])
		).text();
		const response = await completion(fixture.baseUrl, fixture.token, [
			user,
			{
				role: "assistant",
				tool_calls: [
					{ id: "standalone-tool-1", function: { name: "bash", arguments: '{"command":"printf marker"}' } },
				],
			},
			{ role: "tool", tool_call_id: "standalone-tool-1", content: "command failed" },
		]);
		expect(response.status).toBe(400);
		expect(await response.text()).toContain("missing result");
		expect(() => fixture.assertComplete()).toThrow("missing result");
	} finally {
		await fixture.close();
	}
});

for (const exact of [true, false]) {
	test(`standalone provider ${exact ? "accepts exact" : "rejects changed"} PNG bytes`, async () => {
		const fixture = startStandaloneFixture();
		try {
			fixture.arm({ prompt: "image prompt", answer: "image finished", image: true });
			const response = await completion(fixture.baseUrl, fixture.token, [
				{
					role: "user",
					content: [
						{ type: "text", text: "image prompt" },
						{
							type: "image_url",
							image_url: { url: `data:image/png;base64,${exact ? FIXTURE_IMAGE : `${FIXTURE_IMAGE}AAAA`}` },
						},
					],
				},
			]);
			expect(response.status).toBe(exact ? 200 : 400);
			const body = await response.text();
			if (exact) {
				expect(body).toContain('"content":"image finished"');
				fixture.assertComplete();
			} else {
				expect(body).toContain("image bytes changed");
				expect(() => fixture.assertComplete()).toThrow("image bytes changed");
			}
		} finally {
			await fixture.close();
		}
	});
}
