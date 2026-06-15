import type { Component } from "../tui";
import { applyBackgroundToLine, padding, visibleWidth } from "../utils";

type Cache = {
	key: bigint | number;
	result: string[];
};

/**
 * Box component - a container that applies padding and background to all children
 */
export class Box implements Component {
	children: Component[] = [];
	#disposed = false;
	#paddingX: number;
	#paddingY: number;
	#bgFn?: (text: string) => string;

	// Cache for rendered output
	#cached?: Cache;

	constructor(paddingX = 1, paddingY = 1, bgFn?: (text: string) => string) {
		this.#paddingX = paddingX;
		this.#paddingY = paddingY;
		this.#bgFn = bgFn;
	}

	addChild(component: Component): void {
		this.children.push(component);
		this.#invalidateCache();
	}

	removeChild(component: Component): void {
		const index = this.children.indexOf(component);
		if (index !== -1) {
			this.children.splice(index, 1);
			this.#invalidateCache();
			component.dispose?.();
		}
	}

	/** Remove a child without disposing it (for detach-then-readd reuse). */
	detachChild(component: Component): void {
		const index = this.children.indexOf(component);
		if (index !== -1) {
			this.children.splice(index, 1);
			this.#invalidateCache();
		}
	}

	clear(): void {
		for (const child of this.children) {
			child.dispose?.();
		}
		this.children = [];
		this.#invalidateCache();
	}

	/** Remove all children without disposing them (for detach-then-readd reuse). */
	detachAll(): void {
		this.children = [];
		this.#invalidateCache();
	}

	dispose(): void {
		if (this.#disposed) return;
		this.#disposed = true;
		for (const child of this.children) {
			child.dispose?.();
		}
		this.#invalidateCache();
	}

	setBgFn(bgFn?: (text: string) => string): void {
		this.#bgFn = bgFn;
		// Don't invalidate here - we'll detect bgFn changes by sampling output
	}

	#invalidateCache(): void {
		this.#cached = undefined;
	}

	static #tmp = new Uint32Array(2);
	#computeCacheKey(width: number, childLines: string[], bgSample: string | undefined): bigint | number {
		Box.#tmp[0] = width;
		Box.#tmp[1] = childLines.length;
		let h = Bun.hash(Box.#tmp);
		for (const line of childLines) {
			h = Bun.hash(line, h);
		}
		if (bgSample) {
			h = Bun.hash(bgSample, h);
		}
		return h;
	}

	#matchCache(cacheKey: bigint | number): boolean {
		return this.#cached?.key === cacheKey;
	}

	invalidate(): void {
		this.#invalidateCache();
		for (const child of this.children) {
			child.invalidate?.();
		}
	}

	render(width: number): string[] {
		if (this.children.length === 0) {
			return [];
		}

		const contentWidth = Math.max(1, width - this.#paddingX * 2);
		const leftPad = padding(this.#paddingX);

		// Render all children
		const childLines: string[] = [];
		for (const child of this.children) {
			const lines = child.render(contentWidth);
			for (const line of lines) {
				childLines.push(leftPad + line);
			}
		}

		if (childLines.length === 0) {
			return [];
		}

		// Check if bgFn output changed by sampling
		const bgSample = this.#bgFn ? this.#bgFn("test") : undefined;

		const cacheKey = this.#computeCacheKey(width, childLines, bgSample);

		// Check cache validity
		if (this.#matchCache(cacheKey)) {
			return this.#cached!.result;
		}

		// Apply background and padding
		const result: string[] = [];

		// Top padding
		for (let i = 0; i < this.#paddingY; i++) {
			result.push(this.#applyBg("", width));
		}

		// Content
		for (const line of childLines) {
			result.push(this.#applyBg(line, width));
		}

		// Bottom padding
		for (let i = 0; i < this.#paddingY; i++) {
			result.push(this.#applyBg("", width));
		}

		// Update cache
		this.#cached = { key: cacheKey, result };

		return result;
	}

	#applyBg(line: string, width: number): string {
		const visLen = visibleWidth(line);
		const padNeeded = Math.max(0, width - visLen);
		const padded = line + padding(padNeeded);

		if (this.#bgFn) {
			return applyBackgroundToLine(padded, width, this.#bgFn);
		}
		return padded;
	}
}
