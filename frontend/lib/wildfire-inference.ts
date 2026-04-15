type Severity = "low" | "medium" | "high"

type DisasterType = "flood" | "drought" | "oil_spill" | "deforestation"

type DisasterAssessment = {
  detected: boolean
  confidence: number
}

type DisasterAssessments = Record<DisasterType, DisasterAssessment>

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
    flood_detected: boolean
    drought_detected: boolean
    oil_spill_detected: boolean
    deforestation_detected: boolean
    disasters: DisasterAssessments
  }
  payload_json: string
  payload_bytes: number
  prompt_used: string
  model: string
}

const IMAGE_PROVIDER = (process.env.IMAGE_PROVIDER ?? "sentinel").toLowerCase()

const LM_STUDIO_ENABLED =
  (process.env.LM_STUDIO_ENABLED ?? "true").toLowerCase() === "true"
const LM_STUDIO_BASE_URL = (
  process.env.LM_STUDIO_BASE_URL ?? "http://127.0.0.1:1234/v1"
).replace(/\/$/, "")
const LM_STUDIO_MODEL = process.env.LM_STUDIO_MODEL ?? "lfm2.5-vl-450m"
const LM_STUDIO_TIMEOUT_SECONDS = Number(
  process.env.LM_STUDIO_TIMEOUT_SECONDS ?? "40"
)
const FIRE_MIN_CONFIDENCE = clamp(
  Number(process.env.FIRE_MIN_CONFIDENCE ?? "0.7"),
  0,
  1
)
const FIRE_MAPBOX_MIN_CONFIDENCE = clamp(
  Number(process.env.FIRE_MAPBOX_MIN_CONFIDENCE ?? "0.88"),
  0,
  1
)
const FIRE_ALLOW_LOW_SEVERITY =
  (process.env.FIRE_ALLOW_LOW_SEVERITY ?? "false").toLowerCase() === "true"
const FIRE_LOW_SEVERITY_OVERRIDE_CONFIDENCE = clamp(
  Number(process.env.FIRE_LOW_SEVERITY_OVERRIDE_CONFIDENCE ?? "0.95"),
  0,
  1
)
const DISASTER_MIN_CONFIDENCE = clamp(
  Number(process.env.DISASTER_MIN_CONFIDENCE ?? "0.82"),
  0,
  1
)
const DISASTER_STRICT_MIN_CONFIDENCE = clamp(
  Number(process.env.DISASTER_STRICT_MIN_CONFIDENCE ?? "0.9"),
  0,
  1
)
const POLAR_FIRE_GUARD_ENABLED =
  (process.env.POLAR_FIRE_GUARD_ENABLED ?? "true").toLowerCase() === "true"
const POLAR_LATITUDE_THRESHOLD = clamp(
  Number(process.env.POLAR_LATITUDE_THRESHOLD ?? "60"),
  0,
  90
)
const POLAR_FIRE_MIN_CONFIDENCE = clamp(
  Number(process.env.POLAR_FIRE_MIN_CONFIDENCE ?? "0.985"),
  0,
  1
)
const POLAR_FIRE_REQUIRE_HIGH_SEVERITY =
  (process.env.POLAR_FIRE_REQUIRE_HIGH_SEVERITY ?? "true").toLowerCase() ===
  "true"

const VLM_PROMPT_SENTINEL =
  "Satellite disaster triage (precision-first). Analyze Sentinel-2 false-color image for wildfire, flood, drought, oil spill, and deforestation evidence. " +
  "If the scene is mostly snow, ice, or cloud with no clear smoke source/flame front, wildfire must be false. " +
  "For polar regions (e.g., Antarctica/Greenland), default wildfire=false unless explicit active burn plume is visible. " +
  "Avoid weak/ambiguous cues. If unsure, mark false with low confidence. Return STRICT JSON only: " +
  '{"fire_detected":bool,"flood_detected":bool,"drought_detected":bool,"oil_spill_detected":bool,"deforestation_detected":bool,"confidence":0-1,"flood_confidence":0-1,"drought_confidence":0-1,"oil_spill_confidence":0-1,"deforestation_confidence":0-1,"lat":number,"lon":number,"severity":"low|medium|high"}'

const VLM_PROMPT_MAPBOX =
  "Satellite disaster triage on RGB imagery (precision-first). Detect only strong visual evidence for wildfire, flood, drought, oil spill, and deforestation. " +
  "If imagery is dominated by snow/ice/cloud and lacks a clear smoke plume source, wildfire must be false. " +
  "For polar regions, default wildfire=false unless explicit active fire signatures are visible. " +
  "Do not infer thermal cues from color alone. If uncertain, return false with low confidence. Return STRICT JSON only: " +
  '{"fire_detected":bool,"flood_detected":bool,"drought_detected":bool,"oil_spill_detected":bool,"deforestation_detected":bool,"confidence":0-1,"flood_confidence":0-1,"drought_confidence":0-1,"oil_spill_confidence":0-1,"deforestation_confidence":0-1,"lat":number,"lon":number,"severity":"low|medium|high"}'

export async function runWildfireInference(
  input: InferenceInput
): Promise<InferenceResult> {
  const lat = toNumber(input.metadata?.lat, 0)
  const lon = toNumber(input.metadata?.lon, 0)
  const promptUsed =
    IMAGE_PROVIDER === "mapbox" ? VLM_PROMPT_MAPBOX : VLM_PROMPT_SENTINEL

  if (!LM_STUDIO_ENABLED) {
    return buildResult(
      {
        fire_detected: false,
        confidence: 0.01,
        lat,
        lon,
        severity: "low",
        flood_detected: false,
        drought_detected: false,
        oil_spill_detected: false,
        deforestation_detected: false,
        disasters: defaultDisasterAssessments(),
      },
      "lm-studio-disabled",
      promptUsed
    )
  }

  try {
    const dataUrl = buildDataUrl(input.imageBase64, input.imageMimeType)
    const content = await callLmStudio(dataUrl, promptUsed)
    const parsed = extractJsonObject(content)
    const normalized = normalizeResult(parsed, lat, lon)
    const policyAdjusted = applyDecisionPolicy(normalized)
    const polarAdjusted = applyPolarFireGuard(policyAdjusted)
    return buildResult(
      polarAdjusted,
      `lm-studio:${LM_STUDIO_MODEL}`,
      promptUsed
    )
  } catch {
    return buildResult(
      {
        fire_detected: false,
        confidence: 0.02,
        lat,
        lon,
        severity: "low",
        flood_detected: false,
        drought_detected: false,
        oil_spill_detected: false,
        deforestation_detected: false,
        disasters: defaultDisasterAssessments(),
      },
      "lm-studio-fallback",
      promptUsed
    )
  }
}

async function callLmStudio(
  imageDataUrl: string,
  promptUsed: string
): Promise<string> {
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
        max_tokens: 180,
        messages: [
          {
            role: "system",
            content: "Return compact strict JSON only.",
          },
          {
            role: "user",
            content: [
              { type: "text", text: promptUsed },
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

  const disasters: DisasterAssessments = {
    flood: {
      detected: toBoolean(raw.flood_detected),
      confidence: clamp(toNumber(raw.flood_confidence, 0.01), 0, 1),
    },
    drought: {
      detected: toBoolean(raw.drought_detected),
      confidence: clamp(toNumber(raw.drought_confidence, 0.01), 0, 1),
    },
    oil_spill: {
      detected: toBoolean(raw.oil_spill_detected),
      confidence: clamp(toNumber(raw.oil_spill_confidence, 0.01), 0, 1),
    },
    deforestation: {
      detected: toBoolean(raw.deforestation_detected),
      confidence: clamp(toNumber(raw.deforestation_confidence, 0.01), 0, 1),
    },
  }

  return {
    fire_detected,
    confidence: Number(confidence.toFixed(3)),
    lat,
    lon,
    severity,
    flood_detected: disasters.flood.detected,
    drought_detected: disasters.drought.detected,
    oil_spill_detected: disasters.oil_spill.detected,
    deforestation_detected: disasters.deforestation.detected,
    disasters,
  }
}

function buildResult(
  result: InferenceResult["result"],
  model: string,
  promptUsed: string
): InferenceResult {
  const payload_json = JSON.stringify(result)
  return {
    result,
    payload_json,
    payload_bytes: Buffer.byteLength(payload_json, "utf-8"),
    prompt_used: promptUsed,
    model,
  }
}

function applyDecisionPolicy(
  result: InferenceResult["result"]
): InferenceResult["result"] {
  const minConfidence =
    IMAGE_PROVIDER === "mapbox"
      ? Math.max(FIRE_MIN_CONFIDENCE, FIRE_MAPBOX_MIN_CONFIDENCE)
      : FIRE_MIN_CONFIDENCE
  const strictDisasterMin =
    IMAGE_PROVIDER === "mapbox"
      ? Math.max(DISASTER_MIN_CONFIDENCE, DISASTER_STRICT_MIN_CONFIDENCE)
      : DISASTER_MIN_CONFIDENCE

  const adjusted: InferenceResult["result"] = {
    ...result,
    disasters: {
      flood: {
        ...result.disasters.flood,
        detected:
          result.disasters.flood.detected &&
          result.disasters.flood.confidence >= strictDisasterMin,
      },
      drought: {
        ...result.disasters.drought,
        detected:
          result.disasters.drought.detected &&
          result.disasters.drought.confidence >= strictDisasterMin,
      },
      oil_spill: {
        ...result.disasters.oil_spill,
        detected:
          result.disasters.oil_spill.detected &&
          result.disasters.oil_spill.confidence >= strictDisasterMin,
      },
      deforestation: {
        ...result.disasters.deforestation,
        detected:
          result.disasters.deforestation.detected &&
          result.disasters.deforestation.confidence >= strictDisasterMin,
      },
    },
  }

  adjusted.flood_detected = adjusted.disasters.flood.detected
  adjusted.drought_detected = adjusted.disasters.drought.detected
  adjusted.oil_spill_detected = adjusted.disasters.oil_spill.detected
  adjusted.deforestation_detected = adjusted.disasters.deforestation.detected

  const firePassedThreshold =
    adjusted.fire_detected && adjusted.confidence >= minConfidence
  const allowLowSeverityFire =
    FIRE_ALLOW_LOW_SEVERITY ||
    adjusted.severity !== "low" ||
    adjusted.confidence >= FIRE_LOW_SEVERITY_OVERRIDE_CONFIDENCE

  adjusted.fire_detected = firePassedThreshold && allowLowSeverityFire

  if (!hasAnyDetection(adjusted)) {
    adjusted.severity = "low"
  } else if (adjusted.confidence >= 0.9) {
    adjusted.severity = "high"
  } else if (adjusted.confidence >= 0.8) {
    adjusted.severity = "medium"
  }

  return adjusted
}

function applyPolarFireGuard(
  result: InferenceResult["result"]
): InferenceResult["result"] {
  if (!POLAR_FIRE_GUARD_ENABLED || !result.fire_detected) {
    return result
  }

  if (Math.abs(result.lat) < POLAR_LATITUDE_THRESHOLD) {
    return result
  }

  const severityGatePassed =
    !POLAR_FIRE_REQUIRE_HIGH_SEVERITY || result.severity === "high"
  const confidenceGatePassed = result.confidence >= POLAR_FIRE_MIN_CONFIDENCE

  if (severityGatePassed && confidenceGatePassed) {
    return result
  }

  const suppressed: InferenceResult["result"] = {
    ...result,
    fire_detected: false,
  }

  if (!hasAnyDetection(suppressed)) {
    suppressed.severity = "low"
  }

  return suppressed
}

function defaultDisasterAssessments(): DisasterAssessments {
  return {
    flood: { detected: false, confidence: 0.01 },
    drought: { detected: false, confidence: 0.01 },
    oil_spill: { detected: false, confidence: 0.01 },
    deforestation: { detected: false, confidence: 0.01 },
  }
}

function toBoolean(value: unknown): boolean {
  if (typeof value === "boolean") {
    return value
  }
  if (typeof value === "number") {
    return value !== 0
  }
  if (typeof value === "string") {
    return ["true", "1", "yes"].includes(value.toLowerCase())
  }
  return false
}

function hasAnyDetection(result: InferenceResult["result"]): boolean {
  return (
    result.fire_detected ||
    result.flood_detected ||
    result.drought_detected ||
    result.oil_spill_detected ||
    result.deforestation_detected
  )
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
