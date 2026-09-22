### Fixed

- The advertised `CoordinatorQuestionAnswerV1` answer schema now declares its allowed fields in a sibling `properties` map, so `additionalProperties: false` no longer rejects every selection, free-text (`other`/`custom`), and `clarify` payload in standards-compliant client validators before the coordinator is called. Each `oneOf` branch stays closed, so valid field combinations are unchanged.
