/** Drains queued microtask reactions so promise chains settle without advancing timers. */
export async function drainMicrotasks(times = 3): Promise<void> {
	for (let i = 0; i < times; i++) await Promise.resolve();
}
