import { describe, expect, spyOn, test } from "bun:test";
import { logger } from "@gajae-code/utils";
import { EventBus } from "../../src/utils/event-bus";

describe("EventBus", () => {
	test("does not create a promise for a synchronous listener", () => {
		const resolve = spyOn(Promise, "resolve");
		const bus = new EventBus();
		let received: unknown;
		bus.on("sync", value => {
			received = value;
		});

		bus.emit("sync", "payload");

		expect(received).toBe("payload");
		expect(resolve).not.toHaveBeenCalled();
		resolve.mockRestore();
	});

	test("logs both synchronous throws and asynchronous rejections", async () => {
		const error = spyOn(logger, "error").mockImplementation(() => {});
		const bus = new EventBus();
		bus.on("sync-throw", () => {
			throw new Error("sync failure");
		});
		bus.on("async-rejection", () => Promise.reject(new Error("async failure")));

		bus.emit("sync-throw", undefined);
		bus.emit("async-rejection", undefined);
		await Bun.sleep(0);

		expect(error).toHaveBeenCalledWith("Event handler error", {
			channel: "sync-throw",
			error: "Error: sync failure",
		});
		expect(error).toHaveBeenCalledWith("Event handler error", {
			channel: "async-rejection",
			error: "Error: async failure",
		});
		error.mockRestore();
	});
});
