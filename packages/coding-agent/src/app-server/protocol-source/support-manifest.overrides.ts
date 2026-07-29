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
	"config/read": implemented("configReadHandler", "config/read: returns codex-compatible config shape"),
	"model/list": implemented("modelListHandler", "model/list: returns ModelListResponse shape with data array"),
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
