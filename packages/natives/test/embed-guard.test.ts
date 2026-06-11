import { describe, expect, it } from "bun:test";

import { type CandidateAddon, verifyDefaultLanguageSet } from "../scripts/embed-guard";

const candidate: CandidateAddon = { variant: "default", filename: "pi_natives.test.node" };

function verifier(options: {
	platformTag?: string;
	hostPlatformTag?: string;
	sidecar?: { languageSet?: string } | null;
	inProcessLanguageSet?: string;
	warnings?: string[];
}) {
	return verifyDefaultLanguageSet(candidate, "/tmp/pi_natives.test.node", {
		platformTag: options.platformTag ?? "darwin-arm64",
		hostPlatformTag: options.hostPlatformTag ?? "darwin-arm64",
		readBuildSidecar: async () => options.sidecar ?? null,
		loadNativeAddon: () => ({ nativeBuildInfo: () => ({ languageSet: options.inProcessLanguageSet }) }),
		warn: message => options.warnings?.push(message),
	});
}

describe("embed native language-set guard", () => {
	it("rejects a host addon whose stale default sidecar disagrees with in-process build info", async () => {
		await expect(verifier({ sidecar: { languageSet: "default" }, inProcessLanguageSet: "full" })).rejects.toThrow(
			/in-process languageSet is "full"/,
		);
	});

	it("rejects a tampered full-langs sidecar before loading the addon", async () => {
		await expect(verifier({ sidecar: { languageSet: "full" }, inProcessLanguageSet: "default" })).rejects.toThrow(
			/sidecar languageSet is "full"/,
		);
	});

	it("warns and passes when a non-host addon has no sidecar", async () => {
		const warnings: string[] = [];
		await verifier({
			platformTag: "linux-x64",
			hostPlatformTag: "darwin-arm64",
			sidecar: null,
			inProcessLanguageSet: "full",
			warnings,
		});

		expect(warnings).toEqual([
			"Warning: pi_natives.test.node has no build sidecar; skipping in-process languageSet check for non-host platform linux-x64.",
		]);
	});
});
