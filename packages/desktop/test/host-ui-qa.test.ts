import { expect, test } from "bun:test";
import * as path from "node:path";

interface WrapperConfig {
	serverUrl: string;
	token: string;
}

test("requested QA shutdown delivers its final frame and exits successfully", async () => {
	const root = path.resolve(import.meta.dir, "../../..");
	const child = Bun.spawn([process.execPath, "packages/desktop/scripts/host-ui-qa.ts"], {
		cwd: root,
		env: { PATH: process.env.PATH ?? "/usr/bin:/bin", GJC_DESKTOP_QA_MODEL_FIXTURE: "1" },
		stdin: "ignore",
		stdout: "pipe",
		stderr: "pipe",
	});
	const ready = Promise.withResolvers<WrapperConfig>();
	const deadline = setTimeout(() => ready.reject(new Error("QA wrapper did not start")), 30000);
	const stderr = Bun.readableStreamToText(child.stderr);
	const stdout = (async () => {
		const reader = child.stdout.getReader();
		const decoder = new TextDecoder();
		let pending = "";
		let configured = false;
		try {
			for (;;) {
				const { done, value } = await reader.read();
				if (done) break;
				pending += decoder.decode(value, { stream: true });
				let end = pending.indexOf("\n");
				while (end >= 0) {
					const line = pending.slice(0, end);
					pending = pending.slice(end + 1);
					if (!configured && line) {
						ready.resolve(JSON.parse(line) as WrapperConfig);
						configured = true;
					}
					end = pending.indexOf("\n");
				}
			}
			if (!configured) ready.reject(new Error("QA wrapper exited before startup"));
		} catch (error) {
			ready.reject(error);
			throw error;
		} finally {
			reader.releaseLock();
		}
	})();
	void stdout.catch(() => {});
	let events: Response | undefined;
	try {
		const config = await ready.promise;
		clearTimeout(deadline);
		const query = new URLSearchParams({ token: config.token, client: crypto.randomUUID() });
		const origin = "http://127.0.0.1:1420";
		events = await fetch(`${config.serverUrl}/events?${query}`, {
			headers: { Origin: origin },
			signal: AbortSignal.timeout(15000),
		});
		expect(events.status).toBe(200);
		if (!events.body) throw new Error("Missing QA event stream");
		const eventText = Bun.readableStreamToText(events.body);
		const response = await fetch(`${config.serverUrl}/request?${query}`, {
			method: "POST",
			headers: { Origin: origin, "Content-Type": "application/json" },
			body: JSON.stringify({ id: "requested-shutdown", method: "shutdown", params: {} }),
			signal: AbortSignal.timeout(15000),
		});
		expect(response.status).toBe(200);
		expect(await child.exited).toBe(0);
		const frames = (await eventText)
			.split("\n")
			.filter(line => line.startsWith("data: "))
			.map(line => JSON.parse(line.slice(6)) as { type?: string; id?: string; ok?: boolean });
		expect(frames.find(frame => frame.type === "response" && frame.id === "requested-shutdown")?.ok).toBe(true);
		expect(await stderr).not.toContain("Host terminated unexpectedly");
		await stdout;
	} finally {
		clearTimeout(deadline);
		if (child.exitCode === null) {
			const force = setTimeout(() => child.kill("SIGKILL"), 3000);
			try {
				child.kill("SIGTERM");
				await child.exited;
			} finally {
				clearTimeout(force);
			}
		}
		await events?.body?.cancel().catch(() => {});
		await Promise.allSettled([stdout, stderr]);
	}
}, 45000);
