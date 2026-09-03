import { describe, expect, test } from "bun:test";
import { fetchModelsDevPayload } from "../src/provider-models/openai-compat";

const CATALOG = { anthropic: { models: {} } };

describe("models.dev catalog fetching", () => {
	test("serves every provider in one discovery window from a single download", async () => {
		let downloads = 0;
		const fetchImpl = (async () => {
			downloads++;
			return new Response(JSON.stringify(CATALOG), {
				status: 200,
				headers: { "content-type": "application/json" },
			});
		}) as unknown as typeof fetch;

		const [first, second, third] = await Promise.all([
			fetchModelsDevPayload(fetchImpl),
			fetchModelsDevPayload(fetchImpl),
			fetchModelsDevPayload(fetchImpl),
		]);
		const fourth = await fetchModelsDevPayload(fetchImpl);

		expect(downloads).toBe(1);
		expect(first).toEqual(CATALOG);
		expect(second).toBe(first);
		expect(third).toBe(first);
		expect(fourth).toBe(first);
	});

	test("does not retain a failed download", async () => {
		let downloads = 0;
		const fetchImpl = (async () => {
			downloads++;
			return downloads === 1
				? new Response("nope", { status: 500 })
				: new Response(JSON.stringify(CATALOG), {
						status: 200,
						headers: { "content-type": "application/json" },
					});
		}) as unknown as typeof fetch;

		await expect(fetchModelsDevPayload(fetchImpl)).rejects.toThrow(/models\.dev fetch failed: 500/);
		await expect(fetchModelsDevPayload(fetchImpl)).resolves.toEqual(CATALOG);
		expect(downloads).toBe(2);
	});

	test("keeps separate fetch implementations isolated", async () => {
		const catalogFor = (name: string) =>
			(async () =>
				new Response(JSON.stringify({ [name]: { models: {} } }), {
					status: 200,
					headers: { "content-type": "application/json" },
				})) as unknown as typeof fetch;

		await expect(fetchModelsDevPayload(catalogFor("alpha"))).resolves.toEqual({ alpha: { models: {} } });
		await expect(fetchModelsDevPayload(catalogFor("beta"))).resolves.toEqual({ beta: { models: {} } });
	});
});
