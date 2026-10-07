import * as fs from "node:fs/promises";
import * as path from "node:path";
import { type FunctionHookRegistration, validateFunctionHookTarget } from "./function-hooks";

export type TaggedFunctionHookHandler = (...args: unknown[]) => Promise<unknown>;

const registrations = new WeakMap<TaggedFunctionHookHandler, FunctionHookRegistration>();
const registrationOrders = new WeakMap<(...args: never[]) => unknown, number>();
const handlerProviders = new WeakMap<(...args: never[]) => unknown, string>();
const hostObserverHandlers = new WeakSet<(...args: never[]) => unknown>();

/** Host lifecycle projections do not execute user work in the provider attempt. */
export function tagHostObserverHandler<T extends (...args: never[]) => unknown>(handler: T): T {
	hostObserverHandlers.add(handler);
	return handler;
}

export function isHostObserverHandler(value: unknown): boolean {
	return typeof value === "function" && hostObserverHandlers.has(value as (...args: never[]) => unknown);
}

export function tagExtensionHandlerRegistrationOrder<T extends (...args: never[]) => unknown>(
	handler: T,
	registrationOrder: number,
): T {
	registrationOrders.set(handler, registrationOrder);
	return handler;
}

export function wrapExtensionHandlerRegistration<T extends (...args: never[]) => unknown>(
	handler: T,
	registrationOrder: number,
	provider?: string,
): T {
	const registered = ((...args: never[]) => handler(...args)) as T;
	registrationOrders.set(registered, registrationOrder);
	if (provider !== undefined) handlerProviders.set(registered, provider);
	if (isHostObserverHandler(handler)) hostObserverHandlers.add(registered);
	return registered;
}

export function getExtensionHandlerProvider(value: unknown): string | undefined {
	return typeof value === "function" ? handlerProviders.get(value as (...args: never[]) => unknown) : undefined;
}

export function getExtensionHandlerRegistrationOrder(value: unknown): number | undefined {
	return typeof value === "function" ? registrationOrders.get(value as (...args: never[]) => unknown) : undefined;
}

export function tagFunctionHookHandler(registration: FunctionHookRegistration): TaggedFunctionHookHandler {
	if (registration.event === "*" && registration.target !== undefined)
		throw new Error("Wildcard function hooks cannot declare a target");
	if (registration.target !== undefined && registration.target !== "*")
		validateFunctionHookTarget(registration.target);
	const tagged: TaggedFunctionHookHandler = async () => undefined;
	registrations.set(
		tagged,
		Object.freeze({
			...registration,
			grant: Object.freeze(registration.grant),
			provenance: Object.freeze({ ...registration.provenance }),
		}),
	);
	return tagged;
}

export function getFunctionHookRegistration(value: unknown): FunctionHookRegistration | undefined {
	return typeof value === "function" ? registrations.get(value as TaggedFunctionHookHandler) : undefined;
}

/** Host-only root-confined read used by the mediated filesystem capability. */
export async function readConstrainedFunctionHookFile(
	filePath: string,
	cwd: string,
	roots: readonly string[],
): Promise<string> {
	if (roots.length === 0) throw new Error("Function hook filesystem.read has no declared root");
	const candidateReal = await fs.realpath(path.resolve(cwd, filePath));
	for (const root of roots) {
		const rootReal = await fs.realpath(path.resolve(cwd, root));
		const relative = path.relative(rootReal, candidateReal);
		if (relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative))) {
			const handle = await fs.open(candidateReal, "r");
			try {
				return (await handle.readFile("utf8")).slice(0, 1_000_000);
			} finally {
				await handle.close();
			}
		}
	}
	throw new Error("Function hook filesystem path is outside its declared grant");
}
