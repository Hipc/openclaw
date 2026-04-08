/**
 * STT (Speech-to-Text) gateway plugin.
 *
 * Registers the `stt.send` gateway method which accepts the same parameters as
 * `chat.send`, except:
 *   - `message` carries base64-encoded audio data (supports optional
 *     `data:<mime>;base64,<data>` prefix)
 *   - `configName` selects which named STT config entry to use
 *
 * After successful transcription the text is forwarded to the session
 * identified by `sessionKey` via the subagent runtime.
 *
 * Plugin config lives in openclaw.json under `plugins.entries.stt.config`:
 * ```json
 * {
 *   "plugins": {
 *     "entries": {
 *       "stt": {
 *         "config": {
 *           "select": "openai",
 *           "configs": {
 *             "openai": { "type": "openai", "apikey": "sk-..." },
 *             "my-provider": { "type": "aliyun", "apikey": "...", "model": "qwen-asr-flash" }
 *           }
 *         }
 *       }
 *     }
 *   }
 * }
 * ```
 */

import axios from "axios";
import type { GatewayRequestHandlerOptions } from "openclaw/plugin-sdk/core";
import { definePluginEntry, type OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";

// Default STT endpoints per provider type.
const DEFAULT_STT_URL_OPENAI = "https://api.openai.com/v1/audio/transcriptions";
const DEFAULT_STT_URL_ALIYUN = "https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions";
// Default model names per provider type.
const DEFAULT_STT_MODEL_OPENAI = "whisper-1";
const DEFAULT_STT_MODEL_ALIYUN = "qwen3-asr-flash";
// Assumed audio MIME when no `data:` prefix is present in the base64 payload.
const DEFAULT_AUDIO_MIME = "audio/webm";

const SUPPORTED_STT_TYPES = ["openai", "aliyun"] as const;
type SttType = (typeof SUPPORTED_STT_TYPES)[number];

type SttChannelConfig = {
  type: SttType;
  apikey: string;
  url: string;
  model: string;
};

/**
 * Validate and extract a string param from the raw gateway params object.
 */
function requireStringParam(
  params: Record<string, unknown>,
  key: string,
): string | { error: string } {
  const value = params[key];
  if (typeof value !== "string" || value.trim() === "") {
    return { error: `${key} is required and must be a non-empty string` };
  }
  return value.trim();
}

function optionalStringParam(params: Record<string, unknown>, key: string): string | undefined {
  const value = params[key];
  return typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;
}

function optionalBooleanParam(params: Record<string, unknown>, key: string): boolean | undefined {
  const value = params[key];
  return typeof value === "boolean" ? value : undefined;
}

/**
 * Resolve a file extension from a MIME type for the multipart upload filename.
 */
function mimeToExt(mime: string): string {
  const map: Record<string, string> = {
    "audio/webm": "webm",
    "audio/ogg": "ogg",
    "audio/mpeg": "mp3",
    "audio/mp4": "mp4",
    "audio/wav": "wav",
    "audio/x-wav": "wav",
    "audio/flac": "flac",
    "audio/aac": "aac",
    "audio/opus": "ogg",
  };
  return map[mime] ?? "audio";
}

/**
 * Call the STT API via axios (OpenAI Whisper-compatible multipart form-data).
 */
async function transcribeAudio(params: {
  b64: string;
  mime: string;
  apikey: string;
  url: string;
  model: string;
}): Promise<string> {
  const ext = mimeToExt(params.mime);
  const filename = `audio.${ext}`;

  const formData = new FormData();
  const blob = new Blob([Buffer.from(params.b64, "base64")], { type: params.mime });
  formData.append("file", blob, filename);
  formData.append("model", params.model);

  const response = await axios.post<{ text?: string }>(params.url, formData, {
    headers: {
      Authorization: `Bearer ${params.apikey}`,
    },
    timeout: 60_000,
  });

  const text = response.data?.text;
  if (!text || typeof text !== "string" || text.trim() === "") {
    throw new Error("STT API returned empty transcript");
  }
  return text.trim();
}

/**
 * Call the Aliyun DashScope ASR API (messages-based JSON format).
 */
async function transcribeAudioAliyun(params: {
  b64: string;
  apikey: string;
  url: string;
  model: string;
}): Promise<string> {
  const body = {
    model: params.model,
    messages: [
      {
        role: "user",
        content: [
          {
            type: "input_audio",
            input_audio: { data: params.b64 },
          },
        ],
      },
    ],
  };

  const debugBody = JSON.parse(JSON.stringify(body));
  debugBody.messages[0].content[0].input_audio.data =
    (params.b64 ?? "").slice(0, 60) + (params.b64.length > 60 ? "..." : "");
  console.log("[stt] aliyun request body:", JSON.stringify(debugBody, null, 2));

  const response = await axios.post<{
    choices?: Array<{ message?: { content?: string } }>;
  }>(params.url, body, {
    headers: {
      Authorization: `Bearer ${params.apikey}`,
      "Content-Type": "application/json",
    },
    timeout: 60_000,
  });

  const text = response.data?.choices?.[0]?.message?.content;
  if (!text || typeof text !== "string" || text.trim() === "") {
    throw new Error("STT API returned empty transcript");
  }
  return text.trim();
}

export default definePluginEntry({
  id: "cloudclaw_stt",
  name: "STT Plugin",
  description: "Transcribes base64 audio and forwards the result to a session via stt.send",
  register(api: OpenClawPluginApi) {
    // Snapshot plugin config at registration time.
    // Shape: { select?: string; configs: Record<configName, SttChannelConfig> }
    const pluginConfig = (api.pluginConfig ?? {}) as Record<string, unknown>;
    const pluginSelect =
      typeof pluginConfig["select"] === "string" ? pluginConfig["select"].trim() : undefined;
    const pluginConfigs = (
      pluginConfig["configs"] != null && typeof pluginConfig["configs"] === "object"
        ? pluginConfig["configs"]
        : {}
    ) as Record<string, unknown>;

    /**
     * Resolve the STT channel config by name.
     * Returns the config or an error message.
     */
    function resolveChannelConfig(configName: string): SttChannelConfig | { error: string } {
      const entry = pluginConfigs[configName];
      if (!entry || typeof entry !== "object") {
        return { error: `No STT config found for configName "${configName}"` };
      }
      const cfg = entry as Record<string, unknown>;
      if (typeof cfg["apikey"] !== "string" || cfg["apikey"].trim() === "") {
        return { error: `STT config "${configName}" is missing a valid apikey` };
      }
      const rawType = typeof cfg["type"] === "string" ? cfg["type"].trim() : "";
      if (!(SUPPORTED_STT_TYPES as readonly string[]).includes(rawType)) {
        return {
          error: `STT config "${configName}" has unsupported type "${rawType}"; supported: ${SUPPORTED_STT_TYPES.join(", ")}`,
        };
      }
      const type = rawType as SttType;
      const defaultUrl = type === "aliyun" ? DEFAULT_STT_URL_ALIYUN : DEFAULT_STT_URL_OPENAI;
      const defaultModel = type === "aliyun" ? DEFAULT_STT_MODEL_ALIYUN : DEFAULT_STT_MODEL_OPENAI;
      return {
        type,
        apikey: cfg["apikey"].trim(),
        url:
          typeof cfg["url"] === "string" && cfg["url"].trim() !== ""
            ? cfg["url"].trim()
            : defaultUrl,
        model:
          typeof cfg["model"] === "string" && cfg["model"].trim() !== ""
            ? cfg["model"].trim()
            : defaultModel,
      };
    }

    /**
     * stt.send
     *
     * Params (mirrors chat.send but substitutes message with base64 audio):
     *   sessionKey        string   (required) – target session key
     *   message           string   (required) – base64-encoded audio, optionally prefixed
     *                                           with `data:<mime>;base64,`
     *   configName        string   (optional) – key in plugins.entries.stt.config.configs;
     *                                           defaults to plugins.entries.stt.config.select
     *   thinking          string   (optional) – thinking level, passed to subagent
     *   deliver           boolean  (optional) – deliver flag, passed to subagent
     *   idempotencyKey    string   (optional) – idempotency key for deduplication
     *   originatingChannel string  (optional) – forwarded to subagent
     *   provider          string   (optional) – model provider override
     *   model             string   (optional) – model override
     */
    api.registerGatewayMethod(
      "stt.send",
      async ({ params, respond }: GatewayRequestHandlerOptions) => {
        // --- param validation ---
        const sessionKeyResult = requireStringParam(params, "sessionKey");
        if (typeof sessionKeyResult !== "string") {
          respond(false, undefined, { code: "invalid_params", message: sessionKeyResult.error });
          return;
        }
        const messageResult = requireStringParam(params, "message");
        if (typeof messageResult !== "string") {
          respond(false, undefined, { code: "invalid_params", message: messageResult.error });
          return;
        }
        const sessionKey = sessionKeyResult;
        const audioBase64 = messageResult;
        const configName = optionalStringParam(params, "configName") ?? pluginSelect;
        if (!configName) {
          respond(false, undefined, {
            code: "invalid_params",
            message: "configName is required when plugins.entries.stt.config.select is not set",
          });
          return;
        }

        // Optional pass-through params (aligning with chat.send surface).
        const deliver = optionalBooleanParam(params, "deliver");
        // idempotencyKey is required by the gateway schema; auto-generate if not provided.
        const idempotencyKey = optionalStringParam(params, "idempotencyKey") ?? crypto.randomUUID();
        const provider = optionalStringParam(params, "provider");
        const model = optionalStringParam(params, "model");

        // --- resolve STT config ---
        const channelConfig = resolveChannelConfig(configName);
        if ("error" in channelConfig) {
          respond(false, undefined, { code: "config_not_found", message: channelConfig.error });
          return;
        }

        // Extract MIME from data URL prefix if present; use raw base64 for the API call.
        const dataUrlMatch = audioBase64.match(/^data:([^;]+);base64,/);
        const audioMime = dataUrlMatch ? dataUrlMatch[1]! : DEFAULT_AUDIO_MIME;
        const audioB64 = dataUrlMatch
          ? audioBase64.slice(audioBase64.indexOf(",") + 1)
          : audioBase64;

        // Validation and config resolution passed — acknowledge the request immediately.
        respond(true, { accepted: true });

        // --- transcribe and dispatch asynchronously; errors go via session, not WebSocket ---
        void (async () => {
          let transcript: string;
          try {
            transcript =
              channelConfig.type === "aliyun"
                ? await transcribeAudioAliyun({
                    b64: audioBase64,
                    apikey: channelConfig.apikey,
                    url: channelConfig.url,
                    model: channelConfig.model,
                  })
                : await transcribeAudio({
                    b64: audioB64,
                    mime: audioMime,
                    apikey: channelConfig.apikey,
                    url: channelConfig.url,
                    model: channelConfig.model,
                  });
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            const responseData =
              err != null &&
              typeof err === "object" &&
              "response" in err &&
              err.response != null &&
              typeof err.response === "object" &&
              "data" in err.response
                ? ` | response: ${JSON.stringify((err.response as { data: unknown }).data)}`
                : "";
            api.logger.error(
              `stt.send: transcription failed [config=${configName}] ${msg}${responseData}`,
            );
            // Forward the error to the session instead of replying on the WebSocket.
            try {
              await api.runtime.subagent.run({
                sessionKey,
                message: `[STT Error] transcription failed: ${msg}${responseData}`,
                idempotencyKey: crypto.randomUUID(),
                ...(deliver !== undefined ? { deliver } : {}),
                ...(provider ? { provider } : {}),
                ...(model ? { model } : {}),
              });
            } catch (dispatchErr) {
              const dispatchMsg =
                dispatchErr instanceof Error ? dispatchErr.message : String(dispatchErr);
              api.logger.error(
                `stt.send: failed to deliver error to session [session=${sessionKey}] ${dispatchMsg}`,
              );
            }
            return;
          }

          api.logger.info(
            `stt.send: transcription complete [config=${configName}, session=${sessionKey}, len=${transcript.length}]`,
          );

          // --- forward transcript to the target session ---
          try {
            await api.runtime.subagent.run({
              sessionKey,
              message: transcript,
              idempotencyKey,
              ...(deliver !== undefined ? { deliver } : {}),
              ...(provider ? { provider } : {}),
              ...(model ? { model } : {}),
            });
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            api.logger.error(`stt.send: subagent run failed [session=${sessionKey}] ${msg}`);
          }
        })();
      },
      { scope: "operator.write" },
    );
  },
});
