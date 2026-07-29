import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentToolContext } from "@gajae-code/agent-core";
import { resetSettingsForTest, Settings } from "@gajae-code/coding-agent/config/settings";
import { runInteractiveBashPty } from "@gajae-code/coding-agent/tools/bash-interactive";

interface DisposableComponent {
	dispose?: () => void;
}

function createTestUi(): NonNullable<AgentToolContext["ui"]> {
	return {
		custom<T>(factory: unknown): Promise<T> {
			return new Promise<T>((resolve, reject) => {
				let component: DisposableComponent | undefined;
				const done = (result: T) => {
					component?.dispose?.();
					resolve(result);
				};
				try {
					component = (
						factory as (
							tui: { terminal: { rows: number; columns: number }; requestRender: () => void },
							theme: Record<string, never>,
							keybindings: Record<string, never>,
							done: (result: T) => void,
						) => DisposableComponent
					)({ terminal: { rows: 40, columns: 120 }, requestRender: () => {} }, {}, {}, done);
				} catch (error) {
					reject(error);
				}
			});
		},
	} as unknown as NonNullable<AgentToolContext["ui"]>;
}

describe("interactive Bash PTY tail retention", () => {
	let tempDir: string;

	beforeEach(() => {
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "gjc-bash-pty-tail-"));
		resetSettingsForTest();
	});

	afterEach(() => {
		resetSettingsForTest();
		fs.rmSync(tempDir, { recursive: true, force: true });
	});

	it("keeps a 1 KiB tail and writes the complete PTY artifact by default", async () => {
		await Settings.init({ inMemory: true, cwd: tempDir });
		const artifactPath = path.join(tempDir, "pty-default.log");
		const result = await runInteractiveBashPty(createTestUi(), {
			command: "printf 'HEAD\\n'; printf 'middle-%05d\\n' {1..6000}; printf 'TAIL\\n'",
			cwd: tempDir,
			timeoutMs: 10_000,
			artifactPath,
			artifactId: "pty-default",
		});

		expect(result.exitCode).toBe(0);
		expect(result.truncated).toBe(true);
		expect(result.outputBytes).toBeLessThanOrEqual(1024);
		expect(result.output).not.toContain("HEAD");
		expect(result.output).toContain("TAIL");
		const artifact = fs.readFileSync(artifactPath, "utf-8");
		expect(artifact).toContain("HEAD");
		expect(artifact).toContain("middle-03000");
		expect(artifact).toContain("TAIL");
	});

	it("keeps both ends when PTY head retention is explicitly configured", async () => {
		await Settings.init({
			inMemory: true,
			cwd: tempDir,
			overrides: { "tools.artifactTailBytes": 1, "tools.artifactHeadBytes": 1 },
		});
		const result = await runInteractiveBashPty(createTestUi(), {
			command: "printf 'HEAD\\n'; printf 'middle-%05d\\n' {1..6000}; printf 'TAIL\\n'",
			cwd: tempDir,
			timeoutMs: 10_000,
		});

		expect(result.exitCode).toBe(0);
		expect(result.truncated).toBe(true);
		expect(result.output).toContain("HEAD");
		expect(result.output).toContain("TAIL");
		expect(result.output).toContain("elided");
	});
});
