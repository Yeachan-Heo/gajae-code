### Fixed

- Restore MiniMax-M3 reasoning on/off controls in model selection and reasoning menus for the international and China MiniMax and Coding Plan routes. Send the native `adaptive`/`disabled` switch instead of unsupported reasoning-effort or token-budget parameters, and explicitly disable thinking when the agent selects off (#5626).
- Show MiniMax M2.x reasoning as always on rather than offering ineffective effort or off controls. Keep model-role labels and the status line consistent with these capabilities.
- Restrict MiniMax-native thinking behavior to validated first-party HTTPS endpoints and API paths, including the resolved endpoint at request time. Custom proxies retaining a MiniMax provider ID no longer inherit the native thinking contract.
