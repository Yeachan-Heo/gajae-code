// Manual live check: two desktop hosts share one GJC install (the product default)
// and each completes a real turn, proving the shared credential store tolerates
// concurrent use. Not part of CI — it spends provider tokens.
//
//   bun packages/desktop/scripts/live-concurrency-check.ts "/path/to/gjc-desktop-host"
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

interface Frame {
	type?: string;
	id?: string;
	ok?: boolean;
	error?: string;
	result?: unknown;
}

const hostBinary = process.argv[2];
if (!hostBinary) {
	console.error("usage: bun packages/desktop/scripts/live-concurrency-check.ts <host-binary>");
	process.exit(2);
}

async function runHost(label: string) {
	const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), `gjc-concurrent-${label}-`));
	const projectDir = await fs.mkdtemp(path.join(os.tmpdir(), `gjc-concurrent-project-${label}-`));
	const host = Bun.spawn([hostBinary], {
		cwd: os.tmpdir(),
		env: {
			PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
			// Both hosts point at the same install: same agent dir, same agent.db.
			HOME: os.homedir(),
			TMPDIR: os.tmpdir(),
			LANG: "en_US.UTF-8",
			GJC_DESKTOP_DATA_DIR: dataDir,
		},
		stdin: "pipe",
		stdout: "pipe",
		stderr: "pipe",
	});
	let stderrText = "";
	void (async () => {
		for await (const chunk of host.stderr as ReadableStream<Uint8Array>)
			stderrText += new TextDecoder().decode(chunk);
	})();
	const pending = new Map<string, (frame: Frame) => void>();
	const decoder = new TextDecoder();
	let buffer = "";
	void (async () => {
		for await (const chunk of host.stdout as ReadableStream<Uint8Array>) {
			buffer += decoder.decode(chunk, { stream: true });
			let newline = buffer.indexOf("\n");
			while (newline >= 0) {
				const line = buffer.slice(0, newline);
				buffer = buffer.slice(newline + 1);
				newline = buffer.indexOf("\n");
				if (!line.trim()) continue;
				const frame = JSON.parse(line) as Frame;
				if (frame.type === "response" && frame.id) pending.get(frame.id)?.(frame);
			}
		}
	})();
	const call = async (method: string, params: Record<string, unknown> = {}, timeoutMs = 240_000) => {
		const id = crypto.randomUUID();
		const settled = Promise.withResolvers<Frame>();
		pending.set(id, settled.resolve);
		host.stdin.write(`${JSON.stringify({ id, method, params })}\n`);
		await host.stdin.flush();
		const timer = setTimeout(() => settled.resolve({ ok: false, error: `${method} timed out` }), timeoutMs);
		try {
			const frame = await settled.promise;
			if (frame.ok !== true) throw new Error(`${method}: ${String(frame.error)}`);
			return frame.result;
		} finally {
			clearTimeout(timer);
			pending.delete(id);
		}
	};
	const started = Date.now();
	try {
		await call("bootstrap");
		const project = (await call("project.open", { path: projectDir })) as { id: string };
		const session = (await call("session.create", { projectId: project.id })) as { id: string; model?: string };
		await call("prompt", { sessionId: session.id, text: "Reply with exactly: OK" });
		const snapshot = (await call("bootstrap")) as {
			sessions: { id: string; messages: { role: string; text: string }[] }[];
		};
		const reply = (snapshot.sessions.find(item => item.id === session.id)?.messages ?? [])
			.filter(message => message.role === "assistant")
			.map(message => message.text)
			.join("\n")
			.trim();
		return {
			label,
			model: session.model ?? null,
			reply: reply.slice(0, 40),
			ms: Date.now() - started,
			stderr: stderrText.slice(-200),
		};
	} catch (error) {
		return { label, error: String(error).slice(0, 300), stderr: stderrText.slice(-200) };
	} finally {
		host.kill();
		await host.exited;
		await fs.rm(dataDir, { recursive: true, force: true });
		await fs.rm(projectDir, { recursive: true, force: true });
	}
}

const results = await Promise.all([runHost("a"), runHost("b")]);
const ok = results.every(result => result.reply === "OK");
console.log(JSON.stringify({ results, ok }, null, 2));
if (!ok) process.exitCode = 1;
