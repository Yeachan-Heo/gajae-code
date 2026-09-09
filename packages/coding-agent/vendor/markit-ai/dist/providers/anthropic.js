export const anthropic = {
    name: "anthropic",
    envKeys: ["ANTHROPIC_API_KEY", "MARKIT_API_KEY"],
    defaultBase: "https://api.anthropic.com",
    defaultModel: "claude-haiku-4-5",
    create(config, prompt) {
        return {
            describe: async (image, mimetype) => {
                const res = await fetch(`${config.apiBase}/v1/messages`, {
                    method: "POST",
                    headers: {
                        "Content-Type": "application/json",
                        "x-api-key": config.apiKey,
                        "anthropic-version": "2023-06-01",
                    },
                    body: JSON.stringify({
                        model: config.model,
                        max_tokens: 1024,
                        messages: [
                            {
                                role: "user",
                                content: [
                                    {
                                        type: "image",
                                        source: {
                                            type: "base64",
                                            media_type: mimetype,
                                            data: image.toString("base64"),
                                        },
                                    },
                                    { type: "text", text: prompt },
                                ],
                            },
                        ],
                    }),
                });
                if (!res.ok) {
                    const body = await res.text();
                    throw new Error(`Anthropic API error ${res.status}: ${body}`);
                }
                const data = await res.json();
                return data.content?.[0]?.text ?? "";
            },
            // Anthropic doesn't have a transcription API
        };
    },
};
