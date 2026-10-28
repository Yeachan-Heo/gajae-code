// Manual live check: drives real model turns against a packaged host binary and
// asserts the built-in tools actually execute. Not part of CI — it spends provider
// tokens and needs credentials — so it is run on demand:
//
//   bun packages/desktop/scripts/live-tool-check.ts "/path/to/Gajae Code.app/Contents/MacOS/gjc-desktop-host"
//
// It uses the shared install (the product default), so the session inherits the
// configured default model preset exactly as the app does.
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
	console.error("usage: bun packages/desktop/scripts/live-tool-check.ts <host-binary>");
	process.exit(2);
}

const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-live-tools-data-"));
const projectDir = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-live-tools-project-"));
const host = Bun.spawn([hostBinary], {
	cwd: os.tmpdir(),
	env: {
		PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
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
	for await (const chunk of host.stderr as ReadableStream<Uint8Array>) stderrText += new TextDecoder().decode(chunk);
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
			if (frame.type === "fatal") throw new Error(`engine fatal: ${String(frame.error)}`);
			if (frame.type === "response" && frame.id) pending.get(frame.id)?.(frame);
		}
	}
})();

async function call(method: string, params: Record<string, unknown> = {}, timeoutMs = 240_000): Promise<unknown> {
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
}

const sessionMessages = async (sessionId: string) => {
	const snapshot = (await call("bootstrap")) as {
		sessions: { id: string; messages: { role: string; text: string }[] }[];
	};
	return snapshot.sessions.find(item => item.id === sessionId)?.messages ?? [];
};

const receipt: Record<string, unknown> = { host: hostBinary };
try {
	await call("bootstrap");
	const project = (await call("project.open", { path: projectDir })) as { id: string };
	const session = (await call("session.create", { projectId: project.id })) as { id: string; model?: string };
	receipt.model = session.model ?? null;

	// 1. bash executes a real command.
	await call("prompt", {
		sessionId: session.id,
		text: "Use the bash tool to run `echo gjc-bash-ok && cat note.txt`. Reply with only the command output.",
	});
	const bashReply = (await sessionMessages(session.id))
		.filter(message => message.role === "assistant")
		.map(message => message.text)
		.join("\n");
	receipt.bash = { ran: bashReply.includes("gjc-bash-ok"), readFile: bashReply.includes("hello-from-file") };

	// 2. write/edit/read/search/find change the project on disk.
	await call("prompt", {
		sessionId: session.id,
		text: [
			"In this project do exactly these steps, using tools:",
			"1. write probe.txt containing the single line alpha",
			"2. use edit to replace alpha with beta",
			"3. use read to read probe.txt",
			"4. use search to find beta",
			"5. use find to list *.txt files",
			"Then reply with the final file content only.",
		].join("\n"),
	});
	const onDisk = await fs.readFile(path.join(projectDir, "probe.txt"), "utf8").catch(() => "");
	receipt.fileTools = { content: onDisk.trim(), writeEditRead: onDisk.trim() === "beta" };

	// 3. Which tools the model actually invoked, from the session transcript.
	const used = new Set<string>();
	const walk = async (dir: string) => {
		for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
			const full = path.join(dir, entry.name);
			if (entry.isDirectory()) await walk(full);
			else if (entry.name.endsWith(".jsonl")) {
				const text = await fs.readFile(full, "utf8");
				for (const match of text.matchAll(/"toolName"\s*:\s*"([a-zA-Z_]+)"/g)) used.add(match[1]!);
				for (const match of text.matchAll(/"name"\s*:\s*"([a-zA-Z_]+)"\s*,\s*"arguments"/g)) used.add(match[1]!);
			}
		}
	};
	await walk(dataDir);
	receipt.toolsUsed = [...used].sort();
	receipt.ok =
		(receipt.bash as { ran: boolean }).ran === true &&
		(receipt.fileTools as { writeEditRead: boolean }).writeEditRead;
} catch (error) {
	receipt.ok = false;
	receipt.error = String(error).slice(0, 500);
} finally {
	receipt.stderr = stderrText.slice(-300);
	host.kill();
	await host.exited;
	await fs.rm(dataDir, { recursive: true, force: true });
	await fs.rm(projectDir, { recursive: true, force: true });
	console.log(JSON.stringify(receipt, null, 2));
	if (receipt.ok !== true) process.exitCode = 1;
}
