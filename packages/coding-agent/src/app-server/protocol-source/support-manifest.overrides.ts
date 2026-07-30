// Hand-authored support registry. Every generated client request defaults to planned.
export type SupportManifestOverride = {
	support: "implemented" | "not_supported";
	gjcSeam: string | null;
	gjcBackendPath: string | null;
	semanticGaps: readonly string[];
	translationNotes: readonly string[];
	owner: string | null;
	testIds: readonly string[];
	reason: string;
};

const noBackend = "No GJC backend exists for this Codex-only suite.";
const unsupported = {
	support: "not_supported" as const,
	gjcSeam: null,
	gjcBackendPath: null,
	semanticGaps: ["No equivalent GJC backend."],
	translationNotes: [],
	owner: "app-server",
	testIds: [],
	reason: noBackend,
};
const implemented = (gjcSeam: string, testId: string): SupportManifestOverride => ({
	support: "implemented",
	gjcSeam,
	gjcBackendPath: "packages/coding-agent/src/app-server/suites/handlers.ts",
	semanticGaps: [],
	translationNotes: [],
	owner: "app-server",
	testIds: [testId],
	reason: "GJC has a production handler registered by registerBuiltinHandlers.",
});
/** A suite-lane row: a real backing seam in its own lane file, named tests, no semantic gap. */
const laneRow = (
	gjcSeam: string,
	laneFile: string,
	testIds: readonly string[],
	reason: string,
): SupportManifestOverride => ({
	support: "implemented",
	gjcSeam,
	gjcBackendPath: `packages/coding-agent/src/app-server/${laneFile}`,
	semanticGaps: [],
	translationNotes: [],
	owner: "app-server",
	testIds,
	reason,
});
export const supportManifestOverrides: Record<string, SupportManifestOverride> = {
	"fs/readFile": implemented(
		"fsReadFileHandler",
		"processInbound + handler registry: fs/readFile dispatched through the server",
	),
	"fs/writeFile": implemented("fsWriteFileHandler", "fs/writeFile: writes a base64 file"),
	"fs/getMetadata": implemented("fsGetMetadataHandler", "fs/getMetadata: reports file metadata"),
	"fs/readDirectory": implemented("fsReadDirectoryHandler", "fs/readDirectory: lists entries"),
	"fs/createDirectory": implemented("fsCreateDirectoryHandler", "fs/createDirectory: creates recursively"),
	"fs/remove": implemented("fsRemoveHandler", "fs/remove: removes a file tree"),
	"skills/list": implemented("skillsListHandler", "skills/list: returns an empty catalog"),
	"hooks/list": implemented("hooksListHandler", "hooks/list: returns an empty catalog"),
	"experimentalFeature/list": implemented(
		"experimentalFeatureListHandler",
		"experimentalFeature/list: returns an empty catalog",
	),
	"thread/start": {
		support: "implemented",
		gjcSeam: "loadThread",
		gjcBackendPath: "packages/coding-agent/src/app-server/thread-runtime/child-bridge.ts",
		semanticGaps: [
			"Implemented only when an injected lifecycle adapter is configured; default real-child broker backing remains G2-BLOCKED.",
		],
		translationNotes: ["A Codex thread id is the retained GJC session id."],
		owner: "app-server",
		testIds: ["transactional load: readiness, effective settings, publication, and subscription are ordered"],
		reason: "loadThread provides the transactional boundary behind an explicitly injected lifecycle adapter.",
	},
	"turn/start": {
		support: "implemented",
		gjcSeam: "TurnController.start",
		gjcBackendPath: "packages/coding-agent/src/app-server/thread-runtime/turn-controller.ts",
		semanticGaps: ["Requires an injected retained-child adapter; the G2 real child remains blocked."],
		translationNotes: ["Only nonempty text UserInput entries and null/absent turn overrides are admitted."],
		owner: "app-server",
		testIds: ["server: turn/start routes through the durable TurnController"],
		reason: "TurnController.start owns admission, durable projection, and notification delivery barriers.",
	},
	"thread/resume": {
		support: "implemented",
		gjcSeam: "readAndReconstructTurns + projectThreadResponse",
		gjcBackendPath: "packages/coding-agent/src/app-server/server.ts",
		semanticGaps: ["Requires an injected retained-child adapter; the G2 real child remains blocked."],
		translationNotes: ["Only threadId with null/absent resume overrides is admitted."],
		owner: "app-server",
		testIds: ["server: thread/resume reconstructs persisted turns and defers subscription"],
		reason: "thread/resume reads the durable projection and projects the negotiated response profile.",
	},
	"fs/copy": laneRow(
		"fsCopyHandler",
		"suites/fs-watch-handlers.ts",
		["FS-001 fs/copy recursively copies a real file tree and overwrites existing files"],
		"Recursive copy runs against the real filesystem.",
	),
	"fs/watch": laneRow(
		"fsWatchHandler",
		"suites/fs-watch-handlers.ts",
		["FS-002 fs/watch emits a real fs/changed notification for a nested file write"],
		"A real recursive watcher emits fs/changed for observed events.",
	),
	"fs/unwatch": laneRow(
		"fsUnwatchHandler",
		"suites/fs-watch-handlers.ts",
		["FS-003 fs/unwatch stops an unknown-id request with notFound"],
		"Unwatch closes the real watcher handle registered by fs/watch.",
	),
	"command/exec": laneRow(
		"commandExecHandler",
		"suites/command-exec-handlers.ts",
		["command/exec runs real command and routes output to the connection"],
		"Real child execution streams command/exec/outputDelta to the requesting connection.",
	),
	"command/exec/write": laneRow(
		"commandExecWriteHandler",
		"suites/command-exec-handlers.ts",
		["command/exec write sends stdin to cat"],
		"Stdin bytes are written to the live child.",
	),
	"command/exec/resize": laneRow(
		"commandExecResizeHandler",
		"suites/command-exec-handlers.ts",
		["command/exec tty uses PtySession and supports resize"],
		"A tty exec is backed by the native PtySession, whose resize is real.",
	),
	"command/exec/terminate": laneRow(
		"commandExecTerminateHandler",
		"suites/command-exec-handlers.ts",
		["output cap and timeout are reported truthfully"],
		"Termination kills the real child and settles its waiter.",
	),
	"process/spawn": laneRow(
		"processSpawnHandler",
		"suites/process-handlers.ts",
		["process/spawn streams real stdout and stderr bytes and emits one true exit"],
		"Real spawn streams process/outputDelta and emits process/exited exactly once.",
	),
	"process/writeStdin": laneRow(
		"processWriteStdinHandler",
		"suites/process-handlers.ts",
		["process/writeStdin delivers real bytes to a child process"],
		"Decoded bytes are written to the live child or PTY session.",
	),
	"process/resizePty": laneRow(
		"processResizePtyHandler",
		"suites/process-handlers.ts",
		["process/resizePty rejects a non-PTY process with the pinned notSupported error"],
		"Resize is real for PTY records and refused for non-PTY records.",
	),
	"process/kill": laneRow(
		"processKillHandler",
		"suites/process-handlers.ts",
		["process/kill terminates a sleeper and emits exactly one exit"],
		"Kill signals the real process and still settles a single exit notification.",
	),
	"model/list": laneRow(
		"modelListHandler",
		"suites/model-config-handlers.ts",
		["model/list enumerates a model loaded from the temp models config"],
		"The response is projected from the loaded ModelRegistry catalog.",
	),
	"modelProvider/capabilities/read": laneRow(
		"modelProviderCapabilitiesReadHandler",
		"suites/model-config-handlers.ts",
		["modelProvider/capabilities/read derives model compatibility and rejects an unknown provider"],
		"Capabilities are derived from real provider/model compat data.",
	),
	"config/read": laneRow(
		"configReadHandler",
		"suites/model-config-handlers.ts",
		["config/value/write persists through Settings and config/read observes the value"],
		"The response is projected from a scope-bound Settings instance.",
	),
	"config/value/write": laneRow(
		"configValueWriteHandler",
		"suites/model-config-handlers.ts",
		["config/value/write persists through Settings and config/read observes the value"],
		"Writes are validated and persisted through Settings.commitAtomicBatch.",
	),
	"config/batchWrite": laneRow(
		"configBatchWriteHandler",
		"suites/model-config-handlers.ts",
		["config writes reject unknown and invalid values without mutating the config"],
		"A batch is validated in full before one atomic Settings commit.",
	),
	"config/mcpServer/reload": {
		support: "not_supported",
		gjcSeam: null,
		gjcBackendPath: null,
		semanticGaps: ["No GJC runtime seam reloads MCP server configuration."],
		translationNotes: [],
		owner: "app-server",
		testIds: ["the modelConfig lane exposes exactly the methods GJC can back"],
		reason: "GJC has no MCP configuration reload entry point, so no handler is registered.",
	},
	"account/login/cancel": unsupported,
	"account/login/start": unsupported,
	"account/logout": unsupported,
	getAuthStatus: unsupported,
	"marketplace/add": unsupported,
	"marketplace/remove": unsupported,
	"marketplace/upgrade": unsupported,
	"remoteControl/client/list": unsupported,
	"remoteControl/client/revoke": unsupported,
	"remoteControl/disable": unsupported,
	"remoteControl/enable": unsupported,
	"remoteControl/pairing/start": unsupported,
	"remoteControl/pairing/status": unsupported,
	"remoteControl/status/read": unsupported,
	"thread/realtime/appendAudio": unsupported,
	"thread/realtime/appendSpeech": unsupported,
	"thread/realtime/appendText": unsupported,
	"thread/realtime/listVoices": unsupported,
	"thread/realtime/start": unsupported,
	"thread/realtime/stop": unsupported,
	"windowsSandbox/readiness": unsupported,
	"windowsSandbox/setupStart": unsupported,
};
