import { afterEach, beforeAll, describe, expect, test } from "bun:test";
import { AuthStorage, OAuthCredentialSelectorError, SqliteAuthCredentialStore } from "@gajae-code/ai/core";
import type { OAuthSelectorComponent } from "../src/modes/components/oauth-selector";
import { SelectorController } from "../src/modes/controllers/selector-controller";
import { setThemeInstance } from "../src/modes/theme/theme";
import { SharedControlPublicationError } from "../src/session/agent-session";
import { loadTestTheme } from "./helpers/test-theme";

const stores: SqliteAuthCredentialStore[] = [];

beforeAll(async () => {
	const theme = await loadTestTheme();
	setThemeInstance(theme);
});

function createContext(
	authStorage: AuthStorage,
	setCredentialPin: (provider: string, selector: { kind: "id"; value: string }) => Promise<void>,
	showError: (message: string) => void,
	showStatus: (message: string) => void,
	setCredentialAuto: (provider: string) => Promise<void> = async () => {},
) {
	return {
		isStopped: () => false,
		session: {
			credentialSessionId: "session-1",
			modelRegistry: {
				authStorage,
				getModelProfiles: () => new Map(),
			},
			setCredentialPin,
			setCredentialAuto,
		},
		showError,
		showStatus,
	};
}

async function createAuthStorage(): Promise<AuthStorage> {
	const store = await SqliteAuthCredentialStore.open(":memory:");
	stores.push(store);
	const authStorage = new AuthStorage(store);
	await authStorage.set("anthropic", [
		{
			type: "oauth",
			access: "access-token",
			refresh: "refresh-token",
			expires: Date.now() + 60_000,
			email: "account@example.test",
		},
	]);
	return authStorage;
}

afterEach(() => {
	for (const store of stores.splice(0)) store.close();
});

describe("interactive OAuth credential pinning", () => {
	test("handles a missing pin target without closing the selector or rejecting", async () => {
		const authStorage = await createAuthStorage();
		const message = "No stored OAuth credential matches id:999. Run /login or choose AUTO.";
		const errors: string[] = [];
		const unhandled: unknown[] = [];
		const onUnhandled = (error: unknown) => unhandled.push(error);
		process.on("unhandledRejection", onUnhandled);
		let component: OAuthSelectorComponent | undefined;
		let done = false;
		const context = createContext(
			authStorage,
			async () => {
				throw new OAuthCredentialSelectorError("not-found", "anthropic", { kind: "id", value: "999" }, message);
			},
			text => errors.push(text),
			() => {},
		);
		const controller = new SelectorController(context as never);
		controller.showSelector = ((create: (done: () => void) => { component: unknown; focus: unknown }) => {
			component = create(() => {
				done = true;
			}).component as OAuthSelectorComponent;
		}) as never;

		await controller.showOAuthSelector("login", "anthropic");
		const submit = (component?.children[4] as { onSubmit?: () => void } | undefined)?.onSubmit;
		if (!submit) throw new Error("test setup failed: selector input missing");
		submit();
		await Bun.sleep(0);
		process.off("unhandledRejection", onUnhandled);

		expect(errors).toEqual([message]);
		expect(unhandled).toEqual([]);
		expect(done).toBe(false);
		expect(component).toBeDefined();
	});

	test("closes the selector and reports success for a valid pin", async () => {
		const authStorage = await createAuthStorage();
		const errors: string[] = [];
		const statuses: string[] = [];
		let component: OAuthSelectorComponent | undefined;
		let done = false;
		const context = createContext(
			authStorage,
			async () => {},
			text => errors.push(text),
			text => statuses.push(text),
		);
		const controller = new SelectorController(context as never);
		controller.showSelector = ((create: (done: () => void) => { component: unknown; focus: unknown }) => {
			component = create(() => {
				done = true;
			}).component as OAuthSelectorComponent;
		}) as never;

		await controller.showOAuthSelector("login", "anthropic");
		const submit = (component?.children[4] as { onSubmit?: () => void } | undefined)?.onSubmit;
		if (!submit) throw new Error("test setup failed: selector input missing");
		submit();
		await Bun.sleep(0);

		expect(errors).toEqual([]);
		expect(done).toBe(true);
		expect(statuses).toEqual(["Pinned OAuth account for anthropic to this session."]);
	});

	// A refused shared write (#7824) used to escape the `void` selector callback as an
	// unhandled rejection that the crash handler recorded as a fatal GJC crash.
	for (const target of ["pin", "auto"] as const) {
		test(`reports a refused shared ${target} write without an unhandled rejection`, async () => {
			const authStorage = await createAuthStorage();
			const refused = () =>
				Promise.reject(
					new SharedControlPublicationError("change credential selection", {
						kind: "stale",
						reason: "transcript_moved",
					} as never),
				);
			const errors: string[] = [];
			const statuses: string[] = [];
			const unhandled: unknown[] = [];
			const onUnhandled = (error: unknown) => unhandled.push(error);
			process.on("unhandledRejection", onUnhandled);
			let component: OAuthSelectorComponent | undefined;
			let done = false;
			const context = createContext(
				authStorage,
				target === "pin" ? refused : async () => {},
				text => errors.push(text),
				text => statuses.push(text),
				target === "auto" ? refused : async () => {},
			);
			const controller = new SelectorController(context as never);
			controller.showSelector = ((create: (done: () => void) => { component: unknown; focus: unknown }) => {
				component = create(() => {
					done = true;
				}).component as OAuthSelectorComponent;
			}) as never;

			await controller.showOAuthSelector("login", "anthropic");
			if (!component) throw new Error("test setup failed: selector missing");
			if (target === "auto") component.handleInput("\x1b[B");
			const submit = (component.children[4] as { onSubmit?: () => void } | undefined)?.onSubmit;
			if (!submit) throw new Error("test setup failed: selector input missing");
			submit();
			await Bun.sleep(0);
			await Bun.sleep(0);
			process.off("unhandledRejection", onUnhandled);

			expect(unhandled).toEqual([]);
			expect(errors).toHaveLength(1);
			expect(errors[0]).toContain("change credential selection");
			expect(statuses).toEqual([]);
			expect(done).toBe(false);
		});
	}
});
