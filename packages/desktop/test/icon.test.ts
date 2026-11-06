import { expect, test } from "bun:test";
import puppeteer from "puppeteer-core";
import { browserPath } from "./component-fixture";

test.skipIf(!browserPath)(
	"app icon keeps macOS optical margins at source and Dock sizes",
	async () => {
		const bytes = await Bun.file(`${import.meta.dir}/../icon.png`).arrayBuffer();
		const browser = await puppeteer.launch({ executablePath: browserPath, headless: true });
		try {
			const page = await browser.newPage();
			const result = await page.evaluate(
				async source => {
					const image = new Image();
					image.src = source;
					await image.decode();
					const bounds = [1024, 128, 64, 32].map(size => {
						const canvas = new OffscreenCanvas(size, size);
						const context = canvas.getContext("2d");
						if (!context) throw new Error("Cannot inspect icon pixels");
						context.drawImage(image, 0, 0, size, size);
						const { data } = context.getImageData(0, 0, size, size);
						let left = size,
							top = size,
							right = -1,
							bottom = -1;
						let paddingPixels = 0;
						let silhouettePixels = 0;
						for (let y = 0; y < size; y++) {
							for (let x = 0; x < size; x++) {
								const alpha = data[(y * size + x) * 4 + 3];
								if (size === 1024 && (x < 100 || x >= 924 || y < 100 || y >= 924)) {
									if (alpha !== 0) paddingPixels++;
								}
								// Artwork protruding beyond the rounded tile makes macOS add a white fallback plate.
								if (size === 1024 && alpha !== 0) {
									const dx = Math.max(284 - x, 0, x - 739);
									const dy = Math.max(284 - y, 0, y - 739);
									if (Math.hypot(dx, dy) > 185) silhouettePixels++;
								}
								if (alpha < 128) continue;
								left = Math.min(left, x);
								top = Math.min(top, y);
								right = Math.max(right, x);
								bottom = Math.max(bottom, y);
							}
						}
						return { size, bounds: [left, top, right, bottom], paddingPixels, silhouettePixels };
					});
					return { width: image.naturalWidth, height: image.naturalHeight, bounds };
				},
				`data:image/png;base64,${Buffer.from(bytes).toString("base64")}`,
			);
			expect([result.width, result.height]).toEqual([1024, 1024]);
			expect(result.bounds).toEqual([
				{ size: 1024, bounds: [100, 100, 923, 923], paddingPixels: 0, silhouettePixels: 0 },
				{ size: 128, bounds: [12, 12, 115, 115], paddingPixels: 0, silhouettePixels: 0 },
				{ size: 64, bounds: [6, 6, 57, 57], paddingPixels: 0, silhouettePixels: 0 },
				{ size: 32, bounds: [3, 3, 28, 28], paddingPixels: 0, silhouettePixels: 0 },
			]);
		} finally {
			await browser.close();
		}
	},
	30000,
);
