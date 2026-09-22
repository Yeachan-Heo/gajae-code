import { describe, expect, it } from "bun:test";
import { getEmbeddedDefaultGjcSkills } from "@gajae-code/coding-agent/defaults/gjc-defaults";
import { InternalUrlRouter } from "@gajae-code/coding-agent/internal-urls";
import { splitInternalUrlSel } from "@gajae-code/coding-agent/tools/path-utils";
import { normalizeInternalUrlInput } from "../../src/internal-urls/parse";

describe("embedded: protocol", () => {
	it("resolves the exact filePath the skill registry reports for a bundled skill", async () => {
		const ultragoal = getEmbeddedDefaultGjcSkills().find(skill => skill.name === "ultragoal");
		expect(ultragoal?.filePath).toBe("embedded:gjc/skills/ultragoal/SKILL.md");

		const resource = await InternalUrlRouter.instance().resolve(ultragoal!.filePath);
		expect(resource.contentType).toBe("text/markdown");
		expect(resource.content).toBe(await ultragoal!.loadContent!());
		expect(resource.content.length).toBeGreaterThan(0);
		expect(resource.immutable).toBe(true);
	});

	it("accepts the baseDir identifier and the slashed spelling", async () => {
		const router = InternalUrlRouter.instance();
		const viaBaseDir = await router.resolve("embedded:gjc/skills/ultragoal");
		const viaSlashes = await router.resolve("embedded://gjc/skills/ultragoal/SKILL.md");
		expect(viaBaseDir.content).toBe(viaSlashes.content);
	});

	it("resolves bundled skill fragments", async () => {
		const resource = await InternalUrlRouter.instance().resolve(
			"embedded:gjc/skill-fragments/ultragoal/ai-slop-cleaner.md",
		);
		expect(resource.content.length).toBeGreaterThan(0);
	});

	it("routes both spellings and rejects unknown resources", async () => {
		const router = InternalUrlRouter.instance();
		expect(router.canHandle("embedded:gjc/skills/ultragoal/SKILL.md")).toBe(true);
		expect(router.canHandle("embedded://gjc/skills/ultragoal/SKILL.md")).toBe(true);
		expect(router.canHandle("embedded:")).toBe(true);
		await expect(router.resolve("embedded:gjc/skills/nope/SKILL.md")).rejects.toThrow(/Unknown embedded resource/);
		await expect(router.resolve("embedded:other/thing.md")).rejects.toThrow(/Unknown embedded namespace/);
		await expect(router.resolve("embedded:gjc/skills/../../etc/passwd")).rejects.toThrow(/traversal/);
	});

	it("splits trailing line selectors off the embedded path", () => {
		expect(normalizeInternalUrlInput("embedded:gjc/skills/ultragoal/SKILL.md")).toBe(
			"embedded://gjc/skills/ultragoal/SKILL.md",
		);
		expect(splitInternalUrlSel("embedded://gjc/skills/ultragoal/SKILL.md")).toEqual({
			path: "embedded://gjc/skills/ultragoal/SKILL.md",
		});
		expect(splitInternalUrlSel("embedded://gjc/skills/ultragoal/SKILL.md:10-20")).toEqual({
			path: "embedded://gjc/skills/ultragoal/SKILL.md",
			sel: "10-20",
		});
	});
});
