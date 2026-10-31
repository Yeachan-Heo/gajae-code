/**
 * The SDK runs its isolated shell worker chain through `process.execPath`, which
 * for the desktop app is the host binary itself. If the compiled entrypoint does
 * not dispatch those internal modes, the worker lane starts a second desktop host
 * and every bash call fails with "Isolated shell worker emitted an unauthenticated
 * protocol record". These tests pin the dispatch and the build wiring.
 */
import { describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";

const root = path.resolve(import.meta.dir, "../../..");
const entry = path.join(root, "packages/desktop-host/src/entry.ts");

async function handshake(mode: string) {
	const token = crypto.randomUUID();
	const child = Bun.spawn([process.execPath, entry, mode], {
		cwd: root,
		stdin: "pipe",
		stdout: "pipe",
		stderr: "pipe",
	});
	const settled = Promise.withResolvers<Record<string, unknown>>();
	const decoder = new TextDecoder();
	let buffer = "";
	void (async () => {
		for await (const chunk of child.stdout as ReadableStream<Uint8Array>) {
			buffer += decoder.decode(chunk, { stream: true });
			let newline = buffer.indexOf("\n");
			while (newline >= 0) {
				const line = buffer.slice(0, newline);
				buffer = buffer.slice(newline + 1);
				newline = buffer.indexOf("\n");
				if (!line.trim()) continue;
				try {
					const record = JSON.parse(line) as Record<string, unknown>;
					settled.resolve(record);
					return;
				} catch {
					/* keep reading */
				}
			}
		}
		settled.reject(new Error("worker closed without a protocol record"));
	})();
	child.stdin.write(`${JSON.stringify({ type: "init", token, options: { cwd: root } })}\n`);
	await child.stdin.flush();
	const timeout = setTimeout(() => settled.reject(new Error("worker handshake timed out")), 60_000);
	try {
		const record = await settled.promise;
		return { record, token };
	} finally {
		clearTimeout(timeout);
		child.kill("SIGKILL");
		await child.exited;
	}
}

describe("desktop host internal worker modes", () => {
	test("answers the guardian handshake with an authenticated record", async () => {
		const { record, token } = await handshake("--internal-bash-shell-worker");
		// The desktop protocol answers with a fatal frame and no token; the worker
		// protocol echoes the token it was given.
		expect(record.token).toBe(token);
		expect(record.type === "ready" || record.type === "retiring").toBe(true);
	}, 90_000);

	test("answers the runtime handshake with an authenticated record", async () => {
		const { record, token } = await handshake("--internal-bash-shell-runtime");
		expect(record.token).toBe(token);
		expect(record.type).toBe("ready");
	}, 90_000);

	test("the packaged entrypoint is the one that dispatches worker modes", async () => {
		const script = await fs.readFile(path.join(root, "packages/desktop/scripts/build-host.ts"), "utf8");
		expect(script).toContain("packages/desktop-host/src/entry.ts");
		expect(script).not.toContain('"./packages/desktop-host/src/index.ts"');
	});
});
