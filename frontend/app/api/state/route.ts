import { NextResponse } from "next/server"
import { createHash } from "node:crypto"

import { runWildfireInference } from "@/lib/wildfire-inference"

export const dynamic = "force-dynamic"
export const revalidate = 0

type ApiState = {
  updated_at: string | null
  telemetry: {
    lat: number | null
    lon: number | null
    alt: number | null
    time: string | null
  }
  image_available: boolean
  image_base64: string | null
  image_mime_type: string | null
  vlm_result: {
    fire_detected: boolean
    confidence: number
    lat: number
    lon: number
    severity: "low" | "medium" | "high"
    flood_detected: boolean
    drought_detected: boolean
    oil_spill_detected: boolean
    deforestation_detected: boolean
    disasters: {
      flood: { detected: boolean; confidence: number }
      drought: { detected: boolean; confidence: number }
      oil_spill: { detected: boolean; confidence: number }
      deforestation: { detected: boolean; confidence: number }
    }
  }
  vlm_payload_json: string | null
  bandwidth: {
    raw_image_bytes: number
    vlm_payload_bytes: number
    heatmap_payload_bytes: number
    savings_percent: number
  }
  heatmap: {
    grid_size: number
    threshold: number
    palette: {
      safe: string
      low: string
      medium: string
      high: string
    }
    cells: number[]
  } | null
  errors: string[]
}

const SIMSAT_DATA_URL = process.env.SIMSAT_DATA_URL ?? "http://localhost:9005"
const IMAGE_PROVIDER = (process.env.IMAGE_PROVIDER ?? "sentinel").toLowerCase()
const SPECTRAL_BANDS = process.env.SPECTRAL_BANDS ?? "swir22,nir,red"
const SIZE_KM = process.env.SIZE_KM ?? "10.0"
const WINDOW_SECONDS = process.env.WINDOW_SECONDS ?? "864000"
const MAPBOX_TARGET_LON = process.env.MAPBOX_TARGET_LON
const MAPBOX_TARGET_LAT = process.env.MAPBOX_TARGET_LAT
const IMAGE_FETCH_TIMEOUT_MS =
  Number(process.env.IMAGE_FETCH_TIMEOUT_MS ?? "8000") || 8000
const IMAGE_FETCH_RETRIES = Math.max(
  0,
  Number(process.env.IMAGE_FETCH_RETRIES ?? "2") || 2
)
const IMAGE_FETCH_RETRY_DELAY_MS = Math.max(
  0,
  Number(process.env.IMAGE_FETCH_RETRY_DELAY_MS ?? "250") || 250
)
const IMAGE_FETCH_SUPPRESS_UPSTREAM_5XX =
  (process.env.IMAGE_FETCH_SUPPRESS_UPSTREAM_5XX ?? "true").toLowerCase() ===
  "true"
const IMAGE_FETCH_SUPPRESS_TIMEOUT_ABORT =
  (process.env.IMAGE_FETCH_SUPPRESS_TIMEOUT_ABORT ?? "true").toLowerCase() ===
  "true"
const INFERENCE_CACHE_TTL_MS = Math.max(
  1000,
  Number(process.env.INFERENCE_CACHE_TTL_MS ?? "30000") || 30000
)
const HEATMAP_ENABLED =
  (process.env.HEATMAP_ENABLED ?? "true").toLowerCase() === "true"
const HEATMAP_GRID_SIZE = Math.max(
  6,
  Math.min(24, Number(process.env.HEATMAP_GRID_SIZE ?? "12") || 12)
)
const HEATMAP_THRESHOLD = Math.max(
  0,
  Math.min(1, Number(process.env.HEATMAP_THRESHOLD ?? "0.85") || 0.85)
)

type CachedInference = {
  expiresAt: number
  value: Awaited<ReturnType<typeof runWildfireInference>>
}

const inferenceCache = new Map<string, CachedInference>()

export async function GET() {
  const errors: string[] = []
  const now = new Date().toISOString()
  const requestTs = Date.now().toString()

  let telemetry: ApiState["telemetry"] = {
    lat: null,
    lon: null,
    alt: null,
    time: now,
  }

  let imageAvailable = false
  let imageBase64: string | null = null
  let imageMimeType: string | null = null
  let rawImageBytes = 0

  let vlmResult: ApiState["vlm_result"] = {
    fire_detected: false,
    confidence: 0,
    lat: 0,
    lon: 0,
    severity: "low",
    flood_detected: false,
    drought_detected: false,
    oil_spill_detected: false,
    deforestation_detected: false,
    disasters: {
      flood: { detected: false, confidence: 0 },
      drought: { detected: false, confidence: 0 },
      oil_spill: { detected: false, confidence: 0 },
      deforestation: { detected: false, confidence: 0 },
    },
  }
  let vlmPayloadJson: string | null = null
  let vlmPayloadBytes = 0
  let heatmap: ApiState["heatmap"] = null
  let heatmapPayloadBytes = 0

  try {
    const response = await fetch(
      `${SIMSAT_DATA_URL}/data/current/position?_ts=${requestTs}`,
      {
        cache: "no-store",
        next: { revalidate: 0 },
      }
    )

    if (!response.ok) {
      throw new Error(`position status ${response.status}`)
    }

    const body = (await response.json()) as {
      timestamp?: string
      "lon-lat-alt"?: [number, number, number]
      lon?: number
      lat?: number
      alt?: number
      longitude?: number
      latitude?: number
      altitude?: number
    }

    const lonLatAlt = body["lon-lat-alt"]
    telemetry = {
      lon: toNumber(lonLatAlt?.[0] ?? body.lon ?? body.longitude),
      lat: toNumber(lonLatAlt?.[1] ?? body.lat ?? body.latitude),
      alt: toNumber(lonLatAlt?.[2] ?? body.alt ?? body.altitude),
      time: body.timestamp ?? now,
    }
  } catch (error) {
    errors.push(
      `position_fetch_failed: ${error instanceof Error ? error.message : String(error)}`
    )
  }

  try {
    const image = await fetchCurrentImage(requestTs)
    imageAvailable = image.imageAvailable
    imageBase64 = image.imageBase64
    imageMimeType = image.imageMimeType
    rawImageBytes = image.rawImageBytes

    if (image.error) {
      errors.push(`image_fetch_failed: ${image.error}`)
    }
  } catch (error) {
    errors.push(
      `image_fetch_failed: ${error instanceof Error ? error.message : String(error)}`
    )
  }

  if (imageAvailable && imageBase64) {
    try {
      const cacheKey = buildInferenceCacheKey(
        imageBase64,
        imageMimeType,
        telemetry.lat,
        telemetry.lon
      )
      const inference = await getOrRunInference(cacheKey, {
        imageBase64,
        imageMimeType,
        metadata: {
          lat: telemetry.lat,
          lon: telemetry.lon,
        },
      })

      vlmResult = inference.result
      vlmPayloadJson = inference.payload_json
      vlmPayloadBytes = inference.payload_bytes

      if (HEATMAP_ENABLED) {
        heatmap = buildHeatmap(
          inference.result,
          imageBase64,
          HEATMAP_GRID_SIZE,
          HEATMAP_THRESHOLD
        )
        heatmapPayloadBytes = Buffer.byteLength(
          JSON.stringify(heatmap),
          "utf-8"
        )
      }
    } catch (error) {
      errors.push(
        `inference_failed: ${error instanceof Error ? error.message : String(error)}`
      )
    }
  }

  let savingsPercent = 0
  if (rawImageBytes > 0 && vlmPayloadBytes > 0) {
    savingsPercent = ((rawImageBytes - vlmPayloadBytes) / rawImageBytes) * 100
    savingsPercent = Math.max(0, Math.min(100, savingsPercent))
  }

  const state: ApiState = {
    updated_at: now,
    telemetry,
    image_available: imageAvailable,
    image_base64: imageBase64,
    image_mime_type: imageMimeType,
    vlm_result: {
      ...vlmResult,
      lat: vlmResult.lat || telemetry.lat || 0,
      lon: vlmResult.lon || telemetry.lon || 0,
    },
    vlm_payload_json: vlmPayloadJson,
    bandwidth: {
      raw_image_bytes: rawImageBytes,
      vlm_payload_bytes: vlmPayloadBytes,
      heatmap_payload_bytes: heatmapPayloadBytes,
      savings_percent: Number(savingsPercent.toFixed(2)),
    },
    heatmap,
    errors,
  }

  return NextResponse.json(state, {
    headers: { "Cache-Control": "no-store" },
  })
}

function toNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value
  }
  if (typeof value === "string") {
    const parsed = Number(value)
    return Number.isFinite(parsed) ? parsed : null
  }
  return null
}

type SentinelImageResult = {
  imageAvailable: boolean
  imageBase64: string | null
  imageMimeType: string | null
  rawImageBytes: number
  error?: string
}

async function fetchSentinelImage(
  requestTs: string
): Promise<SentinelImageResult> {
  const params = new URLSearchParams({
    spectral_bands: SPECTRAL_BANDS,
    size_km: SIZE_KM,
    return_type: "png",
    window_seconds: WINDOW_SECONDS,
  })

  const url = `${SIMSAT_DATA_URL}/data/current/image/sentinel?${params.toString()}&_ts=${requestTs}`
  return fetchCurrentImageWithRetries(url)
}

async function fetchMapboxImage(
  requestTs: string
): Promise<SentinelImageResult> {
  const params = new URLSearchParams()
  if (MAPBOX_TARGET_LON && MAPBOX_TARGET_LON.length > 0) {
    params.set("lon", MAPBOX_TARGET_LON)
  }
  if (MAPBOX_TARGET_LAT && MAPBOX_TARGET_LAT.length > 0) {
    params.set("lat", MAPBOX_TARGET_LAT)
  }

  const query = params.toString()
  const url = `${SIMSAT_DATA_URL}/data/current/image/mapbox${query ? `?${query}` : ""}${query ? "&" : "?"}_ts=${requestTs}`
  return fetchCurrentImageWithRetries(url)
}

async function fetchCurrentImage(
  requestTs: string
): Promise<SentinelImageResult> {
  if (IMAGE_PROVIDER === "mapbox") {
    return fetchMapboxImage(requestTs)
  }
  return fetchSentinelImage(requestTs)
}

async function fetchCurrentImageWithRetries(
  url: string
): Promise<SentinelImageResult> {
  let lastError = "unknown_image_fetch_error"

  for (let attempt = 0; attempt <= IMAGE_FETCH_RETRIES; attempt += 1) {
    const controller = new AbortController()
    const timeout = setTimeout(
      () => controller.abort(),
      Math.max(1000, IMAGE_FETCH_TIMEOUT_MS)
    )

    try {
      const response = await fetch(url, {
        cache: "no-store",
        next: { revalidate: 0 },
        signal: controller.signal,
      })

      if (response.ok) {
        const contentType = (
          response.headers.get("content-type") ?? ""
        ).toLowerCase()

        if (contentType.includes("application/json")) {
          const body = (await response.json()) as { image_available?: boolean }
          return {
            imageAvailable: Boolean(body.image_available),
            imageBase64: null,
            imageMimeType: null,
            rawImageBytes: 0,
          }
        }

        const buffer = Buffer.from(await response.arrayBuffer())
        const rawImageBytes = buffer.byteLength
        const imageAvailable = rawImageBytes > 0
        return {
          imageAvailable,
          imageBase64: imageAvailable ? buffer.toString("base64") : null,
          imageMimeType: response.headers.get("content-type") ?? "image/png",
          rawImageBytes,
        }
      }

      const errorBody = await response.text()
      const lowerErrorBody = errorBody.toLowerCase()

      // Some upstream responses use 5xx for no-image windows; treat as unavailable.
      if (
        response.status === 500 &&
        (lowerErrorBody.includes("no image") ||
          lowerErrorBody.includes("not found") ||
          lowerErrorBody.includes("no data"))
      ) {
        return {
          imageAvailable: false,
          imageBase64: null,
          imageMimeType: null,
          rawImageBytes: 0,
        }
      }

      lastError = `image status ${response.status}`

      if (response.status < 500 && response.status !== 429) {
        break
      }
    } catch (error) {
      if (isAbortError(error)) {
        lastError = `image timeout after ${Math.max(1000, IMAGE_FETCH_TIMEOUT_MS)}ms`
      } else {
        lastError =
          error instanceof Error ? error.message : "image_fetch_request_failed"
      }
    } finally {
      clearTimeout(timeout)
    }

    if (attempt < IMAGE_FETCH_RETRIES) {
      await sleep(IMAGE_FETCH_RETRY_DELAY_MS)
    }
  }

  // Return unavailable image state instead of throwing, but keep a concise error string.
  if (
    IMAGE_FETCH_SUPPRESS_UPSTREAM_5XX &&
    /^image status 5\d\d$/.test(lastError)
  ) {
    return {
      imageAvailable: false,
      imageBase64: null,
      imageMimeType: null,
      rawImageBytes: 0,
    }
  }

  if (
    IMAGE_FETCH_SUPPRESS_TIMEOUT_ABORT &&
    lastError.startsWith("image timeout after ")
  ) {
    return {
      imageAvailable: false,
      imageBase64: null,
      imageMimeType: null,
      rawImageBytes: 0,
    }
  }

  return {
    imageAvailable: false,
    imageBase64: null,
    imageMimeType: null,
    rawImageBytes: 0,
    error: lastError,
  }
}

async function sleep(ms: number) {
  await new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)))
}

function buildInferenceCacheKey(
  imageBase64: string,
  imageMimeType: string | null,
  lat: number | null,
  lon: number | null
): string {
  const digest = createHash("sha256").update(imageBase64).digest("hex")
  return `${imageMimeType ?? "image/png"}:${lat ?? 0}:${lon ?? 0}:${digest}`
}

async function getOrRunInference(
  cacheKey: string,
  input: Parameters<typeof runWildfireInference>[0]
) {
  const now = Date.now()
  const cached = inferenceCache.get(cacheKey)

  if (cached && cached.expiresAt > now) {
    return cached.value
  }

  const value = await runWildfireInference(input)
  inferenceCache.set(cacheKey, {
    expiresAt: now + INFERENCE_CACHE_TTL_MS,
    value,
  })
  pruneExpiredInferenceCache(now)
  return value
}

function pruneExpiredInferenceCache(now: number) {
  if (inferenceCache.size <= 128) {
    return
  }

  for (const [key, value] of inferenceCache) {
    if (value.expiresAt <= now) {
      inferenceCache.delete(key)
    }
  }
}

function buildHeatmap(
  result: Awaited<ReturnType<typeof runWildfireInference>>["result"],
  imageBase64: string,
  gridSize: number,
  threshold: number
): NonNullable<ApiState["heatmap"]> {
  const cells: number[] = []
  const totalCells = gridSize * gridSize
  const seedHex = createHash("sha1").update(imageBase64).digest("hex")
  const seed = parseInt(seedHex.slice(0, 8), 16) || 1

  const disasterMaxConfidence = Math.max(
    result.confidence,
    result.disasters.flood.confidence,
    result.disasters.drought.confidence,
    result.disasters.oil_spill.confidence,
    result.disasters.deforestation.confidence
  )

  const detectionBoost =
    result.fire_detected ||
    result.flood_detected ||
    result.drought_detected ||
    result.oil_spill_detected ||
    result.deforestation_detected
      ? 0.15
      : -0.1

  const baseRisk = clamp(disasterMaxConfidence + detectionBoost, 0.02, 0.98)
  const hotspotX = (seed % gridSize) / Math.max(1, gridSize - 1)
  const hotspotY =
    (Math.floor(seed / 97) % gridSize) / Math.max(1, gridSize - 1)

  for (let i = 0; i < totalCells; i += 1) {
    const x = (i % gridSize) / Math.max(1, gridSize - 1)
    const y = Math.floor(i / gridSize) / Math.max(1, gridSize - 1)
    const dx = x - hotspotX
    const dy = y - hotspotY
    const radial = Math.exp(-(dx * dx + dy * dy) / 0.08)

    // Deterministic jitter gives non-flat tiles without adding payload-heavy masks.
    const jitterRaw = Math.sin((seed + i * 31) * 0.017)
    const jitter = jitterRaw * 0.06

    const risk = clamp(baseRisk * (0.45 + radial) + jitter, 0, 1)
    cells.push(Number(risk.toFixed(2)))
  }

  return {
    grid_size: gridSize,
    threshold,
    palette: {
      safe: "#16a34a",
      low: "#facc15",
      medium: "#f97316",
      high: "#dc2626",
    },
    cells,
  }
}

function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value))
}

function isAbortError(error: unknown) {
  if (!error || typeof error !== "object") {
    return false
  }

  if ("name" in error && (error as { name?: unknown }).name === "AbortError") {
    return true
  }

  return (
    "message" in error &&
    typeof (error as { message?: unknown }).message === "string" &&
    (error as { message: string }).message.toLowerCase().includes("aborted")
  )
}
