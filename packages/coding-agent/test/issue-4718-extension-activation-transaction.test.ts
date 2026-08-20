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

	test("staged writes are invisible to the shared runtime while the factory is suspended", async () => {
		const runtime = {
			flagValues: new Map<string, boolean | string>(),
			pendingProviderRegistrations: [] as { name: string; config: unknown; sourceId: string }[],
		} as never;

		const gate = Promise.withResolvers<void>();
		const reachedGate = Promise.withResolvers<void>();

		const loading = loadExtensionFromFactory(
			async pi => {
				pi.registerFlag("--inflight", { type: "boolean", default: true });
				pi.registerProvider("inflight-provider", {
					baseUrl: "https://example.com/v1",
					api: "openai-completions",
					apiKey: "literal-key",
				});
				reachedGate.resolve();
				await gate.promise;
			},
			tmp,
			new EventBus(),
			runtime,
			"<inflight>",
		);

		// The factory has registered but is suspended before commit: the
		// shared runtime must not yet observe either staged write. (Direct
		// mutation would fail this — the value would already be live here.)
		await reachedGate.promise;
		expect((runtime as { flagValues: Map<string, unknown> }).flagValues.get("--inflight")).toBeUndefined();
		expect((runtime as { flagValues: Map<string, unknown> }).flagValues.size).toBe(0);
		expect((runtime as { pendingProviderRegistrations: unknown[] }).pendingProviderRegistrations.length).toBe(0);

		gate.resolve();
		await loading;

		// After commit, both writes are published.
		expect((runtime as { flagValues: Map<string, unknown> }).flagValues.get("--inflight")).toBe(true);
		expect(
			(runtime as { pendingProviderRegistrations: Array<{ name: string }> }).pendingProviderRegistrations.map(
				r => r.name,
			),
		).toEqual(["inflight-provider"]);
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

	test("a retained pi observes post-commit runtime flag overrides (CLI setFlagValue parity)", async () => {
		const runtime = {
			flagValues: new Map<string, boolean | string>(),
			pendingProviderRegistrations: [] as { name: string; config: unknown; sourceId: string }[],
		} as never;

		let retainedGetFlag: ((name: string) => boolean | string | undefined) | undefined;
		await loadExtensionFromFactory(
			pi => {
				pi.registerFlag("--post-commit", { type: "string", default: "default-value" });
				retainedGetFlag = (name: string) => pi.getFlag(name);
			},
			tmp,
			new EventBus(),
			runtime,
			"<retained>",
		);

		// After commit the shared runtime is authoritative.
		expect(retainedGetFlag?.("--post-commit")).toBe("default-value");

		// Runtime-side override after commit — e.g. applyExtensionFlagValues /
		// runner.setFlagValue from parsed CLI args.
		(runtime as { flagValues: Map<string, string> }).flagValues.set("--post-commit", "cli-override");
		expect(retainedGetFlag?.("--post-commit")).toBe("cli-override");

		// A later extension's committed default for the same name is also visible
		// to the earlier extension's retained pi (last-write-wins, base parity).
		await loadExtensionFromFactory(
			pi => {
				pi.registerFlag("--post-commit", { type: "string", default: "second-default" });
			},
			tmp,
			new EventBus(),
			runtime,
			"<second>",
		);
		expect(retainedGetFlag?.("--post-commit")).toBe("second-default");

		// With no committed value at all, the retained pi reports undefined —
		// the closed scope's staged default is not resurrected.
		(runtime as { flagValues: Map<string, string> }).flagValues.delete("--post-commit");
		expect(retainedGetFlag?.("--post-commit")).toBeUndefined();
	});

	test("a fault inside commit leaves no partially published state behind", async () => {
		class FaultingFlagMap extends Map<string, boolean | string> {
			readonly faultKey: string;

			constructor(faultKey: string, entries?: [string, boolean | string][]) {
				super(entries);
				this.faultKey = faultKey;
			}

			override set(key: string, value: boolean | string): this {
				if (key === this.faultKey) throw new Error("injected commit fault");
				return super.set(key, value);
			}
		}

		// A pre-existing committed flag proves overwrite-restore, and the two
		// staged flags prove absent-entry removal (--first publishes, then
		// --second faults: both must end absent).
		const flagValues = new FaultingFlagMap("--second", [["--preexisting", "kept"]]);
		const runtime = {
			flagValues,
			pendingProviderRegistrations: [] as { name: string; config: unknown; sourceId: string }[],
		} as never;

		await expect(
			loadExtensionFromFactory(
				pi => {
					pi.registerFlag("--first", { type: "boolean", default: true });
					pi.registerFlag("--second", { type: "boolean", default: true });
					pi.registerProvider("commit-provider", {
						baseUrl: "https://example.com/v1",
						api: "openai-completions",
						apiKey: "literal-key",
					});
				},
				tmp,
				new EventBus(),
				runtime,
				"<fault>",
			),
		).rejects.toThrow("injected commit fault");

		expect(flagValues.get("--first")).toBeUndefined();
		expect(flagValues.get("--second")).toBeUndefined();
		expect(flagValues.get("--preexisting")).toBe("kept");
		expect((runtime as { pendingProviderRegistrations: unknown[] }).pendingProviderRegistrations).toHaveLength(0);
	});

	test("a fault during provider publication truncates the queue to its prior state", async () => {
		type Registration = { name: string; config: unknown; sourceId: string };
		class FaultingQueue extends Array<Registration> {
			fault = false;

			override push(...items: Registration[]): number {
				if (this.fault) throw new Error("injected queue fault");
				return super.push(...items);
			}
		}

		const queue = new FaultingQueue();
		const runtime = {
			flagValues: new Map<string, boolean | string>(),
			pendingProviderRegistrations: queue,
		} as never;

		// Seed one legitimately committed registration from an earlier factory.
		await loadExtensionFromFactory(
			pi => {
				pi.registerProvider("earlier-provider", {
					baseUrl: "https://example.com/v1",
					api: "openai-completions",
					apiKey: "literal-key",
				});
			},
			tmp,
			new EventBus(),
			runtime,
			"<earlier>",
		);
		expect(queue).toHaveLength(1);

		queue.fault = true;
		await expect(
			loadExtensionFromFactory(
				pi => {
					pi.registerFlag("--queued", { type: "boolean", default: true });
					pi.registerProvider("faulted-provider", {
						baseUrl: "https://example.com/v1",
						api: "openai-completions",
						apiKey: "literal-key",
					});
				},
				tmp,
				new EventBus(),
				runtime,
				"<faulted>",
			),
		).rejects.toThrow("injected queue fault");

		// The flag published before the queue fault must be rolled back, and
		// the queue must hold only the earlier committed registration.
		expect((runtime as { flagValues: Map<string, unknown> }).flagValues.get("--queued")).toBeUndefined();
		expect(queue.map(r => r.name)).toEqual(["earlier-provider"]);

		// The runtime stays usable: a later normal factory commits cleanly.
		queue.fault = false;
		await loadExtensionFromFactory(
			pi => {
				pi.registerFlag("--recovered", { type: "boolean", default: true });
			},
			tmp,
			new EventBus(),
			runtime,
			"<recovered>",
		);
		expect((runtime as { flagValues: Map<string, unknown> }).flagValues.get("--recovered")).toBe(true);
	});
});
