import type {
  Api,
  AssistantMessageEventStream,
  Context,
  Model,
  SimpleStreamOptions,
} from '@gajae-code/ai/core';
import { streamOpenAIResponses } from '@gajae-code/ai/providers/openai-responses';
import { getGrokCliVersion, updateVersionFromError } from './version-manager';

/**
 * Stream function that adds Grok CLI-specific headers to requests.
 *
 * GJC Grok Build extension sends cli-chat-proxy headers (see agent.models.grok-cli.yml):
 *   - x-grok-conv-id: <session/conversation ID>
 *   - x-grok-model-override: <model ID>
 *   - x-xai-token-auth: xai-grok-cli
 *   - x-grok-client-version: resolved dynamically from GitHub releases (cached)
 */
export function streamGrokCli(
  model: Model<Api>,
  context: Context,
  options?: SimpleStreamOptions,
): AssistantMessageEventStream {
  const sessionId = options?.sessionId;

  // Get the cached Grok CLI version (or fallback if not yet fetched)
  // The version manager fetches from GitHub in the background on first call
  const grokCliVersion = getGrokCliVersion();

  const headers: Record<string, string> = {
    ...options?.headers,
    'x-grok-client-identifier': 'gjc-grok-cli',
    'x-grok-client-version': grokCliVersion,
    'x-xai-token-auth': 'xai-grok-cli',
    'x-grok-model-override': model.id,
  };

  if (sessionId) {
    headers['x-grok-conv-id'] = sessionId;
  }

  const responsesModel = {
    ...model,
    api: 'openai-responses',
  } as Model<'openai-responses'>;

  return streamOpenAIResponses(responsesModel, context, {
    ...options,
    headers,
    onResponse(response) {
      // Handle HTTP 426 "version outdated" errors by updating the cache
      if (response.status === 426) {
        response
          .text()
          .then((errorText) => {
            updateVersionFromError(errorText);
          })
          .catch(() => {
            // Silently ignore errors reading response text
          });
      }
      // Forward to any existing onResponse handler
      options?.onResponse?.(response, model);
    },
  });
}
