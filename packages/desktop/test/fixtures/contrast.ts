/** One measured element: its text and the WCAG contrast ratio against what is painted behind it. */
export interface ContrastSample {
	selector: string;
	text: string;
	ratio: number;
}

/**
 * Page-side and self-contained (pass it to `page.evaluate`): the WCAG 2 contrast ratio of the first
 * element matching each selector, text color against the background painted behind it. Translucent
 * backgrounds are composited over their ancestors' up to the first opaque one, so a tinted card
 * reads the same as on screen. Computed colors arrive as `rgb()`/`rgba()` or, for `color-mix`, as
 * `color(srgb …)`; anything else is reported rather than guessed. A missing element is an error,
 * so a renamed class cannot make a check pass by measuring nothing.
 */
export function measureContrast(selectors: string[]): ContrastSample[] {
	type Rgba = [number, number, number, number];
	const parse = (value: string): Rgba => {
		const legacy = /^rgba?\(([^)]+)\)$/u.exec(value);
		if (legacy) {
			const [r = 0, g = 0, b = 0, a = 1] = legacy[1]!
				.split(/[\s,/]+/u)
				.filter(Boolean)
				.map(Number);
			return [r / 255, g / 255, b / 255, a];
		}
		const srgb = /^color\(srgb ([^)]+)\)$/u.exec(value);
		if (srgb) {
			const [r = 0, g = 0, b = 0, a = 1] = srgb[1]!
				.split(/[\s/]+/u)
				.filter(Boolean)
				.map(Number);
			return [r, g, b, a];
		}
		throw new Error(`Unsupported computed color: ${value}`);
	};
	const over = (top: Rgba, below: Rgba): Rgba => {
		const alpha = top[3] + below[3] * (1 - top[3]);
		if (alpha === 0) return [0, 0, 0, 0];
		const channel = (index: number) => (top[index]! * top[3] + below[index]! * below[3] * (1 - top[3])) / alpha;
		return [channel(0), channel(1), channel(2), alpha];
	};
	const background = (element: Element): Rgba => {
		const layers: Rgba[] = [];
		for (let node: Element | null = element; node; node = node.parentElement) {
			const layer = parse(getComputedStyle(node).backgroundColor);
			if (layer[3] > 0) layers.push(layer);
			if (layer[3] >= 1) break;
		}
		return layers.reduceRight<Rgba>((below, top) => over(top, below), [1, 1, 1, 1]);
	};
	const luminance = ([r, g, b]: Rgba) => {
		const linear = (channel: number) => (channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4);
		return 0.2126 * linear(r) + 0.7152 * linear(g) + 0.0722 * linear(b);
	};
	return selectors.map(selector => {
		const element = document.querySelector(selector);
		if (!element) throw new Error(`No element for contrast check: ${selector}`);
		const behind = background(element);
		const text = over(parse(getComputedStyle(element).color), behind);
		const [light, dark] = [luminance(text), luminance(behind)].sort((a, b) => b - a);
		return {
			selector,
			text: element.textContent?.trim() ?? "",
			ratio: Math.round(((light! + 0.05) / (dark! + 0.05)) * 100) / 100,
		};
	});
}
