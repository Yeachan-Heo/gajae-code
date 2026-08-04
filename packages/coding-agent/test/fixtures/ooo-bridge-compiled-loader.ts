import { loadExtensions } from "../../src/extensibility/extensions/loader";

const [extensionPath, cwd] = Bun.argv.slice(-2);
if (!extensionPath || !cwd) throw new Error("expected extension path and cwd");

const loaded = await loadExtensions([extensionPath], cwd);
const extension = loaded.extensions[0];
const handlerCount = extension?.handlers.get("input")?.length ?? 0;
const sessionSwitchHandlerCount = extension?.handlers.get("session_switch")?.length ?? 0;
await Bun.write(
	Bun.stdout,
	JSON.stringify({
		errors: loaded.errors,
		extensionCount: loaded.extensions.length,
		handlerCount,
		sessionSwitchHandlerCount,
	}),
);
