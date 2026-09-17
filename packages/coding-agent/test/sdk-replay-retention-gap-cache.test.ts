import { expect, test } from "bun:test";
import {
	REPLAY_CONCESSION_CACHE_LIMIT,
	rememberReplayRetentionGap,
} from "../src/sdk/router/replay-retention-gap-cache";

test("replay retention-gap memo dedupes repeats and stays bounded", () => {
	const cache = new Map<string, number>();
	expect(rememberReplayRetentionGap(cache, "stream-a:1-1")).toBeUndefined();
	expect(rememberReplayRetentionGap(cache, "stream-a:1-1")).toBe(1);
	expect(cache.size).toBe(1);

	for (let index = 0; index < REPLAY_CONCESSION_CACHE_LIMIT; index++)
		rememberReplayRetentionGap(cache, `stream-${index}:1-${index + 1}`);

	expect(cache.size).toBe(REPLAY_CONCESSION_CACHE_LIMIT);
	expect(cache.has("stream-a:1-1")).toBe(false);
	expect(rememberReplayRetentionGap(cache, "stream-a:1-1")).toBeUndefined();
	expect(cache.size).toBe(REPLAY_CONCESSION_CACHE_LIMIT);
});
