/**
 * Reserved logical provider namespace for the preset-as-model facade.
 *
 * Kept dependency-free because machine entrypoints use the namespace when
 * filtering projected models and must not pull the model registry/session host
 * graph into their static import closure.
 */
export const SYNTHETIC_PROVIDER_ID = "gajae-code";
