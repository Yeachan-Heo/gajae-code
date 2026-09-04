import { type FunctionHookRegistration, validateFunctionHookTarget } from "./function-hooks";

export type TaggedFunctionHookHandler = (...args: unknown[]) => Promise<unknown>;

const registrations = new WeakMap<TaggedFunctionHookHandler, FunctionHookRegistration>();

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
