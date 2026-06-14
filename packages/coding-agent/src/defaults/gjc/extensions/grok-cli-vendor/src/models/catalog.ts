/**
 * Model definitions for Grok CLI's API.
 */

// ─── Cost constants ($/M tokens) ──────────────────────────────────────────────

const COST_BUILD = { input: 1, output: 2, cacheRead: 0.2, cacheWrite: 0.2 };
const COST_COMPOSER_FAST = { input: 3, output: 15, cacheRead: 0.5, cacheWrite: 0 };
const COST_43 = { input: 1.25, output: 2.5, cacheRead: 0.2, cacheWrite: 0 };
const COST_420 = { input: 2, output: 6, cacheRead: 0.2, cacheWrite: 0 };

// ─── Model type ───────────────────────────────────────────────────────────────

export interface GrokCliModelConfig {
  id: string;
  name: string;
  reasoning: boolean;
  input: ('text' | 'image')[];
  cost: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
  };
  contextWindow: number;
  maxTokens: number;
  /** Models that don't support reasoning.effort get a thinkingLevelMap. */
  thinkingLevelMap?: Record<string, string | null>;
}

// ─── Hardcoded fallback catalog ───────────────────────────────────────────────
//
// These are the models observed via the Grok CLI's /v1/models endpoint and
// the actual traffic captured through cli-chat-proxy.grok.com.

const FALLBACK_MODELS: GrokCliModelConfig[] = [
  {
    id: 'grok-composer-2.5-fast',
    name: 'Composer 2.5 Fast (Grok CLI)',
    reasoning: false,
    input: ['text', 'image'],
    cost: COST_COMPOSER_FAST,
    contextWindow: 200_000,
    maxTokens: 30_000,
    thinkingLevelMap: {
      off: 'none',
      minimal: null,
      low: null,
      medium: null,
      high: null,
      xhigh: null,
    },
  },
  {
    id: 'grok-build',
    name: 'Grok Build',
    reasoning: true,
    input: ['text', 'image'],
    cost: COST_BUILD,
    contextWindow: 512_000,
    maxTokens: 30_000,
  },
  {
    id: 'grok-4.3',
    name: 'Grok 4.3',
    reasoning: true,
    input: ['text', 'image'],
    cost: COST_43,
    contextWindow: 1_000_000,
    maxTokens: 30_000,
  },
  {
    id: 'grok-4.20-0309-reasoning',
    name: 'Grok 4.20 Reasoning',
    reasoning: true,
    input: ['text', 'image'],
    cost: COST_420,
    contextWindow: 2_000_000,
    maxTokens: 30_000,
  },
  {
    id: 'grok-4.20-0309-non-reasoning',
    name: 'Grok 4.20 Non-Reasoning',
    reasoning: false,
    input: ['text', 'image'],
    cost: COST_420,
    contextWindow: 2_000_000,
    maxTokens: 30_000,
    thinkingLevelMap: {
      off: 'none',
      minimal: null,
      low: null,
      medium: null,
      high: null,
      xhigh: null,
    },
  },
  {
    id: 'grok-4.20-multi-agent-0309',
    name: 'Grok 4.20 Multi-Agent',
    reasoning: true,
    input: ['text', 'image'],
    cost: COST_420,
    contextWindow: 2_000_000,
    maxTokens: 30_000,
  },
];

const EFFORT_CAPABLE_PREFIXES = ['grok-3-mini', 'grok-4.20-multi-agent', 'grok-4.3'];

export function supportsReasoningEffort(modelId: string): boolean {
  const parts = modelId.split('/');
  const name = (parts.at(-1) ?? modelId).toLowerCase();
  if (!EFFORT_CAPABLE_PREFIXES.some((prefix) => name.startsWith(prefix))) {
    return false;
  }
  const model = resolveModels().find((entry) => entry.id.toLowerCase() === name);
  if (model) {
    if (!model.reasoning) return false;
    if (!model.thinkingLevelMap) return true;
    return Object.values(model.thinkingLevelMap).some(
      (level) => level !== null && level !== 'none',
    );
  }
  // Effort-capable id not listed in GJC_GROK_CLI_MODELS env list — still honor prefix (avoids spurious 400s).
  return true;
}

// ─── GJC_GROK_CLI_MODELS env override ─────────────────────────────────────

/**
 * Resolve the active model list. If `GJC_GROK_CLI_MODELS` is set,
 * it filters/reorders the fallback list; unknown IDs get sensible defaults.
 */
export function resolveModels(): GrokCliModelConfig[] {
  const env = (process.env.GJC_GROK_CLI_MODELS || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  if (env.length === 0) return FALLBACK_MODELS;

  const byId = new Map(FALLBACK_MODELS.map((m) => [m.id, m]));
  return env.map(
    (id) =>
      byId.get(id) ?? {
        id,
        name: id,
        reasoning: true,
        input: ['text'] as ('text' | 'image')[],
        cost: COST_BUILD,
        contextWindow: 1_000_000,
        maxTokens: 30_000,
      },
  );
}
