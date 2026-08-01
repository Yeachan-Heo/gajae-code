import { afterEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { RecoveryFsRoot } from "@gajae-code/natives";
import { getSessionsDir } from "@gajae-code/utils";
import {
	prepareManagedSessionScopeForWriteSync,
	resolveManagedScopeForWrite,
} from "../src/session/internal/managed-session-scope";

const roots: string[] = [];
afterEach(async () => {
	vi.restoreAllMocks();
	for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true });
});

describe("managed scope capacity errors", () => {
	it("preserves native content_too_large as artifact_capacity_exceeded instead of binding_invalid", async () => {
		if (process.platform !== "linux") return;
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-managed-capacity-"));
		roots.push(root);
		const agentDir = path.join(root, "agent");
		const cwd = path.join(root, "workspace");
		await fs.mkdir(cwd, { recursive: true });
		const resolved = resolveManagedScopeForWrite({ cwd, agentDir, sessionsRoot: getSessionsDir(agentDir) });
		if (resolved.kind === "error") throw new Error(resolved.code);
		vi.spyOn(RecoveryFsRoot.prototype, "snapshotManagedTree").mockReturnValue({
			ok: false,
			code: "content_too_large",
		});
		expect(prepareManagedSessionScopeForWriteSync(resolved.scope)).toMatchObject({
			kind: "error",
			code: "artifact_capacity_exceeded",
			cause: { classification: "artifact_capacity_exceeded", diagnostic: "prepare:store" },
		});
	});
});
