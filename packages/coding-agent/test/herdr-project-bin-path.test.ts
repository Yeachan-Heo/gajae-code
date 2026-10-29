import { describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const probe = path.join(import.meta.dir, "fixtures/herdr-project-bin-path-probe.ts");
const handoffProbe = path.join(import.meta.dir, "fixtures/herdr-project-bin-path-handoff-probe.ts");

function writeExecutable(file: string, marker: string): void {
	fs.writeFileSync(file, `#!/bin/sh\n: > ${JSON.stringify(marker)}\nexit 0\n`);
	fs.chmodSync(file, 0o755);
}

function runProbe(
	mode: "attack" | "allow" | "dynamic" | "dynamic-shell" | "equal-shell" | "shell-only" | "spaced-shell",
): { payload: number; allowed: number; child: string } {
	const home = fs.mkdtempSync(path.join(os.tmpdir(), "herdr-home-"));
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "herdr-cwd-"));
	const payload = path.join(cwd, "payload.sh");
	const allowed = path.join(cwd, "allow.sh");
	const dynamicPayload = path.join(home, "payload.sh");
	const dynamic = mode === "dynamic" || mode === "dynamic-shell";
	writeExecutable(dynamic ? dynamicPayload : payload, path.join(cwd, "payload-ran"));
	writeExecutable(allowed, path.join(cwd, "allow-ran"));
	const declared = dynamic ? "$HOME/payload.sh" : payload;
	const dotenv =
		mode === "shell-only"
			? "HERDR_ENV=1\nHERDR_PANE_ID=gjc1\n"
			: `HERDR_ENV=1\nHERDR_PANE_ID=gjc1\nHERDR_BIN_PATH=${declared}\n`;
	fs.writeFileSync(path.join(cwd, ".env"), dotenv);
	const env: Record<string, string> = {
		PATH: "/usr/bin:/bin",
		HOME: home,
		USERPROFILE: home,
		CI: "1",
		TERM: "dumb",
	};
	if (mode === "allow" || mode === "dynamic-shell" || mode === "shell-only") env.HERDR_BIN_PATH = allowed;
	if (mode === "equal-shell") env.HERDR_BIN_PATH = payload;
	if (mode === "spaced-shell") env.HERDR_BIN_PATH = ` ${allowed}`;
	const result = spawnSync(process.execPath, [probe, mode === "attack" || mode === "dynamic" ? "attack" : "allow"], {
		cwd,
		env,
		encoding: "utf8",
		timeout: 120_000,
	});
	if (result.error) throw result.error;
	const line = (result.stdout ?? "").split("\n").find(entry => entry.startsWith("RESULT "));
	if (result.status !== 0 || line === undefined) {
		throw new Error(`probe ${mode} exited ${result.status}\n${result.stderr ?? ""}\n${result.stdout ?? ""}`);
	}
	const payloadHit = /payload=(\d)/.exec(line);
	const allowedHit = /allowed=(\d)/.exec(line);
	const childHit = /child=(".*")$/.exec(line);
	if (!payloadHit || !allowedHit || !childHit) throw new Error(`unparsed probe output: ${line}`);
	return {
		payload: Number(payloadHit[1]),
		allowed: Number(allowedHit[1]),
		child: JSON.parse(childHit[1]) as string,
	};
}

describe("project HERDR_BIN_PATH at runRootCommand", () => {
	it.skipIf(process.platform === "win32")(
		"does not execute a project dotenv HERDR_BIN_PATH and omits it from a child",
		() => {
			const result = runProbe("attack");
			expect(result.payload).toBe(0);
			expect(result.child).toBe("");
		},
		60_000,
	);

	it.skipIf(process.platform === "win32")(
		"does not execute a dynamic project HERDR_BIN_PATH and omits it from a child",
		() => {
			const result = runProbe("dynamic");
			expect(result.payload).toBe(0);
			expect(result.child).toBe("");
		},
		60_000,
	);

	it.skipIf(process.platform === "win32")(
		"keeps a different shell-exported HERDR_BIN_PATH and runs that executable",
		() => {
			const result = runProbe("allow");
			expect(result.payload).toBe(0);
			expect(result.allowed).toBe(1);
			expect(result.child.endsWith(`${path.sep}allow.sh`)).toBe(true);
		},
		60_000,
	);

	it.skipIf(process.platform === "win32")(
		"keeps a shell-exported path when the project does not declare one",
		() => {
			const result = runProbe("shell-only");
			expect(result.payload).toBe(0);
			expect(result.allowed).toBe(1);
			expect(result.child.endsWith(`${path.sep}allow.sh`)).toBe(true);
		},
		60_000,
	);

	it.skipIf(process.platform === "win32")(
		"keeps a shell export with surrounding whitespace that is not the project text",
		() => {
			const result = runProbe("spaced-shell");
			expect(result.payload).toBe(0);
			expect(result.child.startsWith(" ")).toBe(true);
			expect(result.child.trim().endsWith(`${path.sep}allow.sh`)).toBe(true);
		},
		60_000,
	);

	it.skipIf(process.platform === "win32")(
		"rejects a shell export equal to the static project path",
		() => {
			const result = runProbe("equal-shell");
			expect(result.payload).toBe(0);
			expect(result.child).toBe("");
		},
		60_000,
	);

	it.skipIf(process.platform === "win32")(
		"does not pass a project path through the tmux relaunch environment",
		() => {
			const home = fs.mkdtempSync(path.join(os.tmpdir(), "herdr-home-"));
			const origin = fs.mkdtempSync(path.join(os.tmpdir(), "herdr-origin-"));
			const target = fs.mkdtempSync(path.join(os.tmpdir(), "herdr-target-"));
			const payload = path.join(origin, "payload.sh");
			const marker = path.join(origin, "payload-ran");
			writeExecutable(payload, marker);
			fs.writeFileSync(path.join(origin, ".env"), `HERDR_ENV=1\nHERDR_PANE_ID=gjc1\nHERDR_BIN_PATH=${payload}\n`);
			const result = spawnSync(process.execPath, [handoffProbe, target, marker, probe], {
				cwd: origin,
				env: {
					PATH: "/usr/bin:/bin",
					HOME: home,
					USERPROFILE: home,
					CI: "1",
					TERM: "dumb",
				},
				encoding: "utf8",
				timeout: 120_000,
			});
			if (result.status !== 0) {
				throw new Error(`handoff exited ${result.status}\n${result.stderr ?? ""}\n${result.stdout ?? ""}`);
			}
			const line = (result.stdout ?? "").split("\n").find(entry => entry.startsWith("HANDOFF "));
			expect(line ?? "").toContain("tmux_has=0");
			expect(line ?? "").toContain("marker=0");
		},
		60_000,
	);

	it.skipIf(process.platform === "win32")(
		"rejects a different shell export when the project declaration is dynamic",
		() => {
			const result = runProbe("dynamic-shell");
			expect(result.payload).toBe(0);
			expect(result.allowed).toBe(0);
			expect(result.child).toBe("");
		},
		60_000,
	);
});
