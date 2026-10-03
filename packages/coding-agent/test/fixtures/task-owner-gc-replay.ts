import { managedRootForScope, resolveManagedScope } from "../../src/session/internal/managed-session-scope";
import { FileSessionStorage, retireSessionTranscript } from "../../src/session/session-storage";

const input = process.env.GJC_OWNER_REPLAY_INPUT;
if (!input) throw new Error("Missing GC replay fixture input");
const value: unknown = JSON.parse(input);
if (typeof value !== "object" || value === null) throw new Error("Invalid GC replay input");
const record = value as Record<string, unknown>;
const { cwd, agentDir, sessionsRoot, transcriptPath } = record;
if (
	typeof cwd !== "string" ||
	typeof agentDir !== "string" ||
	typeof sessionsRoot !== "string" ||
	typeof transcriptPath !== "string"
)
	throw new Error("Invalid GC replay path types");
const resolved = resolveManagedScope({ cwd, agentDir, sessionsRoot });
if (resolved.kind !== "resolved") throw new Error("GC replay scope refused");
const outcome = await retireSessionTranscript(
	new FileSessionStorage(),
	sessionsRoot,
	transcriptPath,
	{
		rootAuthority: managedRootForScope(resolved.scope),
		sessionsRoot,
		profileAgentDir: agentDir,
		securityPolicy: process.platform === "win32" ? "windows-existing-verify-first" : "default",
	},
	{ managedScope: resolved.scope },
);
process.stdout.write(
	JSON.stringify({ kind: "api-package-gc-replay", pid: process.pid, outcome }, (_key, item: unknown) =>
		typeof item === "bigint" ? item.toString() : item,
	),
);
