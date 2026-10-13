import type { ModelRegistry } from "../../src/config/model-registry";

/**
 * Consumer-lease contract for static registry test doubles that never publish
 * configuration. Lease/publication concurrency tests must use a real ModelRegistry.
 */
export const testModelRegistryConsumerLease: Pick<ModelRegistry, "withConsumerLease"> = {
	async withConsumerLease<T>(body: () => T | Promise<T>, signal?: AbortSignal): Promise<T> {
		signal?.throwIfAborted();
		return await body();
	},
};
