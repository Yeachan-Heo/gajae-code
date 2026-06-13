import "./render-goldens-env";

import {
	captureRenderGolden,
	RENDER_GOLDEN_FIXTURES,
	type RenderGoldenCapture,
	writeRenderGolden,
} from "./render-goldens";

type ChildMode = "capture" | "update";

interface SerializedRenderGoldenCapture extends Omit<RenderGoldenCapture, "writeLog"> {
	writeLogBase64: string;
}

function serializeCapture(capture: RenderGoldenCapture): SerializedRenderGoldenCapture {
	return {
		fixtureName: capture.fixtureName,
		viewport: capture.viewport,
		scrollback: capture.scrollback,
		writeLogBase64: Buffer.from(capture.writeLog).toString("base64"),
		meta: capture.meta,
	};
}

const fixtureName = Bun.argv[2];
const mode = (Bun.argv[3] ?? "capture") as ChildMode;

if (!fixtureName) {
	console.error("Usage: bun render-goldens-child.ts <fixture> [capture|update]");
	process.exit(2);
}

if (mode !== "capture" && mode !== "update") {
	console.error(`Invalid render golden child mode: ${mode}`);
	process.exit(2);
}

const fixture = RENDER_GOLDEN_FIXTURES.find(candidate => candidate.name === fixtureName);
if (!fixture) {
	console.error(`Unknown render golden fixture: ${fixtureName}`);
	process.exit(2);
}

try {
	const capture = await captureRenderGolden(fixture);
	if (mode === "update") {
		await writeRenderGolden(capture);
	}
	process.stdout.write(`${JSON.stringify(serializeCapture(capture))}\n`);
} catch (error) {
	console.error(error instanceof Error ? error.stack : String(error));
	process.exit(1);
}
