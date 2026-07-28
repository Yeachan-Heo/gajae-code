import { expect, test } from "bun:test";
import { ExtensionRunner } from "../src/extensibility/extensions/runner";
import type { ExtensionUIContext } from "../src/extensibility/extensions/types";
import { ExtensionUiController } from "../src/modes/controllers/extension-ui-controller";
import { initializeExtensions } from "../src/modes/runtime-init";
import { SessionManager } from "../src/session/session-manager";

const envelope = {
	schemaVersion: 1,
	recordKind: "forged",
	sourceKey: "extension-forge",
	payload: {},
};

type ProjectionContext = NonNullable<ReturnType<ExtensionRunner["createContext"]>>;

function createControllerContext(): ProjectionContext {
	const sessionManager = SessionManager.inMemory();
	const runner = new ExtensionRunner([], {} as never, process.cwd(), sessionManager, {} as never);
	const session = { extensionRunner: runner, sessionManager };
	const controller = new ExtensionUiController({
		session,
		sessionManager,
	} as never);
	controller.initializeHookRunner({} as ExtensionUIContext, false);
	return runner.createContext();
}

async function createRuntimeInitContext(): Promise<ProjectionContext> {
	const sessionManager = SessionManager.inMemory();
	const runner = new ExtensionRunner([], {} as never, process.cwd(), sessionManager, {} as never);
	await initializeExtensions(
		{ extensionRunner: runner, sessionManager, getWorkflowGateEmitter: () => undefined } as never,
		{
			reportSendError: () => {},
			reportRuntimeError: () => {},
		},
	);
	return runner.createContext();
}

async function assertExtensionCannotForgeProjection(context: ProjectionContext): Promise<void> {
	const sdkControl = context.sdkControl;
	if (!sdkControl) throw new Error("sdkControl was not installed.");

	// Probe every value an extension can recover from its context, the projection module exports,
	// and forged opaque values. The capability object itself is held only in the SDK bus closure.
	const exportedValues: unknown[] = [];
	const modulePaths = [
		"../src/session/app-server-projection",
		// Assembled at runtime on purpose: this module was deleted with the token design, so a
		// static specifier would fail to resolve at parse time instead of probing for it.
		["..", "src", "extensibility", "extensions", "sdk-control-authority"].join("/"),
	];
	for (const modulePath of modulePaths) {
		try {
			const exportedModule = (await import(modulePath)) as Record<string, unknown>;
			for (const exported of Object.values(exportedModule)) {
				if (typeof exported !== "function") continue;
				const argumentSets =
					exported.length >= 3
						? [[context.sessionManager, envelope]]
						: exported.length >= 2
							? [
									[context.sessionManager, 0],
									[context.sessionManager, envelope],
								]
							: exported.length === 1
								? [[context.sdkControl]]
								: [[]];
				for (const args of argumentSets) {
					try {
						const result = (exported as (...args: unknown[]) => unknown)(...args);
						exportedValues.push(
							result && typeof (result as Promise<unknown>).then === "function" ? await result : result,
						);
					} catch {
						// Extension-held read-only values cannot satisfy a persistence capability.
					}
				}
			}
		} catch {
			// The legacy authority module is intentionally absent; the capability module is type-only at runtime.
		}
	}

	const reachableValues: unknown[] = [];
	const seen = new Set<object>();
	const collectReachable = (value: unknown, depth: number): void => {
		if ((typeof value !== "object" && typeof value !== "function") || value === null || seen.has(value)) return;
		seen.add(value);
		const children = [...Object.values(value as Record<string, unknown>), ...Object.getOwnPropertySymbols(value)];
		reachableValues.push(...children);
		if (depth < 1) for (const child of children) collectReachable(child, depth + 1);
	};
	collectReachable(context, 0);

	const visibleValues = [...exportedValues, ...reachableValues, undefined, Symbol("extension-forge")];
	const invoke = sdkControl as unknown as (
		operation: string,
		input: Record<string, unknown>,
		authority?: unknown,
	) => unknown | Promise<unknown>;
	for (const recovered of visibleValues) {
		await expect(invoke("projection.append", { envelope }, recovered)).rejects.toMatchObject({ code: "forbidden" });
		await expect(invoke("projection.read", {}, recovered)).rejects.toMatchObject({ code: "forbidden" });
	}
}

test("controller seam rejects projection forgery recovered by an extension", async () => {
	await assertExtensionCannotForgeProjection(createControllerContext());
});

test("runtime-init seam rejects projection forgery recovered by an extension", async () => {
	await assertExtensionCannotForgeProjection(await createRuntimeInitContext());
});
