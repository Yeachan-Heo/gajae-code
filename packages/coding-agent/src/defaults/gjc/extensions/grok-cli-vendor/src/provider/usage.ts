import type { Api, Model } from '@gajae-code/ai';
import type { ExtensionAPI } from '@gajae-code/coding-agent';
import { XaiOAuthError } from '../shared/errors.js';
import { fetchBillingUsage, formatQuota } from './billing.js';

export function registerUsageCommand(api: Pick<ExtensionAPI, 'registerCommand'>) {
  api.registerCommand('grok-build-usage', {
    description: 'Show Grok Build provider status, quota, and token health',
    handler: async (_args, ctx) => {
      const token = process.env.GROK_CLI_OAUTH_TOKEN;
      if (token) {
        ctx.ui.notify(
          '⚠️  Grok Build: using GROK_CLI_OAUTH_TOKEN env bypass — no auto-refresh available',
          'warning',
        );
      }

      try {
        const registry = ctx.modelRegistry;
        const grokModels = registry.getAll().filter((m: Model<Api>) => m.provider === 'grok-build');
        if (grokModels.length === 0) {
          ctx.ui.notify(
            'Grok Build: no models registered. Run /login grok-build first.',
            'warning',
          );
          return;
        }

        const apiKey = token ?? (await registry.getApiKeyForProvider?.('grok-build'));
        if (!apiKey) {
          ctx.ui.notify(formatQuota(undefined).join('\n'), 'info');
          return;
        }

        try {
          ctx.ui.notify('Fetching grok build usage…', 'info');
          ctx.ui.notify(formatQuota(await fetchBillingUsage(apiKey)).join('\n'), 'info');
        } catch (err) {
          ctx.ui.notify(
            `Grok Build billing refresh failed: ${err instanceof Error ? err.message : String(err)}`,
            'warning',
          );
          ctx.ui.notify(formatQuota(undefined).join('\n'), 'info');
        }
      } catch (err) {
        const msg =
          err instanceof XaiOAuthError
            ? `${err.message} (code: ${err.code})`
            : err instanceof Error
              ? err.message
              : String(err);
        ctx.ui.notify(`Grok Build: ${msg}`, 'warning');
      }
    },
  });
}
