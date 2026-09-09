/**
 * D8 daemon restart contract.
 *
 * The shared identity/occupancy predicates are what both the owner tick and the
 * doctor-side client agree on, so their refusal edges are locked here. The
 * client's owner-observation classification is locked too: a daemon that
 * predates the current restart protocol is present-but-undrivable and must be
 * reported as such, never as absent, because "absent" would let a caller treat
 * a live daemon as already gone.
 */
import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Settings } from "../src/config/settings";
import { chatDaemonGeneration, chatDaemonPaths } from "../src/sdk/bus/chat-daemon-control";
import {
	type DoctorDaemonOccupancy,
	doctorDaemonIdentityMatches,
	doctorDaemonOccupancyEmpty,
	doctorDaemonOccupancySettled,
	isDoctorDaemonControlRequest,
} from "../src/sdk/bus/doctor-daemon-restart";
import { restartDaemonForDoctor } from "../src/sdk/bus/doctor-daemon-restart-client";

describe("doctor daemon restart protocol", () => {
	it("requires exact owner, owner id, generation, and incarnation", () => {
		const identity = { owner: "telegram" as const, ownerId: "owner-1", generation: 4, incarnation: "inc-1" };
		expect(doctorDaemonIdentityMatches(identity, identity)).toBe(true);
		expect(doctorDaemonIdentityMatches({ ...identity, ownerId: "other" }, identity)).toBe(false);
		expect(doctorDaemonIdentityMatches({ ...identity, incarnation: "inc-2" }, identity)).toBe(false);
		expect(doctorDaemonIdentityMatches(undefined, identity)).toBe(false);
	});

	it("accepts a well-formed control request and rejects malformed ones", () => {
		const identity = { owner: "telegram" as const, ownerId: "owner-1", generation: 4, incarnation: "inc-1" };
		const base = { version: 1, requestId: "r", action: "prepare", ...identity, createdAt: 1 };
		expect(isDoctorDaemonControlRequest(base)).toBe(true);
		expect(isDoctorDaemonControlRequest({ ...base, version: 2 })).toBe(false);
		expect(isDoctorDaemonControlRequest({ ...base, action: "restart" })).toBe(false);
		expect(isDoctorDaemonControlRequest({ ...base, requestId: "" })).toBe(false);
		expect(isDoctorDaemonControlRequest({ ...base, incarnation: "" })).toBe(false);
		expect(isDoctorDaemonControlRequest({ ...base, leaseExpiresAt: "soon" })).toBe(false);
		expect(isDoctorDaemonControlRequest(undefined)).toBe(false);
	});

	it("never treats an empty or partial occupancy object as settled", () => {
		expect(doctorDaemonOccupancySettled(undefined)).toBe(false);
		expect(doctorDaemonOccupancySettled({} as unknown as DoctorDaemonOccupancy)).toBe(false);
		expect(doctorDaemonOccupancySettled({ attached: 0 } as unknown as DoctorDaemonOccupancy)).toBe(false);
		expect(doctorDaemonOccupancySettled(doctorDaemonOccupancyEmpty())).toBe(true);
		// An idle attached session is still workload: `--drain` waits, never detaches.
		expect(doctorDaemonOccupancySettled({ ...doctorDaemonOccupancyEmpty(), attached: 1 })).toBe(false);
		expect(doctorDaemonOccupancySettled({ ...doctorDaemonOccupancyEmpty(), cleanup: 1 })).toBe(false);
	});

	it("reports a pre-protocol incumbent distinctly from an absent owner", async () => {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "doctor-daemon-"));
		const settings = await Settings.loadForScope({ cwd: dir, agentDir: dir });
		try {
			// No published state at all.
			const absent = await restartDaemonForDoctor({ agentDir: dir, owner: "discord", settings });
			expect(absent).toEqual({ kind: "owner_unavailable", reason: "no_state" });

			// A live record from an older generation: present, but not drivable by
			// this protocol, and never to be signalled.
			const paths = chatDaemonPaths(dir, "discord");
			await Bun.write(
				paths.state,
				JSON.stringify({
					version: 1,
					kind: "discord",
					pid: process.pid,
					ownerId: "legacy-owner",
					identity: "legacy-identity",
					incarnation: `darwin:${process.pid}:1`,
					startedAt: Date.now(),
					heartbeatAt: Date.now(),
					transportHealthy: true,
					generation: chatDaemonGeneration("discord") - 1,
				}),
			);
			const legacy = await restartDaemonForDoctor({ agentDir: dir, owner: "discord", settings });
			expect(legacy).toEqual({ kind: "owner_unavailable", reason: "unsupported_incumbent_protocol" });

			// The refusal is inert: no control request is written for an owner we
			// cannot drive, and the incumbent's own record is untouched.
			expect(await Bun.file(paths.control).exists()).toBe(false);
			expect(await Bun.file(`${chatDaemonPaths(dir, "discord").dir}/doctor-restart.control.json`).exists()).toBe(
				false,
			);
			expect((await Bun.file(paths.state).json()).ownerId).toBe("legacy-owner");
		} finally {
			await settings.close();
			await fs.rm(dir, { recursive: true, force: true });
		}
	});
});
