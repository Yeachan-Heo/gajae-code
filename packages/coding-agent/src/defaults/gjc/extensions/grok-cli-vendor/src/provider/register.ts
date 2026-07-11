/**
 * GJC Grok Build provider — SuperGrok OAuth + cli-chat-proxy models.
 */

import type { Api, Model } from '@gajae-code/ai';
import { Effort } from '@gajae-code/ai/model-thinking';
import type { OAuthCredentials, OAuthLoginCallbacks } from '@gajae-code/ai/utils/oauth/types';
import { loginXai, refreshXaiToken, XAI_OAUTH_SCOPE } from '@gajae-code/ai/utils/oauth/xai';
import type { ExtensionAPI, ProviderConfig } from '@gajae-code/coding-agent';
import { type GrokCliModelConfig, resolveModels } from '../models/catalog.js';
import { sanitizePayload } from '../payload/sanitize.js';
import { getBaseUrl, isGrokBuildBaseUrlOverrideIgnored } from '../shared/base-url.js';
import { streamGrokCli } from './stream.js';
import { registerUsageCommand } from './usage.js';

const GROK_BUILD_XAI_AUTHORIZE_PARAMS = {
  plan: 'generic',
  referrer: 'gjc-grok-cli',
} satisfies Readonly<Record<string, string>>;

const GROK_BUILD_XAI_REFRESH_PARAMS = {
  scope: XAI_OAUTH_SCOPE,
  ...GROK_BUILD_XAI_AUTHORIZE_PARAMS,
} satisfies Readonly<Record<string, string>>;

export default function registerGrokCli(api: ExtensionAPI) {
  const baseUrl = getBaseUrl();
  const models = resolveModels();

  api.registerProvider('grok-build', {
    baseUrl,
    apiKey: process.env.GROK_CLI_OAUTH_TOKEN ? 'GROK_CLI_OAUTH_TOKEN' : undefined,
    api: 'grok-cli-responses',
    models: models.map((m: GrokCliModelConfig) => ({
      id: m.id,
      name: m.name,
      reasoning: m.reasoning,
      thinking: m.reasoning
        ? {
            minLevel: Effort.Low,
            maxLevel: m.maxReasoningEffort ?? Effort.XHigh,
            mode: 'effort',
          }
        : undefined,
      input: m.input,
      cost: m.cost,
      contextWindow: m.contextWindow,
      maxTokens: m.maxTokens,
    })),
    oauth: {
      name: 'Grok Build',

      async login(callbacks: OAuthLoginCallbacks): Promise<OAuthCredentials> {
        return loginXai(callbacks, { extraAuthorizeParams: GROK_BUILD_XAI_AUTHORIZE_PARAMS });
      },

      async refreshToken(credentials: OAuthCredentials): Promise<OAuthCredentials> {
        return refreshXaiToken(credentials.refresh, {
          extraTokenParams: GROK_BUILD_XAI_REFRESH_PARAMS,
        });
      },

      getApiKey(credentials: OAuthCredentials): string {
        return credentials.access;
      },

      modifyModels(models: Model<Api>[], _credentials: OAuthCredentials) {
        const effectiveBaseUrl = getBaseUrl().replace(/\/+$/, '');

        return models.map((m) =>
          m.provider === 'grok-build' ? { ...m, baseUrl: effectiveBaseUrl } : m,
        );
      },
    } satisfies ProviderConfig['oauth'],

    streamSimple: streamGrokCli,
  });

  api.on('session_start', (_event, ctx) => {
    if (process.env.GROK_CLI_OAUTH_TOKEN) {
      ctx.ui.notify(
        '[Grok Build] Using GROK_CLI_OAUTH_TOKEN env bypass — no auto-refresh, no model discovery. Login with /login grok-build for persisted refreshable auth.',
        'warning',
      );
    }
    if (isGrokBuildBaseUrlOverrideIgnored()) {
      ctx.ui.notify(
        '[Grok Build] Ignoring unsafe Grok base URL override for OAuth credential safety. Set GJC_GROK_CLI_ALLOW_UNSAFE_BASE_URL=1 only for trusted local testing.',
        'warning',
      );
    }
  });

  api.on('before_provider_request', (event, ctx) => {
    if (ctx.model?.provider !== 'grok-build') return;

    const modelId = ctx.model?.id ?? '';
    const sessionId = ctx.sessionManager?.getSessionId();
    return sanitizePayload(event.payload as Record<string, unknown>, modelId, sessionId, ctx.cwd);
  });

  registerUsageCommand(api);
}
