import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { CommandController } from "@gajae-code/coding-agent/modes/controllers/command-controller";
import type { InteractiveModeContext } from "@gajae-code/coding-agent/modes/types";
import { Snowflake } from "@gajae-code/utils";

const created: string[] = [];

function canSymlink(): boolean {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gjc-dbg-link-"));
	try {
		const target = path.join(dir, "t");
		const link = path.join(dir, "l");
		fs.writeFileSync(target, "x");
		fs.symlinkSync(target, link);
		return fs.lstatSync(link).isSymbolicLink();
	} catch {
		return false;
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
}

const symlinkOk = canSymlink();

afterEach(() => {
	for (const entry of created.splice(0)) fs.rmSync(entry, { recursive: true, force: true });
});

function controller(lines: string[]) {
	const status: string[] = [];
	const errors: string[] = [];
	const ctx = {
		ui: { terminal: { columns: 80 } },
		chatContainer: { render: () => lines },
		showStatus: (message: string) => {
			status.push(message);
		},
		showError: (message: string) => {
			errors.push(message);
		},
	} as unknown as InteractiveModeContext;
	return { command: new CommandController(ctx), status, errors };
}

function writtenPath(status: string): string {
	const line = status.split("\n").at(-1);
	if (!line) throw new Error("missing path");
	return line;
}

function remember(file: string): void {
	const parent = path.dirname(file);
	created.push(path.basename(parent).startsWith("gjc-debug-transcript-") ? parent : file);
}

describe("debug transcript temp file", () => {
	it("still writes a transcript when no temp symlink is planted", async () => {
		const { command, status, errors } = controller(["secret-line"]);
		await command.handleDebugTranscriptCommand();
		expect(errors).toEqual([]);
		const file = writtenPath(status[0] ?? "");
		remember(file);
		const stat = fs.lstatSync(file);
		expect(stat.isSymbolicLink()).toBe(false);
		expect(stat.isFile()).toBe(true);
		expect(fs.readFileSync(file, "utf8")).toBe("secret-line\n");
	});

	if (!symlinkOk) {
		it.skip("does not follow a preexisting symlink at the predictable temp name", () => {});
	}
	if (symlinkOk)
		it("does not follow a preexisting symlink at the predictable temp name", async () => {
			const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gjc-dbg-victim-"));
			created.push(dir);
			const victim = path.join(dir, "victim");
			fs.writeFileSync(victim, "SAFE");
			const now = Date.now;
			const fixed = 1_700_000_000_000;
			Date.now = () => fixed;
			try {
				const observed = Snowflake.next();
				const nextSeq = (Snowflake.getSequence(observed) + 1) & Snowflake.MAX_SEQUENCE;
				const id = Snowflake.formatParts(fixed - Snowflake.EPOCH_TIMESTAMP, nextSeq);
				const linkPath = path.join(os.tmpdir(), `${id}-tmp.txt`);
				created.push(linkPath);
				fs.rmSync(linkPath, { force: true });
				fs.symlinkSync(victim, linkPath);
				const { command, status, errors } = controller(["secret-line"]);
				await command.handleDebugTranscriptCommand();
				expect(errors).toEqual([]);
				expect(fs.readFileSync(victim, "utf8")).toBe("SAFE");
				expect(fs.lstatSync(linkPath).isSymbolicLink()).toBe(true);
				const file = writtenPath(status[0] ?? "");
				remember(file);
				expect(file).not.toBe(linkPath);
				expect(fs.readFileSync(file, "utf8")).toBe("secret-line\n");
				if (process.platform !== "win32") {
					expect(fs.statSync(file).mode & 0o777).toBe(0o600);
					expect(fs.statSync(path.dirname(file)).mode & 0o777).toBe(0o700);
				}
			} finally {
				Date.now = now;
			}
		});
});
