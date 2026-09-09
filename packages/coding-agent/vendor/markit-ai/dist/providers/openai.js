export const openai = {
    name: "openai",
    envKeys: ["OPENAI_API_KEY", "MARKIT_API_KEY"],
    defaultBase: "https://api.openai.com/v1",
    defaultModel: "gpt-4.1-nano",
    defaultTranscriptionModel: "gpt-4o-mini-transcribe",
    create(config, prompt) {
        return {
            describe: async (image, mimetype) => {
                const res = await fetch(`${config.apiBase}/chat/completions`, {
                    method: "POST",
                    headers: {
                        "Content-Type": "application/json",
                        Authorization: `Bearer ${config.apiKey}`,
                    },
                    body: JSON.stringify({
                        model: config.model,
                        messages: [
                            {
                                role: "user",
                                content: [
                                    { type: "text", text: prompt },
                                    {
                                        type: "image_url",
                                        image_url: {
                                            url: `data:${mimetype};base64,${image.toString("base64")}`,
                                        },
                                    },
                                ],
                            },
                        ],
                        max_tokens: 1024,
                    }),
                });
                if (!res.ok) {
                    const body = await res.text();
                    throw new Error(`OpenAI API error ${res.status}: ${body}`);
                }
                const data = await res.json();
                return data.choices?.[0]?.message?.content ?? "";
            },
            transcribe: async (audio, mimetype) => {
                const ext = mimeToExt(mimetype);
                const file = new File([new Uint8Array(audio)], `audio${ext}`, {
                    type: mimetype,
                });
                const formData = new FormData();
                formData.append("model", config.transcriptionModel || "gpt-4o-mini-transcribe");
                formData.append("file", file);
                const res = await fetch(`${config.apiBase}/audio/transcriptions`, {
                    method: "POST",
                    headers: { Authorization: `Bearer ${config.apiKey}` },
                    body: formData,
                });
                if (!res.ok) {
                    const body = await res.text();
                    throw new Error(`Transcription API error ${res.status}: ${body}`);
                }
                const data = await res.json();
                return data.text ?? "";
            },
        };
    },
};
function mimeToExt(mime) {
    const map = {
        "audio/mpeg": ".mp3",
        "audio/wav": ".wav",
        "audio/mp4": ".m4a",
        "video/mp4": ".mp4",
        "audio/ogg": ".ogg",
        "audio/flac": ".flac",
        "audio/aac": ".aac",
    };
    return map[mime] || ".mp3";
}
