/**
 * Regression test for issue #4718 (Phase A): extension loader activation
 * transaction.
 *
 * `pi.registerFlag(..., { default })` and `pi.registerProvider(...)` used to
 * mutate the shared `ExtensionRuntime` state directly, with no rollback. A
 * factory that threw midway was discarded, but its shared-state side effects
 * leaked: flag defaults stayed readable and provider registrations stayed
 * queued for the ModelRegistry drain, activating providers from extensions
 * that never activated.
 *
 * The activation transaction stages those writes per factory invocation and
 * commits only when the factory completes; rollback discards them.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { loadExtensionFromFactory, loadExtensions } from "../src/extensibility/extensions/loader";
import { EventBus } from "../src/utils/event-bus";

let tmp: string;

beforeEach(async () => {
	tmp = await fs.mkdtemp(path.join(os.tmpdir(), "issue-4718-"));
});

afterEach(async () => {
	await fs.rm(tmp, { recursive: true, force: true });
});

const failingFactorySource = `
export default function (pi) {
	pi.registerFlag("--leaky-flag", { type: "boolean", default: true });
	pi.registerProvider("leaky-provider", {
		baseUrl: "https://example.com/v1",
		api: "openai-completions",
		apiKey: "literal-key",
	});
	throw new Error("factory failed midway");
};
`;

const succeedingFactorySource = `
export default function (pi) {
	pi.registerFlag("--good-flag", { type: "boolean", default: true });
	pi.registerProvider("good-provider", {
		baseUrl: "https://example.com/v1",
		api: "openai-completions",
		apiKey: "literal-key",
	});
};
`;

describe("issue #4718: loader activation transaction", () => {
	test("a factory that throws leaves no flag default or provider registration behind", async () => {
		await fs.writeFile(path.join(tmp, "bad.ts"), failingFactorySource);
		await fs.writeFile(path.join(tmp, "good.ts"), succeedingFactorySource);

		const result = await loadExtensions([path.join(tmp, "bad.ts"), path.join(tmp, "good.ts")], tmp, new EventBus());

		expect(result.errors).toHaveLength(1);
		expect(result.errors[0]?.error).toContain("factory failed midway");
		expect(result.extensions.map(extension => extension.path)).toEqual([path.join(tmp, "good.ts")]);

		// Shared runtime must not keep the failed extension's staged writes.
		expect(result.runtime.flagValues.get("--leaky-flag")).toBeUndefined();
		const registered = result.runtime.pendingProviderRegistrations.map(registration => registration.name);
		expect(registered).toEqual(["good-provider"]);
	});

	test("a failing factory does not clobber earlier committed state", async () => {
		await fs.writeFile(path.join(tmp, "good.ts"), succeedingFactorySource);
		await fs.writeFile(path.join(tmp, "bad.ts"), failingFactorySource);

		const result = await loadExtensions([path.join(tmp, "good.ts"), path.join(tmp, "bad.ts")], tmp, new EventBus());

		expect(result.errors).toHaveLength(1);
		expect(result.runtime.flagValues.get("--good-flag")).toBe(true);
		expect(result.runtime.pendingProviderRegistrations.map(r => r.name)).toEqual(["good-provider"]);
	});

	test("staged writes are invisible to the shared runtime until commit", async () => {
		await fs.writeFile(path.join(tmp, "bad.ts"), failingFactorySource);

		const eventBus = new EventBus();
		const runtimePromise = loadExtensions([path.join(tmp, "bad.ts")], tmp, eventBus);

		// While (and after) the failed factory ran, nothing was committed.
		const result = await runtimePromise;
		expect(result.errors).toHaveLength(1);
		expect(result.runtime.flagValues.size).toBe(0);
		expect(result.runtime.pendingProviderRegistrations).toHaveLength(0);
	});

	test("inline factory failure rolls back staged writes", async () => {
		const runtime = {
			flagValues: new Map<string, boolean | string>(),
			pendingProviderRegistrations: [] as { name: string; config: unknown; sourceId: string }[],
		} as never;

		await expect(
			loadExtensionFromFactory(
				pi => {
					pi.registerFlag("--inline-flag", { type: "boolean", default: true });
					pi.registerProvider("inline-provider", {
						baseUrl: "https://example.com/v1",
						api: "openai-completions",
						apiKey: "literal-key",
					});
					throw new Error("inline factory failed");
				},
				tmp,
				new EventBus(),
				runtime,
				"<inline-test>",
			),
		).rejects.toThrow("inline factory failed");

		expect((runtime as { flagValues: Map<string, unknown> }).flagValues.size).toBe(0);
		expect((runtime as { pendingProviderRegistrations: unknown[] }).pendingProviderRegistrations.length).toBe(0);
	});

	test("inline factory success commits staged writes", async () => {
		const runtime = {
			flagValues: new Map<string, boolean | string>(),
			pendingProviderRegistrations: [] as { name: string; config: unknown; sourceId: string }[],
		} as never;

		const extension = await loadExtensionFromFactory(
			pi => {
				pi.registerFlag("--inline-ok", { type: "boolean", default: true });
			},
			tmp,
			new EventBus(),
			runtime,
			"<inline-ok>",
		);

		expect(extension.flags.has("--inline-ok")).toBe(true);
		expect((runtime as { flagValues: Map<string, unknown> }).flagValues.get("--inline-ok")).toBe(true);
	});

	test("getFlag reads the factory's own staged default during activation", async () => {
		let observed: unknown = "unset";
		const runtime = {
			flagValues: new Map<string, boolean | string>(),
			pendingProviderRegistrations: [] as { name: string; config: unknown; sourceId: string }[],
		} as never;

		await loadExtensionFromFactory(
			pi => {
				pi.registerFlag("--visible", { type: "boolean", default: true });
				observed = pi.getFlag("--visible");
			},
			tmp,
			new EventBus(),
			runtime,
			"<self-read>",
		);

		expect(observed).toBe(true);
	});
	test("a failed factory does not overwrite a committed flag default sharing the same name", async () => {
		const runtime = {
			flagValues: new Map<string, boolean | string>(),
			pendingProviderRegistrations: [] as { name: string; config: unknown; sourceId: string }[],
		} as never;

		await loadExtensionFromFactory(
			pi => {
				pi.registerFlag("--shared", { type: "string", default: "first" });
			},
			tmp,
			new EventBus(),
			runtime,
			"<first>",
		);

		await expect(
			loadExtensionFromFactory(
				pi => {
					pi.registerFlag("--shared", { type: "string", default: "second" });
					throw new Error("second factory failed");
				},
				tmp,
				new EventBus(),
				runtime,
				"<second>",
			),
		).rejects.toThrow("second factory failed");

		expect((runtime as { flagValues: Map<string, unknown> }).flagValues.get("--shared")).toBe("first");
	});

	test("a failed factory does not shadow a committed provider registration of the same name", async () => {
		const runtime = {
			flagValues: new Map<string, boolean | string>(),
			pendingProviderRegistrations: [] as { name: string; config: unknown; sourceId: string }[],
		} as never;

		await loadExtensionFromFactory(
			pi => {
				pi.registerProvider("shared-provider", {
					baseUrl: "https://example.com/v1",
					api: "openai-completions",
					apiKey: "literal-key",
				});
			},
			tmp,
			new EventBus(),
			runtime,
			"<first>",
		);

		await expect(
			loadExtensionFromFactory(
				pi => {
					pi.registerProvider("shared-provider", {
						baseUrl: "https://other.example.com/v1",
						api: "openai-completions",
						apiKey: "literal-key",
					});
					throw new Error("override factory failed");
				},
				tmp,
				new EventBus(),
				runtime,
				"<second>",
			),
		).rejects.toThrow("override factory failed");

		const staged = (runtime as { pendingProviderRegistrations: Array<{ name: string; sourceId: string }> })
			.pendingProviderRegistrations;
		expect(staged).toHaveLength(1);
		expect(staged[0]?.name).toBe("shared-provider");
		expect(staged[0]?.sourceId).toBe("<first>");
	});

	test("a successful later factory still observes committed defaults from earlier factories", async () => {
		const runtime = {
			flagValues: new Map<string, boolean | string>(),
			pendingProviderRegistrations: [] as { name: string; config: unknown; sourceId: string }[],
		} as never;

		await loadExtensionFromFactory(
			pi => {
				pi.registerFlag("--earlier", { type: "string", default: "committed" });
			},
			tmp,
			new EventBus(),
			runtime,
			"<earlier>",
		);

		let observed: unknown;
		await loadExtensionFromFactory(
			pi => {
				pi.registerFlag("--earlier", { type: "string" });
				observed = pi.getFlag("--earlier");
			},
			tmp,
			new EventBus(),
			runtime,
			"<later>",
		);

		expect(observed).toBe("committed");
	});

	test("a throwing import-time module failure reports the error and leaves no state behind", async () => {
		await fs.writeFile(
			path.join(tmp, "broken.ts"),
			"throw new Error('import-time failure');\nexport default function () {}\n",
		);

		const result = await loadExtensions([path.join(tmp, "broken.ts")], tmp, new EventBus());

		expect(result.errors).toHaveLength(1);
		expect(result.extensions).toHaveLength(0);
		expect(result.runtime.flagValues.size).toBe(0);
		expect(result.runtime.pendingProviderRegistrations).toHaveLength(0);
	});
});
