type Severity = "low" | "medium" | "high"

type InferenceInput = {
  imageBase64: string
  imageMimeType?: string | null
  metadata?: {
    lat?: number | null
    lon?: number | null
  }
}

type InferenceResult = {
  result: {
    fire_detected: boolean
    confidence: number
    lat: number
    lon: number
    severity: Severity
  }
  payload_json: string
  payload_bytes: number
  prompt_used: string
  model: string
}

const VLM_PROMPT =
  "You are an orbital wildfire analyst operating on constrained satellite bandwidth. " +
  "Inspect this Sentinel-2 false-color composite (SWIR/NIR/Red) and identify likely thermal anomalies, active flame fronts, or high-temperature smoke-obscured hotspots. " +
  "Return STRICT JSON only in this exact schema: " +
  '{"fire_detected": true|false, "confidence": 0.0-1.0, "lat": number, "lon": number, "severity": "low|medium|high"}'

const LM_STUDIO_ENABLED =
  (process.env.LM_STUDIO_ENABLED ?? "true").toLowerCase() === "true"
const LM_STUDIO_BASE_URL = (
  process.env.LM_STUDIO_BASE_URL ?? "http://127.0.0.1:1234/v1"
).replace(/\/$/, "")
const LM_STUDIO_MODEL = process.env.LM_STUDIO_MODEL ?? "lfm2.5-vl-450m"
const LM_STUDIO_TIMEOUT_SECONDS = Number(
  process.env.LM_STUDIO_TIMEOUT_SECONDS ?? "40"
)

export async function runWildfireInference(
  input: InferenceInput
): Promise<InferenceResult> {
  const lat = toNumber(input.metadata?.lat, 0)
  const lon = toNumber(input.metadata?.lon, 0)

  if (!LM_STUDIO_ENABLED) {
    return buildResult(
      {
        fire_detected: false,
        confidence: 0.01,
        lat,
        lon,
        severity: "low",
      },
      "lm-studio-disabled"
    )
  }

  try {
    const dataUrl = buildDataUrl(input.imageBase64, input.imageMimeType)
    const content = await callLmStudio(dataUrl)
    const parsed = extractJsonObject(content)
    const normalized = normalizeResult(parsed, lat, lon)
    return buildResult(normalized, `lm-studio:${LM_STUDIO_MODEL}`)
  } catch {
    return buildResult(
      {
        fire_detected: false,
        confidence: 0.02,
        lat,
        lon,
        severity: "low",
      },
      "lm-studio-fallback"
    )
  }
}

async function callLmStudio(imageDataUrl: string): Promise<string> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  }

  const token = process.env.LM_API_TOKEN ?? process.env.LM_STUDIO_API_KEY
  if (token) {
    headers.Authorization = `Bearer ${token}`
  }

  const controller = new AbortController()
  const timeout = setTimeout(
    () => controller.abort(),
    Math.max(1, LM_STUDIO_TIMEOUT_SECONDS) * 1000
  )

  try {
    const response = await fetch(`${LM_STUDIO_BASE_URL}/chat/completions`, {
      method: "POST",
      headers,
      signal: controller.signal,
      body: JSON.stringify({
        model: LM_STUDIO_MODEL,
        temperature: 0,
        messages: [
          {
            role: "system",
            content: "You are a strict JSON-only orbital wildfire detector.",
          },
          {
            role: "user",
            content: [
              { type: "text", text: VLM_PROMPT },
              { type: "image_url", image_url: { url: imageDataUrl } },
            ],
          },
        ],
      }),
      cache: "no-store",
    })

    if (!response.ok) {
      throw new Error(`lm_studio_status_${response.status}`)
    }

    const body = (await response.json()) as {
      choices?: Array<{
        message?: {
          content?: unknown
        }
      }>
    }

    const raw = body.choices?.[0]?.message?.content
    if (typeof raw === "string") {
      return raw
    }

    if (Array.isArray(raw)) {
      return raw
        .map((part) => {
          if (typeof part === "string") {
            return part
          }
          if (
            part &&
            typeof part === "object" &&
            "text" in part &&
            typeof (part as { text?: unknown }).text === "string"
          ) {
            return (part as { text: string }).text
          }
          return ""
        })
        .join("\n")
    }

    throw new Error("lm_studio_invalid_content")
  } finally {
    clearTimeout(timeout)
  }
}

function extractJsonObject(text: string): Record<string, unknown> {
  const direct = tryParseJson(text)
  if (direct && typeof direct === "object" && !Array.isArray(direct)) {
    return direct as Record<string, unknown>
  }

  const match = text.match(/\{[\s\S]*\}/)
  if (!match) {
    throw new Error("lm_studio_no_json")
  }

  const parsed = tryParseJson(match[0])
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("lm_studio_json_parse_failed")
  }

  return parsed as Record<string, unknown>
}

function tryParseJson(value: string): unknown {
  try {
    return JSON.parse(value)
  } catch {
    return null
  }
}

function normalizeResult(
  raw: Record<string, unknown>,
  fallbackLat: number,
  fallbackLon: number
) {
  const fireRaw = raw.fire_detected
  const fire_detected =
    typeof fireRaw === "boolean"
      ? fireRaw
      : typeof fireRaw === "number"
        ? fireRaw !== 0
        : typeof fireRaw === "string"
          ? ["true", "1", "yes"].includes(fireRaw.toLowerCase())
          : false

  const confidence = clamp(toNumber(raw.confidence, 0.01), 0, 1)
  const severityRaw = String(raw.severity ?? "low").toLowerCase()
  const severity: Severity =
    severityRaw === "high" || severityRaw === "medium" ? severityRaw : "low"

  const lat = toNumber(raw.lat, fallbackLat)
  const lon = toNumber(raw.lon, fallbackLon)

  return {
    fire_detected,
    confidence: Number(confidence.toFixed(3)),
    lat,
    lon,
    severity,
  }
}

function buildResult(
  result: InferenceResult["result"],
  model: string
): InferenceResult {
  const payload_json = JSON.stringify(result)
  return {
    result,
    payload_json,
    payload_bytes: Buffer.byteLength(payload_json, "utf-8"),
    prompt_used: VLM_PROMPT,
    model,
  }
}

function buildDataUrl(base64: string, mime?: string | null): string {
  const contentType = mime && mime.length > 0 ? mime : "image/png"
  return `data:${contentType};base64,${base64}`
}

function toNumber(value: unknown, fallback: number): number {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value
  }
  if (typeof value === "string") {
    const parsed = Number(value)
    if (Number.isFinite(parsed)) {
      return parsed
    }
  }
  return fallback
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value))
}
