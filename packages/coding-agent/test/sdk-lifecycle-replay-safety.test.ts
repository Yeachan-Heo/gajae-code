import { expect, test } from "bun:test";
import { createAttemptScopeAuthority } from "@gajae-code/agent-core/attempt-scope";
import { tagSdkLifecycleObserver } from "../src/extensibility/extensions/function-hooks-internal";
import { ExtensionRuntime, loadExtensionFromFactory } from "../src/extensibility/extensions/loader";
import { ExtensionRunner } from "../src/extensibility/extensions/runner";
import { AttemptRecordStore } from "../src/session/attempt-record-store";
import { SessionManager } from "../src/session/session-manager";
import { EventBus } from "../src/utils/event-bus";

test.each([false, true])("SDK observation retains replay safety unless user work runs: %s", async userHandler => {
	const authority = createAttemptScopeAuthority();
	const scope = authority.mintMain();
	const records = new AttemptRecordStore(authority);
	records.register(scope);
	records.establishClean(scope);
	const runtime = new ExtensionRuntime();
	const delivered: string[] = [];
	const extension = await loadExtensionFromFactory(
		api => {
			expect("tagSdkLifecycleObserver" in api.pi).toBe(false);
			api.on(
				"agent_start",
				tagSdkLifecycleObserver(() => {
					delivered.push("sdk");
				}),
			);
			if (userHandler)
				api.on("agent_start", () => {
					delivered.push("user");
				});
		},
		process.cwd(),
		new EventBus(),
		runtime,
		"sdk-observer-replay-test",
	);
	const runner = new ExtensionRunner([extension], runtime, process.cwd(), SessionManager.inMemory(), {} as never);
	runner.setAttemptRecordStore(records);
	await runner.emit({ type: "agent_start" }, undefined, scope);
	expect(delivered).toEqual(userHandler ? ["sdk", "user"] : ["sdk"]);
	expect(records.isClean(scope)).toBe(!userHandler);
});

test("SDK observer tags do not exempt context handlers from replay invalidation", async () => {
	const authority = createAttemptScopeAuthority();
	const scope = authority.mintMain();
	const records = new AttemptRecordStore(authority);
	records.register(scope);
	records.establishClean(scope);
	const runtime = new ExtensionRuntime();
	let delivered = 0;
	const extension = await loadExtensionFromFactory(
		api => {
			api.on(
				"context",
				tagSdkLifecycleObserver(() => {
					delivered++;
				}),
			);
		},
		process.cwd(),
		new EventBus(),
		runtime,
		"sdk-observer-context-replay-test",
	);
	const runner = new ExtensionRunner([extension], runtime, process.cwd(), SessionManager.inMemory(), {} as never);
	runner.setAttemptRecordStore(records);
	await runner.emit({ type: "context", messages: [] }, undefined, scope);
	expect(delivered).toBe(1);
	expect(records.isClean(scope)).toBe(false);
});
