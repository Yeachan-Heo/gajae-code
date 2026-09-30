import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
	CLAUDE_NPM_DIST_TAG_URL,
	CLAUDE_RELEASE_CHANNEL_URL,
	createClaudeCodeVersionResolver,
	fetchLatestClaudeCodeVersion,
} from "../src/providers/claude-code-version";

type Responses = Partial<Record<string, string | null>>;

function fakeFetch(responses: Responses): { fetch: (url: string) => Promise<Response>; calls: string[] } {
	const calls: string[] = [];
	return {
		calls,
		fetch: async (url: string) => {
			calls.push(url);
			const body = responses[url];
			return body == null ? new Response("unavailable", { status: 503 }) : new Response(body);
		},
	};
}

const tempDirs: string[] = [];
function tempCachePath(): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "claude-code-version-"));
	tempDirs.push(dir);
	return path.join(dir, "claude-code-version.json");
}

afterEach(() => {
	for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("fetchLatestClaudeCodeVersion", () => {
	it("takes the higher of the release channel and npm dist-tag", async () => {
		const { fetch } = fakeFetch({
			[CLAUDE_RELEASE_CHANNEL_URL]: "2.1.290\n",
			[CLAUDE_NPM_DIST_TAG_URL]: JSON.stringify({ version: "2.1.288" }),
		});
		expect(await fetchLatestClaudeCodeVersion(fetch)).toBe("2.1.290");
	});

	it("uses the surviving source when one fails and returns null when both fail", async () => {
		expect(
			await fetchLatestClaudeCodeVersion(
				fakeFetch({ [CLAUDE_NPM_DIST_TAG_URL]: JSON.stringify({ version: "2.1.300" }) }).fetch,
			),
		).toBe("2.1.300");
		expect(await fetchLatestClaudeCodeVersion(fakeFetch({}).fetch)).toBeNull();
	});
});

describe("createClaudeCodeVersionResolver", () => {
	it("signs with the baseline immediately, then with the fetched latest after refresh, and persists it", async () => {
		const cachePath = tempCachePath();
		const { fetch } = fakeFetch({ [CLAUDE_RELEASE_CHANNEL_URL]: "2.1.300" });
		const resolver = createClaudeCodeVersionResolver({ baseline: "2.1.284", cachePath, fetch });

		expect(resolver.get()).toBe("2.1.284");
		expect(await resolver.refresh()).toBe("2.1.300");
		expect(resolver.get()).toBe("2.1.300");
		expect(JSON.parse(fs.readFileSync(cachePath, "utf-8")).version).toBe("2.1.300");
	});

	it("never signs below the baseline even when upstream or the cache reports an older version", async () => {
		const cachePath = tempCachePath();
		fs.writeFileSync(cachePath, JSON.stringify({ version: "2.1.100", checkedAt: Date.now() }));
		const { fetch } = fakeFetch({ [CLAUDE_RELEASE_CHANNEL_URL]: "2.1.200" });
		const resolver = createClaudeCodeVersionResolver({ baseline: "2.1.284", cachePath, fetch });

		expect(resolver.get()).toBe("2.1.284");
		expect(await resolver.refresh()).toBe("2.1.284");
	});

	it("reuses a fresh disk cache without touching the network", () => {
		const cachePath = tempCachePath();
		fs.writeFileSync(cachePath, JSON.stringify({ version: "2.1.299", checkedAt: 1_000 }));
		const { fetch, calls } = fakeFetch({});
		const resolver = createClaudeCodeVersionResolver({ baseline: "2.1.284", cachePath, fetch, now: () => 2_000 });

		expect(resolver.get()).toBe("2.1.299");
		expect(calls).toEqual([]);
	});

	it("schedules one background refresh when the cache is stale and keeps the cached value on failure", async () => {
		const cachePath = tempCachePath();
		fs.writeFileSync(cachePath, JSON.stringify({ version: "2.1.299", checkedAt: 0 }));
		const { fetch, calls } = fakeFetch({});
		const resolver = createClaudeCodeVersionResolver({
			baseline: "2.1.284",
			cachePath,
			fetch,
			now: () => 10_000,
			refreshIntervalMs: 1_000,
		});

		expect(resolver.get()).toBe("2.1.299");
		expect(resolver.get()).toBe("2.1.299");
		expect(await resolver.refresh()).toBe("2.1.299");
		// Two sources per refresh; the second get() joined the in-flight refresh.
		expect(calls.length).toBe(2);
		expect(resolver.get()).toBe("2.1.299");
		expect(calls.length).toBe(2);
	});

	it("honors an exact pin and ignores malformed pins", async () => {
		const { fetch, calls } = fakeFetch({ [CLAUDE_RELEASE_CHANNEL_URL]: "2.1.300" });
		const pinned = createClaudeCodeVersionResolver({
			baseline: "2.1.284",
			pinned: "2.1.250",
			cachePath: tempCachePath(),
			fetch,
		});
		expect(pinned.get()).toBe("2.1.250");
		expect(await pinned.refresh()).toBe("2.1.250");
		expect(calls).toEqual([]);

		const malformed = createClaudeCodeVersionResolver({
			baseline: "2.1.284",
			pinned: "latest",
			cachePath: null,
			fetch,
		});
		expect(malformed.get()).toBe("2.1.284");
	});
});
