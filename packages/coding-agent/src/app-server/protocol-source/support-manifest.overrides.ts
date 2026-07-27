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
const unsupported = { support: "not_supported" as const, gjcSeam: null, gjcBackendPath: null, semanticGaps: ["No equivalent GJC backend."], translationNotes: [], owner: "app-server", testIds: [], reason: noBackend };
export const supportManifestOverrides: Record<string, SupportManifestOverride> = {
	"account/login/cancel": unsupported,
	"account/login/start": unsupported,
	"account/logout": unsupported,
	"getAuthStatus": unsupported,
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
