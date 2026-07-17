/**
 * G003 adversarial QA for ExtensionRunner O(1) index + cancellable timers.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { ModelRegistry } from "@gajae-code/coding-agent/config/model-registry";
import { discoverAndLoadExtensions } from "@gajae-code/coding-agent/extensibility/extensions/loader";
import {
	EXTENSION_HANDLER_TIMEOUT_MS,
	ExtensionRunner,
	testSetExtensionHandlerTimeoutMs,
} from "@gajae-code/coding-agent/extensibility/extensions/runner";
import { AuthStorage } from "@gajae-code/coding-agent/session/auth-storage";
import { SessionManager } from "@gajae-code/coding-agent/session/session-manager";
import { getProjectAgentDir, logger, TempDir } from "@gajae-code/utils";

describe("G003 ExtensionRunner red-team", () => {
	let tempDir: TempDir;
	let extensionsDir: string;
	let sessionManager: SessionManager;
	let modelRegistry: ModelRegistry;
	let authStorage: AuthStorage;

	beforeEach(async () => {
		tempDir = TempDir.createSync("@g003-redteam-");
		extensionsDir = path.join(getProjectAgentDir(tempDir.path()), "extensions");
		fs.mkdirSync(extensionsDir, { recursive: true });
		sessionManager = SessionManager.inMemory();
		authStorage = await AuthStorage.create(path.join(tempDir.path(), "testauth.db"));
		modelRegistry = new ModelRegistry(authStorage);
	});

	afterEach(() => {
		testSetExtensionHandlerTimeoutMs(EXTENSION_HANDLER_TIMEOUT_MS);
		authStorage.close();
		tempDir.removeSync();
	});

	const loadTestExtensions = async (configuredPaths: string[] = []) => {
		const result = await discoverAndLoadExtensions([extensionsDir, ...configuredPaths], tempDir.path());
		const testRoots = [
			extensionsDir,
			...configuredPaths.map(configuredPath => path.resolve(tempDir.path(), configuredPath)),
		];
		const isTestScoped = (candidate: string): boolean =>
			testRoots.some(root => {
				const relative = path.relative(path.resolve(root), path.resolve(candidate));
				return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
			});
		return {
			...result,
			extensions: result.extensions.filter(extension => isTestScoped(extension.path)),
			errors: result.errors.filter(error => isTestScoped(error.path)),
		};
	};

	const createRunner = async (configuredPaths: string[] = []) => {
		const result = await loadTestExtensions(configuredPaths);
		expect(result.errors).toEqual([]);
		return new ExtensionRunner(result.extensions, result.runtime, tempDir.path(), sessionManager, modelRegistry);
	};

	it("runs same-event handlers strictly by extension order, then registration order", async () => {
		const orderPath = path.join(tempDir.path(), "order.json");
		fs.writeFileSync(orderPath, "[]");
		const extensionCode = (label: string) => `
			import * as fs from "node:fs";

			const append = (value) => {
				const order = JSON.parse(fs.readFileSync(${JSON.stringify(orderPath)}, "utf8"));
				order.push(value);
				fs.writeFileSync(${JSON.stringify(orderPath)}, JSON.stringify(order));
			};

			export default function(pi) {
				pi.on("session_start", async () => append("${label}:first"));
				pi.on("session_start", async () => append("${label}:second"));
			}
		`;
		const extA = path.join(tempDir.path(), "01-order-a.ts");
		const extB = path.join(tempDir.path(), "02-order-b.ts");
		fs.writeFileSync(extA, extensionCode("a"));
		fs.writeFileSync(extB, extensionCode("b"));
		const runner = await createRunner([extA, extB]);

		const result = await runner.emit({ type: "session_start" });

		expect(result).toBeUndefined();
		expect(JSON.parse(fs.readFileSync(orderPath, "utf8"))).toEqual(["a:first", "a:second", "b:first", "b:second"]);
	});

	it("returns no-op values and does not create a context when an event has zero handlers", async () => {
		const runner = await createRunner();
		const createContextSpy = vi.spyOn(runner, "createContext");

		expect(await runner.emit({ type: "session_start" })).toBeUndefined();
		expect(
			await runner.emitToolResult({
				type: "tool_result",
				toolName: "missing_handlers",
				toolCallId: "call-zero",
				input: {},
				content: [{ type: "text", text: "base" }],
				details: { original: true },
				isError: false,
			}),
		).toBeUndefined();
		expect(await runner.emitResourcesDiscover(tempDir.path(), "startup")).toEqual({
			skillPaths: [],
			promptPaths: [],
			themePaths: [],
		});
		expect(createContextSpy).not.toHaveBeenCalled();
	});

	it("does not time out a fast handler, but times out a slow handler and returns undefined", async () => {
		const fastPath = path.join(tempDir.path(), "fast-session-start.ts");
		fs.writeFileSync(
			fastPath,
			`
				export default function(pi) {
					pi.on("session_start", async () => "fast-ok");
				}
			`,
		);
		const fastRunner = await createRunner([fastPath]);
		const fastErrors: Array<{ event: string; error: string }> = [];
		fastRunner.onError(error => fastErrors.push(error));
		testSetExtensionHandlerTimeoutMs(20);

		expect(await fastRunner.emit({ type: "session_start" })).toBeUndefined();
		await Bun.sleep(30);
		expect(fastErrors).toEqual([]);

		testSetExtensionHandlerTimeoutMs(10);
		const slowPath = path.join(tempDir.path(), "slow-session-before-branch.ts");
		fs.writeFileSync(
			slowPath,
			`
				export default function(pi) {
					pi.on("session_before_branch", async () => {
						await new Promise(resolve => setTimeout(resolve, 50));
						return { cancel: true, reason: "too late" };
					});
				}
			`,
		);
		const slowRunner = await createRunner([slowPath]);
		const warnSpy = vi.spyOn(logger, "warn").mockImplementation(() => {});
		const slowErrors: Array<{ extensionPath: string; event: string; error: string }> = [];
		slowRunner.onError(error => slowErrors.push(error));

		const slowResult = await slowRunner.emit({
			type: "session_before_branch",
			entryId: "entry-1",
		});

		expect(slowResult).toBeUndefined();
		expect(slowErrors).toEqual([
			{
				extensionPath: slowPath,
				event: "session_before_branch",
				error: "handler timed out after 10ms",
			},
		]);
		expect(warnSpy).toHaveBeenCalledWith("Extension handler timed out", {
			extensionPath: slowPath,
			event: "session_before_branch",
			timeoutMs: 10,
		});
		warnSpy.mockRestore();
	});

	it("aggregates tool_result modifications in strict handler order", async () => {
		const extensionCode = (label: string, detailsKey: string) => `
			export default function(pi) {
				pi.on("tool_result", async (event) => ({
					content: [...event.content, { type: "text", text: "${label}" }],
					details: { ...event.details, ${detailsKey}: true },
				}));
			}
		`;
		const extA = path.join(tempDir.path(), "01-tool-result-a.ts");
		const extB = path.join(tempDir.path(), "02-tool-result-b.ts");
		fs.writeFileSync(extA, extensionCode("a", "a"));
		fs.writeFileSync(extB, extensionCode("b", "b"));
		const runner = await createRunner([extA, extB]);

		const result = await runner.emitToolResult({
			type: "tool_result",
			toolName: "tool",
			toolCallId: "call-aggregation",
			input: {},
			content: [{ type: "text", text: "base" }],
			details: { base: true },
			isError: false,
		});

		expect(result).toEqual({
			content: [
				{ type: "text", text: "base" },
				{ type: "text", text: "a" },
				{ type: "text", text: "b" },
			],
			details: { base: true, a: true, b: true },
			isError: false,
		});
	});
});
