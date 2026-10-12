### Fixed

- SearXNG no longer attaches an operator environment credential (`SEARXNG_TOKEN` or basic-auth username and password) to an endpoint that came from the project settings layer. A complete credential set in that project layer is still sent. An incomplete project basic-auth pair is not filled from the environment and does not fail the search. An endpoint and credential that both come from the operator environment are still sent.
