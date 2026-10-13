import { afterEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { performance } from "node:perf_hooks";
import type { Component } from "@gajae-code/tui";
import { TUI } from "@gajae-code/tui";
import { getDebugLogPath, resetAgentDirFromEnvironment, setAgentDir } from "@gajae-code/utils";
import { VirtualTerminal } from "./virtual-terminal";

const SECRET = "Bearer zzzzzzzzzzzzzzzz";
const PLAIN = "plain-frame-keeps-marker";

class Lines implements Component {
	#lines: string[];

	constructor(lines: string[]) {
		this.#lines = lines;
	}

	setLines(lines: string[]): void {
		this.#lines = lines;
	}

	invalidate(): void {}

	render(width: number): string[] {
		return this.#lines.map(line => line.slice(0, width));
	}
}

function restoreEnv(name: string, value: string | undefined): void {
	if (value === undefined) delete Bun.env[name];
	else Bun.env[name] = value;
}

function sharedDumpDir(): string {
	return path.join("/tmp", "tui");
}

function isSharedDumpFile(filePath: string): boolean {
	const shared = path.resolve(sharedDumpDir());
	const resolved = path.resolve(filePath);
	return resolved === shared || resolved.startsWith(`${shared}${path.sep}`);
}

function listRenderDumps(dirs: string[]): string[] {
	const found = new Map<string, string>();
	for (const dir of dirs) {
		let names: string[];
		try {
			names = fs.readdirSync(dir);
		} catch {
			continue;
		}
		for (const name of names) {
			if (!name.startsWith("render-") || !name.endsWith(".log")) continue;
			const full = path.join(dir, name);
			let stat: fs.Stats;
			try {
				stat = fs.lstatSync(full);
			} catch {
				continue;
			}
			if (!stat.isFile()) continue;
			const key = `${stat.dev}:${stat.ino}`;
			if (!found.has(key)) found.set(key, full);
		}
	}
	return [...found.values()];
}

describe("TUI render debug dump", () => {
	let root = "";
	let tmpLink = "";
	let previousAgent: string | undefined;
	let previousPiAgent: string | undefined;
	let previousDebug: string | undefined;
	let previousPiDebug: string | undefined;
	let previousTmux: string | undefined;

	afterEach(() => {
		vi.restoreAllMocks();
		restoreEnv("GJC_TUI_DEBUG", previousDebug);
		restoreEnv("PI_TUI_DEBUG", previousPiDebug);
		restoreEnv("TMUX", previousTmux);
		restoreEnv("GJC_CODING_AGENT_DIR", previousAgent);
		restoreEnv("PI_CODING_AGENT_DIR", previousPiAgent);
		resetAgentDirFromEnvironment();
		if (tmpLink) {
			fs.rmSync(tmpLink, { force: true });
			tmpLink = "";
		}
		if (root) fs.rmSync(root, { recursive: true, force: true });
		root = "";
	});

	function captureEnv(): void {
		previousAgent = Bun.env.GJC_CODING_AGENT_DIR;
		previousPiAgent = Bun.env.PI_CODING_AGENT_DIR;
		previousDebug = Bun.env.GJC_TUI_DEBUG;
		previousPiDebug = Bun.env.PI_TUI_DEBUG;
		previousTmux = Bun.env.TMUX;
	}

	async function withDebugRender(
		second: string,
		prepare?: (debugDir: string) => void,
	): Promise<{ debugDir: string; created: string[] }> {
		captureEnv();
		root = fs.mkdtempSync(path.join(os.tmpdir(), "tui-debug-dump-"));
		setAgentDir(path.join(root, "agent"));
		Bun.env.GJC_TUI_DEBUG = "1";
		delete Bun.env.PI_TUI_DEBUG;
		delete Bun.env.TMUX;

		let monotonicNow = 0;
		vi.spyOn(performance, "now").mockImplementation(() => {
			monotonicNow += 20;
			return monotonicNow;
		});

		const debugDir = path.dirname(getDebugLogPath());
		prepare?.(debugDir);
		const watched = [debugDir, sharedDumpDir()];
		const before = new Set(listRenderDumps(watched));

		const term = new VirtualTerminal(80, 12);
		const tui = new TUI(term, false, { widthSettleMs: 0 });
		tui.start();
		const lines = new Lines(["hello"]);
		tui.addChild(lines);
		tui.requestRender(false, "tui-debug.first");
		await term.waitForRender();
		lines.setLines([second]);
		tui.requestRender(false, "tui-debug.second");
		await term.waitForRender();
		tui.stop();

		const created = listRenderDumps(watched).filter(file => !before.has(file));
		return { debugDir, created };
	}

	it("redacts a bearer token and writes the frame owner-only beside the debug log", async () => {
		const { debugDir, created } = await withDebugRender(`\x1b[31m${SECRET} status-line`);
		expect(fs.statSync(debugDir).isDirectory()).toBe(true);
		expect(fs.statSync(debugDir).mode & 0o777).toBe(0o700);
		expect(created.length).toBeGreaterThan(0);
		for (const file of created) {
			expect(isSharedDumpFile(file)).toBe(false);
			expect(fs.statSync(file).mode & 0o777).toBe(0o600);
			const body = fs.readFileSync(file, "utf8");
			expect(body.includes(SECRET)).toBe(false);
			expect(body.includes("\u0000")).toBe(false);
		}
		const bodies = created.map(file => fs.readFileSync(file, "utf8"));
		expect(bodies.some(body => body.includes("«redacted-auth»"))).toBe(true);
		expect(bodies.some(body => body.includes("status-line"))).toBe(true);
	});

	it("keeps a plain frame in the debug dump", async () => {
		const { created } = await withDebugRender(PLAIN);
		const bodies = created.map(file => fs.readFileSync(file, "utf8"));
		expect(bodies.some(body => body.includes(PLAIN))).toBe(true);
	});

	it.skipIf(process.platform === "win32")("leaves a precreated render-dump symlink target untouched", async () => {
		const stamp = 1_700_000_000_000;
		vi.spyOn(Date, "now").mockReturnValue(stamp);
		vi.spyOn(Math, "random").mockReturnValue(0.5);
		const name = `render-${stamp}-${(0.5).toString(36).slice(2)}.log`;
		let target = "";
		await withDebugRender(SECRET, debugDir => {
			fs.mkdirSync(debugDir, { recursive: true });
			target = path.join(path.dirname(debugDir), "symlink-target.txt");
			fs.writeFileSync(target, "untouched");
			fs.symlinkSync(target, path.join(debugDir, name));
			fs.mkdirSync(sharedDumpDir(), { recursive: true });
			tmpLink = path.join(sharedDumpDir(), name);
			fs.rmSync(tmpLink, { force: true });
			fs.symlinkSync(target, tmpLink);
		});
		expect(fs.readFileSync(target, "utf8")).toBe("untouched");
	});
});
