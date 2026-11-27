import { logger } from "@gajae-code/utils";
import type { DoctorProbeKind, DoctorProbeReceipt } from "./probe-types";
import { PROBE_OUTPUT_LIMIT_BYTES } from "./probe-types";

const loaders = {
	native: () => import("./native-probe"),
	projection: () => import("./projection-probe"),
	"session-owners": () => import("./session-owners-probe"),
};

async function collect(kind: DoctorProbeKind): Promise<DoctorProbeReceipt> {
	if (kind === "native") return (await loaders.native()).collectNativeProbe();
	if (kind === "projection") return (await loaders.projection()).collectProjectionProbe();
	return (await loaders["session-owners"]()).collectSessionOwnersProbe();
}

/** Only the fixed product probes are executable; no caller-provided program or module path. */
export async function runDoctorProbe(kind: DoctorProbeKind): Promise<void> {
	// The projection probe loads real product modules, and any warning they emit
	// would otherwise create `.gjc/logs/` entries. Diagnosis must not write
	// product state, so the rotating file sink is disabled before those modules
	// are loaded; the receipt still travels over stdout.
	logger.setTransports({ console: false, file: false });
	let receipt: DoctorProbeReceipt;
	try {
		receipt = await collect(kind);
	} catch {
		receipt = {
			schemaVersion: 1,
			kind,
			status: "failed",
			reasonCode: `${kind.replace("-", "_")}_load_failed`,
			checks: [],
		};
	}
	const text = JSON.stringify(receipt);
	if (Buffer.byteLength(text) > PROBE_OUTPUT_LIMIT_BYTES) {
		process.stdout.write(
			`${JSON.stringify({ schemaVersion: 1, kind, status: "failed", reasonCode: "limit_exceeded", checks: [] })}\n`,
		);
		process.exitCode = 1;
		return;
	}
	process.stdout.write(`${text}\n`);
	process.exitCode = receipt.status === "completed" ? 0 : 1;
}
