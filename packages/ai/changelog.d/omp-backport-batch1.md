### Fixed

- Drops malformed function_call arguments from Responses replay that wedge sessions with 400 JSON parse errors (port omp f059bc8b18)
- Removes Gemini-unsupported minP and repetitionPenalty parameters from Google provider transports (port omp 96a5a29baf)
