import { expect, test } from "bun:test";
import { ExtensionRunner } from "../src/extensibility/extensions/runner";
import { getSdkControlAuthority } from "../src/extensibility/extensions/sdk-control-authority";
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
type ProjectionAuthority = NonNullable<ReturnType<typeof getSdkControlAuthority>>;

function authorityFor(context: ProjectionContext): ProjectionAuthority {
	const authority = getSdkControlAuthority(context.sdkControl);
	if (!authority) throw new Error("Projection authority was not installed.");
	return authority;
}

function createControllerContext(): { context: ProjectionContext; authority: ProjectionAuthority } {
	const sessionManager = SessionManager.inMemory();
	const runner = new ExtensionRunner([], {} as never, process.cwd(), sessionManager, {} as never);
	const session = { extensionRunner: runner, sessionManager };
	const controller = new ExtensionUiController({
		session,
		sessionManager,
	} as never);
	controller.initializeHookRunner({} as ExtensionUIContext, false);
	const context = runner.createContext();
	return { context, authority: authorityFor(context) };
}

async function createRuntimeInitContext(): Promise<{ context: ProjectionContext; authority: ProjectionAuthority }> {
	const sessionManager = SessionManager.inMemory();
	const runner = new ExtensionRunner([], {} as never, process.cwd(), sessionManager, {} as never);
	await initializeExtensions(
		{ extensionRunner: runner, sessionManager, getWorkflowGateEmitter: () => undefined } as never,
		{
			reportSendError: () => {},
			reportRuntimeError: () => {},
		},
	);
	const context = runner.createContext();
	return { context, authority: authorityFor(context) };
}

async function assertProjectionAuthority(fixture: {
	context: ProjectionContext;
	authority: ProjectionAuthority;
}): Promise<void> {
	const sdkControl = fixture.context.sdkControl;
	if (!sdkControl) throw new Error("sdkControl was not installed.");

	await expect(sdkControl("projection.append", { envelope })).rejects.toMatchObject({ code: "forbidden" });
	await expect(sdkControl("projection.read", {})).rejects.toMatchObject({ code: "forbidden" });
	await expect(sdkControl("projection.read", {}, fixture.authority)).resolves.toEqual({ records: [], revision: 0 });
	await expect(sdkControl("projection.append", { envelope }, fixture.authority)).resolves.toEqual({
		entryId: expect.any(String),
		revision: 1,
	});
}

test("controller seam rejects extension projection forgery and accepts only its authority", async () => {
	await assertProjectionAuthority(createControllerContext());
});

test("runtime-init seam rejects extension projection forgery and accepts only its authority", async () => {
	await assertProjectionAuthority(await createRuntimeInitContext());
});
