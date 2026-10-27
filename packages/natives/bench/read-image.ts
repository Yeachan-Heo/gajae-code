// A/B adapter for SIXEL image encoding used to display read(image) results.
import { encodeSixel } from "@gajae-code/natives";
import { runAbSuite } from "./ab-adapter";

const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==", "base64");
const TARGET_WIDTH = 160;
const TARGET_HEIGHT = 96;

await runAbSuite(
	"read-image",
	[
		{
			id: "I01",
			run: async () => {
				const sixel = await encodeSixel(PNG, TARGET_WIDTH, TARGET_HEIGHT);
				if (!sixel.startsWith("\x1bP")) throw new Error("Image fixture did not produce a SIXEL sequence");
			},
		},
	],
	100,
);
