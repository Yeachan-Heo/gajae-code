import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Settings } from "../src/config/settings";
import { SessionManager } from "../src/session/session-manager";
import type { ToolSession } from "../src/tools";
import { BashTool } from "../src/tools/bash";

const WINDOWS_HINT = "This host is Windows, but this tool runs a bash-compatible shell";

const originalPlatform = Object.getOwnPropertyDescriptor(process, "platform");
const tempDirs: string[] = [];

function setPlatform(platform: NodeJS.Platform): void {
	Object.defineProperty(process, "platform", { configurable: true, value: platform });
}

async function bashDescriptionOn(platform: NodeJS.Platform): Promise<string> {
	const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-bash-hint-"));
	tempDirs.push(cwd);
	const owner = SessionManager.create(cwd, SessionManager.explicitDestination(cwd));
	const session: ToolSession = {
		cwd,
		hasUI: false,
		getSessionId: () => owner.getSessionId(),
		getSessionFile: () => owner.getSessionFile() ?? null,
		getSessionSpawns: () => "*",
		getArtifactsDir: () => owner.getArtifactsDir(),
		getArtifactManager: () => owner.getArtifactManager(),
		captureArtifactPublication: () => owner.captureArtifactPublication(),
		settings: Settings.isolated(),
	};
	setPlatform(platform);
	try {
		return new BashTool(session).description;
	} finally {
		if (originalPlatform) Object.defineProperty(process, "platform", originalPlatform);
	}
}

afterEach(async () => {
	if (originalPlatform) Object.defineProperty(process, "platform", originalPlatform);
	await Promise.all(tempDirs.splice(0).map(dir => fs.rm(dir, { recursive: true, force: true })));
});

describe("bash tool description shell hint", () => {
	it("tells the model to use bash syntax on Windows", async () => {
		const description = await bashDescriptionOn("win32");
		expect(description).toContain(WINDOWS_HINT);
		expect(description).toContain("not PowerShell or cmd");
	});

	it("omits the Windows hint on other platforms", async () => {
		for (const platform of ["linux", "darwin"] as const) {
			const description = await bashDescriptionOn(platform);
			expect(description).not.toContain(WINDOWS_HINT);
		}
	});
});
