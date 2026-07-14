import { describe, expect, it } from "bun:test";
import type {
	Q10CurrentThinkingLevel,
	Q10Model,
	Q10SettableThinkingLevel,
	Q10ThinkingCapabilities,
	Q10ThinkingEffort,
	Q10ThinkingMode,
} from "@gajae-code/coding-agent/sdk";
import * as publicSdk from "@gajae-code/coding-agent/sdk";
import * as bus from "@gajae-code/coding-agent/sdk/bus";
import packageJson from "../package.json";
import * as root from "../src/index";
import * as sdk from "../src/sdk";
import * as session from "../src/sdk/session";

const q10DtoTypes:
	| [
			Q10Model,
			Q10ThinkingCapabilities,
			Q10ThinkingEffort,
			Q10SettableThinkingLevel,
			Q10CurrentThinkingLevel,
			Q10ThinkingMode,
	  ]
	| undefined = undefined;

void q10DtoTypes;

describe("SDK package exports", () => {
	it("preserves the session SDK surface and bus namespace after the namespace move", () => {
		for (const exportName of Object.keys(session)) expect(sdk).toHaveProperty(exportName);
		expect(sdk).toHaveProperty("bus");
		expect(root).toHaveProperty("createAgentSession");
	});

	it("loads the public SDK and bus package subpaths", () => {
		expect(publicSdk.createAgentSession).toBeFunction();
		expect(bus.createNotificationsExtension).toBeFunction();
	});

	it.each([
		"@gajae-code/coding-agent/sdk/models",
		"@gajae-code/coding-agent/sdk/models.js",
	])("rejects resolution of the private %s subpath", async subpath => {
		const child = Bun.spawn([process.execPath, "-e", `await import(${JSON.stringify(subpath)})`], {
			cwd: import.meta.dir,
			stdout: "pipe",
			stderr: "pipe",
		});
		const [stdout, stderr, exitCode] = await Promise.all([
			new Response(child.stdout).text(),
			new Response(child.stderr).text(),
			child.exited,
		]);
		const output = `${stdout}${stderr}`;

		expect(exitCode).not.toBe(0);
		expect(output).toMatch(/error/i);
		expect(output).toContain(subpath);
	});

	it("exports Q10 DTO types only from the SDK root", () => {
		expect(packageJson.exports["./sdk/models"]).toBeNull();
		expect(packageJson.exports["./sdk/models.js"]).toBeNull();
	});
});
