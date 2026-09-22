### Fixed

- Return expired coordinator turn observations without an MCP tool error, preventing normal waits from triggering host failure breakers. Preserve the legacy timeout payload and add `wait_expired:true`; actual request failures remain errors.
