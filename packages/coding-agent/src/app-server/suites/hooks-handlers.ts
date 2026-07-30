import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import * as path from "node:path";
import { type Hook, hookCapability } from "../../capability/hook";
import { loadCapability } from "../../discovery";
import type { HandlerResult, MethodHandler } from "./handlers";

type RecordValue = Record<string, unknown>;

type HooksListParams = {
	cwds?: unknown;
};

type HookListMetadata = {
	key: string;
	eventName: "preToolUse" | "postToolUse";
	handlerType: "command";
	matcher: string;
	command: string;
	timeoutSec: number;
	statusMessage: null;
	additionalContextLimit: null;
	sourcePath: string;
	source: "user" | "project";
	pluginId: null;
	displayOrder: number;
	enabled: true;
	isManaged: false;
	currentHash: string;
	trustStatus: "untrusted";
};

type HookErrorInfo = {
	path: string;
	message: string;
};

function isRecord(value: unknown): value is RecordValue {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function invalidParams(): HandlerResult {
	return { ok: false, errorKey: "invalidParams" };
}

function parseCwds(params: unknown): string[] | null {
	if (!isRecord(params)) return null;
	const rawCwds = (params as HooksListParams).cwds;
	if (rawCwds === undefined) return [process.cwd()];
	if (!Array.isArray(rawCwds)) return null;
	if (!rawCwds.every(cwd => typeof cwd === "string" && cwd.trim().length > 0)) return null;
	if (rawCwds.length === 0) return [process.cwd()];
	return rawCwds.map(cwd => path.resolve(cwd));
}

function eventNameFor(hook: Hook): "preToolUse" | "postToolUse" | null {
	if (hook.type === "pre") return "preToolUse";
	if (hook.type === "post") return "postToolUse";
	return null;
}

function sourceFor(hook: Hook): "user" | "project" {
	return hook._source.level === "project" ? "project" : "user";
}

async function currentHash(sourcePath: string): Promise<string> {
	const content = await readFile(sourcePath);
	return createHash("sha256").update(content).digest("hex");
}

async function projectHook(
	hook: Hook,
	displayOrder: number,
): Promise<{ metadata?: HookListMetadata; error?: HookErrorInfo }> {
	const eventName = eventNameFor(hook);
	const sourcePath = path.resolve(hook.path);
	if (!eventName) {
		return {
			error: {
				path: sourcePath,
				message: `GJC hook type ${JSON.stringify(hook.type)} has no app-server event mapping.`,
			},
		};
	}

	try {
		const hash = await currentHash(sourcePath);
		const matcher = hook.tool;
		return {
			metadata: {
				key: `${eventName}:${matcher}:${sourcePath}`,
				eventName,
				handlerType: "command",
				matcher,
				// GJC executes hook files as the configured hook program. The pinned
				// protocol has no module/file field, so the real absolute source path
				// is carried in its command slot rather than an invented command line.
				command: sourcePath,
				timeoutSec: 0,
				statusMessage: null,
				additionalContextLimit: null,
				sourcePath,
				source: sourceFor(hook),
				pluginId: null,
				displayOrder,
				enabled: true,
				isManaged: false,
				currentHash: hash,
				trustStatus: "untrusted",
			},
		};
	} catch (error) {
		return {
			error: {
				path: sourcePath,
				message: `Unable to hash configured GJC hook: ${error instanceof Error ? error.message : String(error)}`,
			},
		};
	}
}

async function listHooksForCwd(cwd: string): Promise<RecordValue> {
	const discovered = await loadCapability<Hook>(hookCapability.id, {
		cwd,
		// This lane reports GJC's native .gjc hook configuration. Other editor
		// providers are loaded by the runtime for compatibility, but are not GJC
		// configuration and do not belong in this native app-server catalog.
		providers: ["native"],
	});

	const hooks: HookListMetadata[] = [];
	const errors: HookErrorInfo[] = [];
	const projected = await Promise.all(discovered.items.map((hook, index) => projectHook(hook, index)));
	for (const result of projected) {
		if (result.metadata) hooks.push(result.metadata);
		if (result.error) errors.push(result.error);
	}

	return {
		cwd,
		hooks,
		warnings: discovered.warnings,
		errors,
	};
}

/** Enumerate GJC's native configured pre/post tool hooks. */
export const hooksListHandler: MethodHandler = async params => {
	const cwds = parseCwds(params);
	if (!cwds) return invalidParams();

	try {
		const data = await Promise.all(cwds.map(listHooksForCwd));
		return { ok: true, result: { data } };
	} catch {
		return { ok: false, errorKey: "internalError" };
	}
};

export const hooksHandlers: Record<string, MethodHandler> = {
	"hooks/list": hooksListHandler,
};
