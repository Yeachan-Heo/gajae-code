import { afterEach, describe, expect, it } from "bun:test";

import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { formatBuildLabel, resolveBuildMetadata } from "../src/build-metadata";

const originalBuildChannel = process.env.GJC_BUILD_CHANNEL;

afterEach(() => {
	if (originalBuildChannel === undefined) {
		delete process.env.GJC_BUILD_CHANNEL;
	} else {
		process.env.GJC_BUILD_CHANNEL = originalBuildChannel;
	}
});

describe("build metadata", () => {
	it("uses explicit release metadata instead of treating compiled release binaries as dev", () => {
		process.env.GJC_BUILD_CHANNEL = "release";

		expect(resolveBuildMetadata("/not/a/source/tree")).toEqual({ channel: "release", label: "release build" });
		expect(formatBuildLabel()).toBe("release build");
	});

	it("uses neutral diagnostic wording for unknown explicit metadata", () => {
		process.env.GJC_BUILD_CHANNEL = "surprise-channel";

		expect(resolveBuildMetadata("/not/a/source/tree")).toEqual({ channel: "unknown", label: "build unknown" });
	});

	it("classifies local source trees as local source without using dev wording", async () => {
		delete process.env.GJC_BUILD_CHANNEL;
		const repoRoot = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-build-metadata-"));
		await fs.mkdir(path.join(repoRoot, ".git"));
		await Bun.write(path.join(repoRoot, "bun.lock"), "");
		await Bun.write(path.join(repoRoot, "package.json"), JSON.stringify({ name: "gajae-code" }));

		expect(resolveBuildMetadata(path.join(repoRoot, "packages/coding-agent/src"))).toEqual({
			channel: "local-source",
			label: "local source",
		});
	});

	it("classifies unmarked user installs as package installs instead of dev", () => {
		delete process.env.GJC_BUILD_CHANNEL;

		expect(resolveBuildMetadata("/opt/homebrew/lib/node_modules/@gajae-code/coding-agent/src")).toEqual({
			channel: "package-install",
			label: "package install",
		});
	});

	it("does not classify package installs inside another Bun repo as local source", async () => {
		delete process.env.GJC_BUILD_CHANNEL;
		const consumerRoot = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-consumer-project-"));
		await fs.mkdir(path.join(consumerRoot, ".git"));
		await Bun.write(path.join(consumerRoot, "bun.lock"), "");
		await Bun.write(path.join(consumerRoot, "package.json"), JSON.stringify({ name: "consumer-app" }));

		expect(resolveBuildMetadata(path.join(consumerRoot, "node_modules/@gajae-code/coding-agent/src"))).toEqual({
			channel: "package-install",
			label: "package install",
		});
	});
});
