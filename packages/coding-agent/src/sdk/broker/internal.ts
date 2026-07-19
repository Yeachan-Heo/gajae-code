import type { Broker } from "./broker";

/** Wait for broker-local completion, then terminate only the current broker process. */
export async function completeBrokerProcess(
	broker: Broker,
	exit: (code: number) => never = code => process.exit(code),
): Promise<never> {
	await broker.completion;
	return exit(0);
}
