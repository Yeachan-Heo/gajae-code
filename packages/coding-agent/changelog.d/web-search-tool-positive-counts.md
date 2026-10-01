### Fixed

- The `web_search` tool schema now declares `limit` and `num_search_results` as positive integers, so a model-supplied `0`, negative or fractional count is rejected at validation instead of reaching providers, where a negative count silently dropped sources from the end of the list.
