import type { ExtensionAPI } from "../../src/extensibility/extensions";
import { createNotificationsExtension } from "../../src/sdk/bus";

type NotificationsExtensionOptions = Parameters<typeof createNotificationsExtension>[1];
const TELEGRAM_ORCHESTRATION_ENV_KEYS = [
	"GJC_COORDINATOR_SESSION_ID",
	"GJC_COORDINATOR_SESSION_STATE_FILE",
	"GJC_LIFECYCLE_REQUEST_ID",
	"GJC_SDK_LIFECYCLE_REQUEST",
] as const;

type TelegramOrchestrationEnv = Partial<Record<(typeof TELEGRAM_ORCHESTRATION_ENV_KEYS)[number], string | undefined>>;

export function withTelegramOrchestrationProvenance<T>(run: () => T): T {
	const previousCoordinatorSessionId = process.env.GJC_COORDINATOR_SESSION_ID;
	const previousSessionId = process.env.GJC_SESSION_ID;
	process.env.GJC_COORDINATOR_SESSION_ID = "test-telegram-orchestration";
	delete process.env.GJC_SESSION_ID;
	try {
		return run();
	} finally {
		if (previousCoordinatorSessionId === undefined) delete process.env.GJC_COORDINATOR_SESSION_ID;
		else process.env.GJC_COORDINATOR_SESSION_ID = previousCoordinatorSessionId;
		if (previousSessionId === undefined) delete process.env.GJC_SESSION_ID;
		else process.env.GJC_SESSION_ID = previousSessionId;
	}
}

export function withoutTelegramOrchestrationProvenance<T>(run: () => T): T {
	const previous: TelegramOrchestrationEnv = {};
	for (const key of TELEGRAM_ORCHESTRATION_ENV_KEYS) {
		previous[key] = process.env[key];
		delete process.env[key];
	}
	try {
		return run();
	} finally {
		for (const key of TELEGRAM_ORCHESTRATION_ENV_KEYS) {
			const value = previous[key];
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
	}
}

export function createOrchestrationNotificationsExtension(
	api: ExtensionAPI,
	options: NotificationsExtensionOptions = {},
): void {
	withTelegramOrchestrationProvenance(() => createNotificationsExtension(api, options));
}
