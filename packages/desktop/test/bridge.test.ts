import { expect, test, vi } from "bun:test";
import type { DesktopFrame } from "@gajae-code/desktop-host/protocol";
import * as core from "@tauri-apps/api/core";
import * as events from "@tauri-apps/api/event";
import { DesktopLocalRequestError, DesktopRequestError, request, subscribe } from "../src/bridge";

test("bridge owns each in-flight ID through duplicate admission, fast frames and late invoke failures", async () => {
	const acknowledgements: Array<PromiseWithResolvers<unknown>> = [];
	let receiveFrame = (_frame: DesktopFrame): void => {
		throw new Error("Bridge has not installed its frame listener");
	};
	const tauri = vi.spyOn(core, "isTauri").mockReturnValue(true);
	const listen = vi.spyOn(events, "listen").mockImplementation(async (_event, handler) => {
		const receive = handler as events.EventCallback<unknown>;
		receiveFrame = payload => receive({ event: "engine-frame", id: 1, payload });
		return () => {};
	});
	const invoke = vi.spyOn(core, "invoke").mockImplementation(<T>(command: string, _args?: core.InvokeArgs) => {
		if (command !== "engine_request") throw new Error(`Unexpected native command: ${command}`);
		const acknowledgement = Promise.withResolvers<unknown>();
		acknowledgements.push(acknowledgement);
		return acknowledgement.promise as Promise<T>;
	});
	let unsubscribe: (() => void) | undefined;
	async function waitForWrites(count: number): Promise<void> {
		const deadline = Date.now() + 1_000;
		while (acknowledgements.length < count && Date.now() < deadline) await Bun.sleep(1);
		expect(acknowledgements).toHaveLength(count);
	}
	try {
		unsubscribe = await subscribe(() => {});
		const original = request<string>("session.rename", { sessionId: "owned", name: "original" }, "reused-id");
		void original.catch(() => {});
		await waitForWrites(1);
		const duplicate = request("session.delete", { sessionId: "owned" }, "reused-id");
		await expect(duplicate).rejects.toBeInstanceOf(DesktopLocalRequestError);
		await expect(duplicate).rejects.toMatchObject({
			requestId: "reused-id",
			message: "Request ID already in flight",
			deliveryDisposition: "refused",
		});
		expect(invoke).toHaveBeenCalledTimes(1);
		expect(invoke).toHaveBeenNthCalledWith(1, "engine_request", {
			request: { id: "reused-id", method: "session.rename", params: { sessionId: "owned", name: "original" } },
		});

		// A response settles the first owner even while its native write acknowledgement is held.
		receiveFrame({ type: "response", id: "reused-id", ok: true, result: "original result" });
		await expect(original).resolves.toBe("original result");
		const successor = request<string>("session.rename", { sessionId: "owned", name: "successor" }, "reused-id");
		void successor.catch(() => {});
		await waitForWrites(2);
		let successorSettled = false;
		void successor.then(
			() => {
				successorSettled = true;
			},
			() => {
				successorSettled = true;
			},
		);
		acknowledgements[0]!.reject(new Error("Retired native write failed late"));
		await Promise.resolve();
		expect(successorSettled).toBe(false);
		receiveFrame({ type: "response", id: "reused-id", ok: true, result: "successor result" });
		await expect(successor).resolves.toBe("successor result");
		acknowledgements[1]!.resolve(undefined);

		// A failure of the current write still rejects its owner and frees the ID, without retrying.
		const failed = request("session.rename", { sessionId: "owned", name: "failed" }, "reused-id");
		void failed.catch(() => {});
		await waitForWrites(3);
		acknowledgements[2]!.reject("Native write refused");
		await expect(failed).rejects.toThrow("Native write refused");
		expect(invoke).toHaveBeenCalledTimes(3);
		const afterFailure = request("session.rename", { sessionId: "owned", name: "after failure" }, "reused-id");
		void afterFailure.catch(() => {});
		await waitForWrites(4);
		receiveFrame({
			type: "response",
			id: "reused-id",
			ok: false,
			error: "Host refused",
			deliveryDisposition: "refused",
		});
		await expect(afterFailure).rejects.toBeInstanceOf(DesktopRequestError);
		await expect(afterFailure).rejects.toMatchObject({ requestId: "reused-id", deliveryDisposition: "refused" });
		acknowledgements[3]!.resolve(undefined);
		expect(invoke).toHaveBeenCalledTimes(4);
		expect(listen).toHaveBeenCalledTimes(1);

		const preference = request(
			"preferences.apply",
			{ sessionId: "owned", action: { type: "role.set", role: "default", modelId: "provider/model" } },
			"committed-preference",
		);
		void preference.catch(() => {});
		await waitForWrites(5);
		const outcome = {
			scope: "global" as const,
			applied: true,
			durability: "persisted" as const,
			application: "settings" as const,
			committedVersion: 7,
		};
		receiveFrame({
			type: "response",
			id: "committed-preference",
			ok: false,
			error: "The preference was applied; refresh before retrying.",
			preferenceOutcome: outcome,
		});
		// Subscribers cannot mutate the receipt already delivered to the rejected request.
		outcome.applied = false;
		const failure: unknown = await preference.catch((error: unknown) => error);
		expect(failure).toBeInstanceOf(DesktopRequestError);
		if (!(failure instanceof DesktopRequestError)) throw new Error("Missing typed preference failure");
		expect(failure.preferenceOutcome).toEqual({
			scope: "global",
			applied: true,
			durability: "persisted",
			application: "settings",
			committedVersion: 7,
		});
		expect(failure.deliveryDisposition).toBeUndefined();
		expect(failure.message).toContain("was applied");
		acknowledgements[4]!.resolve(undefined);
		expect(invoke).toHaveBeenCalledTimes(5);
	} finally {
		receiveFrame({ type: "fatal", error: "Bridge test cleanup" });
		for (const acknowledgement of acknowledgements) acknowledgement.resolve(undefined);
		unsubscribe?.();
		invoke.mockRestore();
		listen.mockRestore();
		tauri.mockRestore();
	}
});
