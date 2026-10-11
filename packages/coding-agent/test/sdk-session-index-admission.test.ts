import { expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { FileLockTestHooks } from "../src/config/file-lock";
import { SessionIndex } from "../src/sdk/broker/session-index";

for (const outcome of ["throw", "cancel", "teardown", "timeout", "late ack"] as const) {
	test(`unchanged polling bypasses a pending ${outcome} writer and locked refresh recovers authority`, async () => {
		const root = await fs.mkdtemp(path.join(process.env.TMPDIR ?? "/tmp", "gjc-index-admission-path-"));
		const writer = new SessionIndex(root);
		const reader = new SessionIndex(root);
		const entered = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		const previousHook = FileLockTestHooks.afterParentMkdir;
		const registration = {
			type: "host_registered" as const,
			sessionId: "holder",
			locator: { cwd: root, worktreeRoot: root, stateRoot: path.join(root, "state") },
			endpointGeneration: 1,
			pid: process.pid,
		};
		let pending: Promise<unknown> | undefined;
		let acknowledged = false;
		try {
			await writer.append(registration);
			await reader.refreshIfChanged();
			let blocked = false;
			FileLockTestHooks.afterParentMkdir = async () => {
				if (blocked) return;
				blocked = true;
				entered.resolve();
				await release.promise;
				if (outcome === "throw") throw new Error("writer failed before committing");
			};
			pending = writer
				.append(
					outcome === "teardown"
						? { ...registration, type: "host_unregistered" }
						: { ...registration, sessionId: "late-holder" },
				)
				.then(
					value => ({ value }),
					error => ({ error }),
				);
			void pending.then(() => {
				acknowledged = true;
			});
			await entered.promise;
			if (outcome === "cancel" || outcome === "timeout") {
				const abandoned = Promise.withResolvers<never>();
				const signal = outcome === "cancel" ? AbortSignal.abort() : AbortSignal.timeout(1);
				if (signal.aborted) abandoned.reject(signal.reason);
				else signal.addEventListener("abort", () => abandoned.reject(signal.reason), { once: true });
				await expect(Promise.race([pending, abandoned.promise])).rejects.toMatchObject({
					name: outcome === "cancel" ? "AbortError" : "TimeoutError",
				});
			}
			// Cancellation/timeout abandon the caller's wait, not the writer's durable effect.
			const polled = await Promise.race([
				reader.refreshIfChanged().then(changed => ({ changed })),
				Bun.sleep(500).then(() => undefined),
			]);
			expect(acknowledged).toBe(false);
			release.resolve();
			const result = await pending;
			expect(polled).toEqual({ changed: false });
			expect(acknowledged).toBe(true);
			if (outcome === "throw") expect(result).toMatchObject({ error: expect.any(Error) });
			await reader.refresh();
			const ids = reader
				.listSessions()
				.sessions.filter(row => !row.terminal && row.live)
				.map(row => row.sessionId);
			if (outcome === "teardown") expect(ids).not.toContain("holder");
			else if (outcome === "throw") expect(ids).toEqual(["holder"]);
			else expect(ids).toEqual(["holder", "late-holder"]);
			// A rejected or late write must never poison the queue for future admissions.
			await writer.append({ ...registration, sessionId: "next-holder" });
			await reader.refresh();
			expect(reader.listSessions().sessions.some(row => row.sessionId === "next-holder")).toBe(true);
		} finally {
			release.resolve();
			FileLockTestHooks.afterParentMkdir = previousHook;
			await pending;
			await fs.rm(root, { recursive: true, force: true });
		}
	});
}
