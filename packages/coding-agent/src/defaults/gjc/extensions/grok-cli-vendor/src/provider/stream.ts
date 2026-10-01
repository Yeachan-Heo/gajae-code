import type {
  Api,
  AssistantMessageEventStream,
  Context,
  Model,
  SimpleStreamOptions,
} from '@gajae-code/ai/core';
import { streamOpenAIResponses } from '@gajae-code/ai/providers/openai-responses';
import { getGrokCliVersion, updateVersionFromError } from './version-manager';

let cachedVersion: string | null = null;

/**
 * Stream function that adds Grok CLI-specific headers to requests.
 *
 * GJC Grok Build extension sends cli-chat-proxy headers (see agent.models.grok-cli.yml):
 *   - x-grok-conv-id: <session/conversation ID>
 *   - x-grok-model-override: <model ID>
 *   - x-xai-token-auth: xai-grok-cli
 *   - x-grok-client-version: resolved dynamically with 426 error handling
 */
export function streamGrokCli(
  model: Model<Api>,
  context: Context,
  options?: SimpleStreamOptions,
): AssistantMessageEventStream {
  const sessionId = options?.sessionId;

  // Ensure we have a version available synchronously
  // The async getGrokCliVersion will prime the cache for next request
  if (cachedVersion === null) {
    // Initialize with async fetch for background updates
    getGrokCliVersion().then((version) => {
      cachedVersion = version;
    });
    // Use fallback immediately
    cachedVersion = '1.0.13';
  }

  const headers: Record<string, string> = {
    ...options?.headers,
    'x-grok-client-identifier': 'gjc-grok-cli',
    'x-grok-client-version': cachedVersion,
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
    async onResponse(response) {
      // Handle HTTP 426 "version outdated" errors
      if (response.status === 426) {
        try {
          const errorText = await response.text();
          const updatedVersion = updateVersionFromError(errorText);
          cachedVersion = updatedVersion;
        } catch (err) {
          // Silently ignore parse errors
        }
      }
      options?.onResponse?.(response, model);
    },
  });
}
