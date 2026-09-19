/**
 * Retention-gap concessions are durable stream facts, but a Router can observe
 * many streams over its lifetime. Keep the warning memo bounded while retaining
 * enough recent coordinates to suppress reconnect/poll duplicates.
 */
export const REPLAY_CONCESSION_CACHE_LIMIT = 1_024;

/**
 * Records one stream/gap coordinate in an LRU memo.
 *
 * `undefined` means this is the first observation; a number is the duplicate
 * count after the coordinate was already observed.
 */
export function rememberReplayRetentionGap(cache: Map<string, number>, key: string): number | undefined {
	const previous = cache.get(key);
	if (previous !== undefined) {
		cache.delete(key);
		cache.set(key, previous + 1);
		return previous + 1;
	}
	cache.set(key, 0);
	if (cache.size > REPLAY_CONCESSION_CACHE_LIMIT) {
		const oldest = cache.keys().next().value;
		if (oldest !== undefined) cache.delete(oldest);
	}
	return undefined;
}
