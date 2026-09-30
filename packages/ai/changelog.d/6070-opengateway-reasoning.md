### Fixed

- OpenGateway models discovered from `/v1/models` now take their capabilities from the bundled catalog entry for the same upstream model, and `-ultrafast` deployments resolve to their upstream model, so `opengateway/deepseek/deepseek-v4.1-flash-ultrafast` and the GLM/Kimi ultrafast models are registered with reasoning support and accept thinking levels (#6070).
