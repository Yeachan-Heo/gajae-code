### Fixed

- The `/model` picker now treats a successful LiteLLM proxy model discovery response as authoritative, hiding bundled reference models that the proxy did not enroll while retaining the bundled catalog when discovery is unavailable (#5720).
