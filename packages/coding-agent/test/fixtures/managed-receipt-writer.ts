import { createHash, randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { observeProcessIncarnation } from "../../src/sdk/broker/process-incarnation";
import { SessionManager } from "../../src/session/session-manager";
import { makeAssistantMessage } from "../session-manager/helpers";

const [root, lane, mode] = process.argv.slice(2);
if (!root || !lane || !["concurrent", "orphan"].includes(mode)) throw new Error("Invalid fixture arguments");
const cwd = path.join(root, "work");
const agentDir = path.join(root, "agent");
fs.mkdirSync(cwd, { recursive: true });
fs.mkdirSync(agentDir, { recursive: true });
if (mode === "orphan") {
	const attemptId = randomUUID();
	const destination = path.join(root, "transcript.jsonl");
	const staging = path.join(root, `.transcript.jsonl.${attemptId}.replacement`);
	fs.writeFileSync(destination, "predecessor\n", { mode: 0o600 });
	fs.writeFileSync(staging, "successor\n", { mode: 0o600 });
	const snapshot = (file: string) => {
		const stat = fs.statSync(file, { bigint: true });
		return {
			dev: String(stat.dev),
			ino: String(stat.ino),
			nlink: String(stat.nlink),
			size: String(stat.size),
			mtimeNs: String(stat.mtimeNs),
			ctimeNs: String(stat.ctimeNs),
			sha256: createHash("sha256").update(fs.readFileSync(file)).digest("hex"),
		};
	};
	const observed = observeProcessIncarnation(process.pid);
	if (observed.status !== "present") throw new Error("Fixture owner identity unavailable");
	const pending = path.join(root, `.gjc-replace-receipt-pending-${attemptId}.json`);
	fs.writeFileSync(
		pending,
		JSON.stringify({
			version: 3,
			staging,
			destination,
			predecessor: snapshot(destination),
			successor: snapshot(staging),
			publisher: {
				attemptId,
				ownerId: randomUUID(),
				pid: process.pid,
				incarnation: observed.incarnation,
				host: os.hostname(),
			},
		}),
		{ mode: 0o600 },
	);
	await Bun.write(path.join(root, `ready-${lane}`), JSON.stringify({ pending, pid: process.pid }));
	const deadline = Date.now() + 20000;
	while (!fs.existsSync(path.join(root, "exit"))) {
		if (Date.now() > deadline) throw new Error("Fixture exit barrier timeout");
		await Bun.sleep(10);
	}
} else {
	const manager = SessionManager.create(cwd, SessionManager.managedDestination(cwd, agentDir));
	manager.appendMessage({ role: "user", content: "x".repeat(430_000), timestamp: Date.now() });
	manager.appendMessage(makeAssistantMessage());
	manager.setSessionMemoryMode("auto");
	await manager.flush();
	await Bun.write(path.join(root, `ready-${lane}`), String(process.pid));
	const deadline = Date.now() + 20000;
	while (!fs.existsSync(path.join(root, "start"))) {
		if (Date.now() > deadline) throw new Error("Fixture barrier timeout");
		await Bun.sleep(10);
	}
	let completedAppends = 0;
	let failure: { name: string; message: string } | null = null;
	try {
		for (let i = 0; i < 20; i++) {
			manager.appendModeChange("goal", {
				goal: {
					id: `goal-${lane}`,
					objective: "Concurrent persistence",
					status: "active",
					tokensUsed: i,
					timeUsedSeconds: 0,
					createdAt: 0,
					updatedAt: i,
				},
			});
			manager.appendMessage(makeAssistantMessage());
			completedAppends += 2;
			await Bun.sleep(1);
		}
		await manager.flush();
	} catch (error) {
		failure =
			error instanceof Error
				? { name: error.name, message: error.message }
				: { name: "unknown", message: String(error) };
	}
	const file = manager.getSessionFile()!;
	const expected = manager.captureState().managedPersistExpectedIdentity;
	const actual = fs.statSync(file, { bigint: true });
	await Bun.write(
		path.join(root, `result-${lane}.json`),
		JSON.stringify({
			completedAppends,
			failure,
			expectedInode: String(expected?.ino),
			actualInode: String(actual.ino),
		}),
	);
	await manager.close().catch(() => {});
	process.exitCode = failure ? 1 : 0;
}
