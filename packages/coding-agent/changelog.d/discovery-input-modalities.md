### Fixed

- OpenAI models-list discovery now reads the input modalities a catalog row advertises, at the top level (`input_modalities`) or under `capabilities.input_modalities`. Previously image support came only from bundled reference metadata, so a gateway model without a bundled match was always discovered as text-only even when the gateway advertised image input. An advertised list takes precedence over the bundled reference metadata, so a row that advertises text only is discovered as text-only; rows that advertise nothing keep the reference value.
