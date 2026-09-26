### Fixed

- Kiro CodeWhisperer OAuth endpoint now correctly resolves to `codewhisperer.${region}.amazonaws.com` instead of the non-existent `amazoncodewhispererstreamingservice.${region}.amazonaws.com`. OAuth bearer token authentication requests targeting `AmazonCodeWhispererService.GenerateAssistantResponse` now route to a resolvable endpoint that matches the working endpoint used by API-key authentication. (#6002)
