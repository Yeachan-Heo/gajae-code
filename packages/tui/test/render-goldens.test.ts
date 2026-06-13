import { describe, expect, it } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
	captureTexts,
	RENDER_GOLDEN_FIXTURES,
	type RenderGoldenCapture,
	readRenderGolden,
	renderGoldenDir,
} from "./render-goldens";
import { GOLDEN_BASELINE_ENV } from "./render-goldens-env";

function lines(text: string): string[] {
	return text.endsWith("\n") ? text.slice(0, -1).split("\n") : text.split("\n");
}

interface SerializedRenderGoldenCapture extends Omit<RenderGoldenCapture, "writeLog"> {
	writeLogBase64: string;
}

function childEnv(fixtureEnv: Record<string, string | undefined> | undefined): Record<string, string> {
	const env: Record<string, string> = {};
	for (const [key, value] of Object.entries({ ...GOLDEN_BASELINE_ENV, ...(fixtureEnv ?? {}) })) {
		if (value !== undefined) env[key] = value;
	}
	return env;
}

function deserializeCapture(capture: SerializedRenderGoldenCapture): RenderGoldenCapture {
	return { ...capture, writeLog: Uint8Array.from(Buffer.from(capture.writeLogBase64, "base64")) };
}

function captureRenderGoldenInChild(fixture: (typeof RENDER_GOLDEN_FIXTURES)[number]): RenderGoldenCapture {
	const mode = Bun.env.UPDATE_GOLDENS === "1" ? "update" : "capture";
	const result = Bun.spawnSync({
		cmd: [process.execPath, join(import.meta.dir, "render-goldens-child.ts"), fixture.name, mode],
		env: childEnv(fixture.env),
		stderr: "pipe",
		stdout: "pipe",
	});

	if (result.exitCode !== 0) {
		throw new Error(
			`render-goldens-child failed for ${fixture.name} (exit ${result.exitCode})\n${result.stderr.toString()}`,
		);
	}

	try {
		return deserializeCapture(JSON.parse(result.stdout.toString()) as SerializedRenderGoldenCapture);
	} catch (error) {
		throw new Error(
			`render-goldens-child returned invalid JSON for ${fixture.name}: ${error instanceof Error ? error.message : String(error)}\n${result.stdout.toString()}`,
		);
	}
}

async function expectGoldenHashesMatchFiles(fixtureName: string): Promise<void> {
	const dir = renderGoldenDir(fixtureName);
	const meta = JSON.parse(await readFile(join(dir, "meta.json"), "utf8")) as {
		artifacts: Record<string, { file: string; sha256: string }>;
	};
	for (const artifact of Object.values(meta.artifacts)) {
		const bytes = await readFile(join(dir, artifact.file));
		const digest = new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
		expect(digest).toBe(artifact.sha256);
	}
}

describe("TUI render goldens", () => {
	for (const fixture of RENDER_GOLDEN_FIXTURES) {
		it(`${fixture.name} matches viewport, scrollback, and terminal byte log`, async () => {
			const capture = captureRenderGoldenInChild(fixture);
			const { viewportText, scrollbackText } = captureTexts(capture);

			const golden = await readRenderGolden(fixture.name);
			expect(lines(viewportText)).toEqual(lines(golden.viewportText));
			expect(lines(scrollbackText)).toEqual(lines(golden.scrollbackText));
			expect(capture.writeLog).toEqual(golden.writeLog);
			expect(capture.meta).toEqual(golden.meta);
			await expectGoldenHashesMatchFiles(fixture.name);
		});
	}
});
