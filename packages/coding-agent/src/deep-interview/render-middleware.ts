import {
	type Component,
	Container,
	isViewportAnchorSourceRenderer,
	Markdown,
	Spacer,
	Text,
	type ViewportAnchorProvider,
	type ViewportAnchorRender,
	type ViewportAnchorSource,
	type ViewportAnchorSourceRenderer,
} from "@gajae-code/tui";
import { getMarkdownTheme, type Theme } from "../modes/theme/theme";

interface RoundQuestionModel {
	kind: "round-question";
	round: string;
	component?: string;
	targeting?: string;
	mode?: string;
	whyNow?: string;
	ambiguity?: string;
	question: string;
}

interface TopologyQuestionModel {
	kind: "topology-question";
	context?: string;
	components: Array<{ name: string; description: string }>;
	question: string;
}

interface ProgressDimension {
	name: string;
	score: string;
	weight: string;
	weighted: string;
	gap: string;
}

interface ProgressModel {
	kind: "progress";
	round: string;
	dimensions: ProgressDimension[];
	ambiguity?: string;
	topology?: string;
	ontology?: string;
	nextTarget?: string;
	status?: string;
	extra?: string;
}

interface ThresholdModel {
	kind: "threshold";
	threshold: string;
	source: string;
	rest: string;
}

type DeepInterviewModel = RoundQuestionModel | TopologyQuestionModel | ProgressModel | ThresholdModel;

class DeepInterviewSemanticContainer extends Container implements ViewportAnchorProvider, ViewportAnchorSourceRenderer {
	#nextSource = 0;

	override addChild(component: Component): void {
		super.addChild(component);
		if (isViewportAnchorSourceRenderer(component)) {
			this.setViewportAnchorSource(component, { id: `deep-interview-part:${this.#nextSource++}` });
		}
	}

	override renderWithViewportAnchors(width: number): ViewportAnchorRender {
		const lines = super.renderWithViewportAnchors(width).lines;
		return { lines, anchors: lines.map(() => null) };
	}

	renderWithViewportAnchorSource(width: number, source: ViewportAnchorSource): ViewportAnchorRender {
		const rendered = super.renderWithViewportAnchors(width);
		const extents = new Map<string, { graphemeEnd: number; cellEnd: number }>();
		for (const anchor of rendered.anchors) {
			if (anchor === null) continue;
			const extent = extents.get(anchor.id);
			if (extent) {
				extent.graphemeEnd = Math.max(extent.graphemeEnd, anchor.graphemeEnd);
				extent.cellEnd = Math.max(extent.cellEnd, anchor.cellEnd);
			} else {
				extents.set(anchor.id, { graphemeEnd: anchor.graphemeEnd, cellEnd: anchor.cellEnd });
			}
		}
		const offsets = new Map<string, { grapheme: number; cell: number }>();
		let grapheme = 0;
		let cell = 0;
		for (const [id, extent] of extents) {
			offsets.set(id, { grapheme, cell });
			grapheme += extent.graphemeEnd;
			cell += extent.cellEnd;
		}
		return {
			lines: rendered.lines,
			anchors: rendered.anchors.map(anchor => {
				if (anchor === null) return null;
				const offset = offsets.get(anchor.id);
				if (!offset) throw new Error(`Missing deep-interview anchor offset for ${anchor.id}`);
				return {
					id: source.id,
					graphemeStart: offset.grapheme + anchor.graphemeStart,
					graphemeEnd: offset.grapheme + anchor.graphemeEnd,
					cellStart: offset.cell + anchor.cellStart,
					cellEnd: offset.cell + anchor.cellEnd,
				};
			}),
		};
	}
}

function normalizeText(text: string): string {
	if (typeof text !== "string") return "";
	return text.trim().replaceAll("\r\n", "\n");
}

function stripMarkdownEmphasis(value: string): string {
	return value.replace(/\*\*/g, "").replace(/^"|"$/g, "").trim();
}

function parseRoundQuestion(text: string): RoundQuestionModel | null {
	const normalized = normalizeText(text);
	const lines = normalized.split("\n");
	const headerIndex = lines.findIndex(line => /^Round\s+\d+\s+\|/i.test(line.trim()));
	if (headerIndex < 0) return null;
	const headerLine = lines[headerIndex]?.trim() ?? "";
	const body = lines
		.slice(headerIndex + 1)
		.join("\n")
		.trim();
	if (!body) return null;

	const componentMatch =
		/^Round\s+(\d+)\s+\|\s+Component:\s*(.*?)\s+\|\s+Targeting:\s*(.*?)\s+\|\s+Why now:\s*(.*?)\s+\|\s+Ambiguity:\s*(.+?)%?\s*$/i.exec(
			headerLine,
		);
	if (componentMatch) {
		return {
			kind: "round-question",
			round: componentMatch[1] ?? "?",
			component: componentMatch[2]?.trim(),
			targeting: componentMatch[3]?.trim(),
			whyNow: componentMatch[4]?.trim(),
			ambiguity: componentMatch[5]?.trim(),
			question: body,
		};
	}

	const targetingMatch =
		/^Round\s+(\d+)\s+\|\s+Targeting:\s*(.*?)\s+\|\s+Why now:\s*(.*?)\s+\|\s+Ambiguity:\s*(.+?)%?\s*$/i.exec(
			headerLine,
		);
	if (targetingMatch) {
		return {
			kind: "round-question",
			round: targetingMatch[1] ?? "?",
			targeting: targetingMatch[2]?.trim(),
			whyNow: targetingMatch[3]?.trim(),
			ambiguity: targetingMatch[4]?.trim(),
			question: body,
		};
	}

	const modeMatch = /^Round\s+(\d+)\s+\|\s+(.*?)\s+\|\s+Ambiguity:\s*(.+?)%?\s*$/i.exec(headerLine);
	if (modeMatch) {
		return {
			kind: "round-question",
			round: modeMatch[1] ?? "?",
			mode: modeMatch[2]?.trim(),
			ambiguity: modeMatch[3]?.trim(),
			question: body,
		};
	}

	return null;
}

function parseTopologyQuestion(text: string): TopologyQuestionModel | null {
	const normalized = normalizeText(text);
	const lines = normalized.split("\n");
	const headerIndex = lines.findIndex(line =>
		/^Round\s+0\s+\|\s+Topology confirmation\s+\|\s+Ambiguity:\s+not scored yet/i.test(line.trim()),
	);
	if (headerIndex < 0) {
		return null;
	}
	const components: TopologyQuestionModel["components"] = [];
	const contextLines: string[] = [];
	const questionLines: string[] = [];
	let inQuestion = false;
	for (const line of lines.slice(headerIndex + 1)) {
		const trimmed = line.trim();
		const component = /^\s*\d+\.\s+([^:]+):\s+(.+)$/.exec(line);
		if (component) {
			components.push({ name: component[1]?.trim() ?? "", description: component[2]?.trim() ?? "" });
			continue;
		}
		if (/\?$/.test(trimmed)) inQuestion = true;
		if (!trimmed) continue;
		if (inQuestion) questionLines.push(trimmed);
		else contextLines.push(trimmed);
	}
	return {
		kind: "topology-question",
		context: contextLines.join("\n") || undefined,
		components,
		question: questionLines.join("\n"),
	};
}

function splitMarkdownTableRow(line: string): string[] {
	const trimmed = line.trim();
	if (!trimmed.startsWith("|") || !trimmed.endsWith("|")) return [];
	return trimmed
		.slice(1, -1)
		.split("|")
		.map(cell => stripMarkdownEmphasis(cell));
}

function parseProgress(text: string): ProgressModel | null {
	const normalized = normalizeText(text);
	const roundMatch = /^Round\s+(\d+)\s+complete\./i.exec(normalized);
	if (!roundMatch) return null;

	const lines = normalized.split("\n");
	const dimensions: ProgressDimension[] = [];
	const extraLines: string[] = [];
	let ambiguity: string | undefined;
	let topology: string | undefined;
	let ontology: string | undefined;
	let nextTarget: string | undefined;
	let status: string | undefined;

	for (const [index, line] of lines.entries()) {
		if (index === 0) continue;
		const trimmed = line.trim();
		const cells = splitMarkdownTableRow(line);
		if (cells.length >= 5) {
			const [name = "", score = "", weight = "", weighted = "", gap = ""] = cells;
			if (/^-+$/.test(name) || /^Dimension$/i.test(name)) continue;
			if (/^Ambiguity$/i.test(name)) {
				ambiguity = weighted || score || gap;
				continue;
			}
			dimensions.push({ name, score, weight, weighted, gap });
			continue;
		}
		const topologyMatch = /^\*\*Topology:\*\*\s*(.+)$/.exec(trimmed);
		if (topologyMatch) {
			topology = topologyMatch[1]?.trim();
			continue;
		}
		const ontologyMatch = /^\*\*Ontology:\*\*\s*(.+)$/.exec(trimmed);
		if (ontologyMatch) {
			ontology = ontologyMatch[1]?.trim();
			continue;
		}
		const nextTargetMatch = /^\*\*Next target:\*\*\s*(.+)$/.exec(trimmed);
		if (nextTargetMatch) {
			nextTarget = nextTargetMatch[1]?.trim();
			continue;
		}
		if (/^(Clarity threshold met!|Focusing next question on:)/i.test(trimmed)) {
			status = trimmed;
			continue;
		}
		if (trimmed) extraLines.push(trimmed);
	}

	if (dimensions.length === 0 && !ambiguity && !topology && !ontology && !nextTarget) return null;
	return {
		kind: "progress",
		round: roundMatch[1] ?? "?",
		dimensions,
		ambiguity,
		topology,
		ontology,
		nextTarget,
		status,
		extra: extraLines.join("\n") || undefined,
	};
}

function parseThreshold(text: string): ThresholdModel | null {
	const normalized = normalizeText(text);
	const match = /^Deep Interview threshold:\s*(.*?)\s*\(source:\s*(.*?)\)\s*$/im.exec(normalized.split("\n")[0] ?? "");
	if (!match) return null;
	return {
		kind: "threshold",
		threshold: match[1]?.trim() ?? "",
		source: match[2]?.trim() ?? "",
		rest: normalized.split("\n").slice(1).join("\n").trim(),
	};
}

function parseDeepInterview(text: string): DeepInterviewModel | null {
	return parseProgress(text) ?? parseTopologyQuestion(text) ?? parseRoundQuestion(text) ?? parseThreshold(text);
}

function addLabel(container: Container, label: string, value: string | undefined, uiTheme: Theme): void {
	if (!value) return;
	container.addChild(new Spacer(1));
	container.addChild(new Text(uiTheme.fg("accent", uiTheme.bold(label)), 0, 0));
	container.addChild(
		new Markdown(value, 2, 0, getMarkdownTheme(), { color: (text: string) => uiTheme.fg("toolOutput", text) }),
	);
}

function renderPipeSummary(title: string, value: string | undefined): string | undefined {
	if (!value) return undefined;
	return (
		value
			.split("|")
			.map(part => part.trim())
			.filter(Boolean)
			.map(part => `- ${part}`)
			.join("\n") || title
	);
}

function renderModel(model: DeepInterviewModel, uiTheme: Theme): Component {
	const container = new DeepInterviewSemanticContainer();
	if (model.kind === "round-question") {
		const meta = [
			`Round ${model.round}`,
			model.ambiguity ? `Ambiguity ${model.ambiguity.replace(/%$/, "")}%` : undefined,
		]
			.filter(Boolean)
			.join(" · ");
		container.addChild(new Text(uiTheme.fg("toolTitle", uiTheme.bold(`Deep Interview · ${meta}`)), 0, 0));
		addLabel(container, "Component", model.component, uiTheme);
		addLabel(container, "Mode", model.mode, uiTheme);
		addLabel(container, "Target", model.targeting, uiTheme);
		addLabel(container, "Why now", model.whyNow, uiTheme);
		addLabel(container, "Question", model.question, uiTheme);
		return container;
	}

	if (model.kind === "topology-question") {
		container.addChild(
			new Text(uiTheme.fg("toolTitle", uiTheme.bold("Deep Interview · Round 0 · Topology confirmation")), 0, 0),
		);
		addLabel(container, "Ambiguity", "Not scored yet", uiTheme);
		addLabel(container, "Reading", model.context, uiTheme);
		if (model.components.length > 0) {
			const components = model.components
				.map((component, index) => `${index + 1}. **${component.name}**\n   ${component.description}`)
				.join("\n\n");
			addLabel(container, "Components", components, uiTheme);
		}
		addLabel(container, "Question", model.question, uiTheme);
		return container;
	}

	if (model.kind === "progress") {
		container.addChild(
			new Text(uiTheme.fg("toolTitle", uiTheme.bold(`Deep Interview · Round ${model.round} complete`)), 0, 0),
		);
		addLabel(container, "Ambiguity", model.ambiguity, uiTheme);
		if (model.dimensions.length > 0) {
			container.addChild(new Spacer(1));
			container.addChild(new Text(uiTheme.fg("accent", uiTheme.bold("Clarity")), 0, 0));
			for (const dimension of model.dimensions) {
				const body = [`Score ${dimension.score} · weight ${dimension.weight} · weighted ${dimension.weighted}`];
				if (dimension.gap) body.push(/^clear$/i.test(dimension.gap) ? "Clear" : `Gap: ${dimension.gap}`);
				addLabel(container, dimension.name, body.join("\n"), uiTheme);
			}
		}
		addLabel(container, "Topology", renderPipeSummary("Topology", model.topology), uiTheme);
		addLabel(container, "Ontology", renderPipeSummary("Ontology", model.ontology), uiTheme);
		addLabel(container, "Next target", model.nextTarget, uiTheme);
		addLabel(container, "Status", model.status, uiTheme);
		addLabel(container, "Additional details", model.extra, uiTheme);
		return container;
	}

	container.addChild(new Text(uiTheme.fg("toolTitle", uiTheme.bold("Deep Interview · Started")), 0, 0));
	addLabel(container, "Threshold", `${model.threshold} · source: ${model.source}`, uiTheme);
	addLabel(container, "Details", model.rest, uiTheme);
	return container;
}

export function renderDeepInterviewAssistantText(text: string, uiTheme: Theme): Component | null {
	const model = parseDeepInterview(text);
	if (!model || model.kind === "round-question" || model.kind === "topology-question") return null;
	return renderModel(model, uiTheme);
}

export function renderDeepInterviewAskQuestion(question: string, uiTheme: Theme): Component | null {
	const model = parseTopologyQuestion(question) ?? parseRoundQuestion(question);
	if (!model) return null;
	return renderModel(model, uiTheme);
}

export function isDeepInterviewAskQuestion(question: string): boolean {
	if (parseTopologyQuestion(question) ?? parseRoundQuestion(question)) return true;
	const normalized = normalizeText(question);
	return /(?:^|\n)\s*Round\s+\d+\s*\|.*?\bAmbiguity\b/i.test(normalized);
}

export function formatDeepInterviewSelectorPrompt(question: string): string | null {
	const model = parseTopologyQuestion(question) ?? parseRoundQuestion(question);
	if (!model) return null;
	if (model.kind === "topology-question") {
		const componentLines =
			model.components.length > 0
				? [
						"Components:",
						...model.components.map(
							(component, index) => `${index + 1}. ${component.name} — ${component.description}`,
						),
					]
				: [];
		return [
			"Deep Interview · Round 0 · Topology confirmation",
			"Ambiguity: not scored yet",
			model.context ? `Reading:\n${model.context}` : undefined,
			...componentLines,
			model.question ? `Question:\n${model.question}` : undefined,
		]
			.filter((line): line is string => Boolean(line))
			.join("\n\n");
	}
	return [
		`Deep Interview · Round ${model.round}${model.ambiguity ? ` · Ambiguity ${model.ambiguity.replace(/%$/, "")}%` : ""}`,
		model.component ? `Component: ${model.component}` : undefined,
		model.mode ? `Mode: ${model.mode}` : undefined,
		model.targeting ? `Target: ${model.targeting}` : undefined,
		model.whyNow ? `Why now: ${model.whyNow}` : undefined,
		model.question,
	]
		.filter((line): line is string => Boolean(line))
		.join("\n");
}
