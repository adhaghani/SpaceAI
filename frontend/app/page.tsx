"use client"

import Image from "next/image"
import { useEffect, useMemo, useState } from "react"
import {
  AlertTriangle,
  Pause,
  Play,
  Radio,
  Satellite,
  ShieldCheck,
  Timer,
  Zap,
} from "lucide-react"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import { Progress } from "@/components/ui/progress"
import { ScrollArea, ScrollBar } from "@/components/ui/scroll-area"
import { Separator } from "@/components/ui/separator"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"

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
    savings_percent: number
  }
  errors: string[]
}

type RequestLog = {
  id: string
  timestamp: string
  method: "GET" | "POST"
  endpoint: string
  status: number
  ok: boolean
  durationMs: number
  detail?: string
}

type HttpError = Error & {
  status?: number
}

type ControlResponse = {
  ok?: boolean
  detail?: string
  result?: unknown
}

type CumulativeBandwidth = {
  rawImageBytes: number
  vlmPayloadBytes: number
}

type AlertPayload = {
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

const defaultState: ApiState = {
  updated_at: null,
  telemetry: {
    lat: null,
    lon: null,
    alt: null,
    time: null,
  },
  image_available: false,
  image_base64: null,
  image_mime_type: null,
  vlm_result: {
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
  },
  vlm_payload_json: null,
  bandwidth: {
    raw_image_bytes: 0,
    vlm_payload_bytes: 0,
    savings_percent: 0,
  },
  errors: [],
}

export default function Page() {
  const [state, setState] = useState<ApiState>(defaultState)
  const [loading, setLoading] = useState(true)
  const [fetchError, setFetchError] = useState<string | null>(null)
  const [fetchStatus, setFetchStatus] = useState<number | null>(null)
  const [controlBusy, setControlBusy] = useState<"start" | "pause" | null>(null)
  const [requestLogs, setRequestLogs] = useState<RequestLog[]>([])
  const [imageLoadError, setImageLoadError] = useState(false)
  const [cumulativeBandwidth, setCumulativeBandwidth] =
    useState<CumulativeBandwidth>({
      rawImageBytes: 0,
      vlmPayloadBytes: 0,
    })

  const addRequestLog = (log: Omit<RequestLog, "id">) => {
    setRequestLogs((prev) => {
      const next = [{ ...log, id: `${Date.now()}-${Math.random()}` }, ...prev]
      return next.slice(0, 100)
    })
  }

  useEffect(() => {
    let active = true
    let nextPoll: ReturnType<typeof setTimeout> | null = null

    const fetchState = async () => {
      const startedAt = performance.now()
      let status = 0

      try {
        const response = await fetch(`/api/state?ts=${Date.now()}`, {
          cache: "no-store",
        })

        status = response.status

        addRequestLog({
          timestamp: new Date().toISOString(),
          method: "GET",
          endpoint: "/api/state",
          status: response.status,
          ok: response.ok,
          durationMs: Math.round(performance.now() - startedAt),
        })

        if (!response.ok) {
          const body = (await response.json().catch(() => null)) as {
            detail?: string
          } | null
          const error = new Error(
            body?.detail
              ? `State fetch failed (${response.status}): ${body.detail}`
              : `State fetch failed with status ${response.status}`
          ) as HttpError
          error.status = response.status
          throw error
        }

        const json = (await response.json()) as ApiState
        if (!active) {
          return
        }

        setState(json)
        setCumulativeBandwidth((prev) => ({
          rawImageBytes:
            prev.rawImageBytes + Math.max(0, json.bandwidth.raw_image_bytes),
          vlmPayloadBytes:
            prev.vlmPayloadBytes +
            Math.max(0, json.bandwidth.vlm_payload_bytes),
        }))
        setFetchError(null)
        setFetchStatus(null)
      } catch (error) {
        const errorStatus =
          typeof error === "object" && error !== null && "status" in error
            ? Number((error as HttpError).status ?? 0)
            : status

        addRequestLog({
          timestamp: new Date().toISOString(),
          method: "GET",
          endpoint: "/api/state",
          status: errorStatus,
          ok: false,
          durationMs: Math.round(performance.now() - startedAt),
          detail:
            error instanceof Error ? error.message : "Unknown fetch error",
        })

        if (!active) {
          return
        }

        setFetchError(
          error instanceof Error ? error.message : "Unknown fetch error"
        )
        setFetchStatus(errorStatus || null)
      } finally {
        if (active) {
          setLoading(false)
          nextPoll = setTimeout(fetchState, 5000)
        }
      }
    }

    fetchState()

    return () => {
      active = false
      if (nextPoll) {
        clearTimeout(nextPoll)
      }
    }
  }, [])

  const imageUrl = useMemo(() => {
    if (!state.image_available || !state.image_base64) {
      return null
    }
    const mime = state.image_mime_type ?? "image/png"
    return `data:${mime};base64,${state.image_base64}`
  }, [state.image_available, state.image_base64, state.image_mime_type])

  useEffect(() => {
    setImageLoadError(false)
  }, [imageUrl])

  const hasAIResult = Boolean(state.vlm_payload_json)
  const aiPayload: AlertPayload = useMemo(() => {
    if (state.vlm_payload_json) {
      try {
        const parsed = JSON.parse(
          state.vlm_payload_json
        ) as Partial<AlertPayload>
        if (isAlertPayload(parsed)) {
          return parsed as AlertPayload
        }
      } catch {
        // Fall back to normalized state payload if JSON parsing fails.
      }
    }

    return state.vlm_result
  }, [state.vlm_payload_json, state.vlm_result])

  const hasAnyDetection =
    aiPayload.fire_detected ||
    aiPayload.flood_detected ||
    aiPayload.drought_detected ||
    aiPayload.oil_spill_detected ||
    aiPayload.deforestation_detected
  const alertVariant =
    hasAIResult && hasAnyDetection ? "destructive" : "secondary"
  const alertLabel = hasAIResult
    ? hasAnyDetection
      ? "DISASTER SIGNAL DETECTED"
      : "CLEAR"
    : "SIMULATION ONLY"
  const hasObservation = Boolean(imageUrl)
  const hasServerStateError = Boolean(fetchStatus && fetchStatus >= 500)
  const errorLogs = requestLogs.filter((log) => !log.ok)
  const cumulativeSavingsPercent =
    cumulativeBandwidth.rawImageBytes > 0
      ? ((cumulativeBandwidth.rawImageBytes -
          cumulativeBandwidth.vlmPayloadBytes) /
          cumulativeBandwidth.rawImageBytes) *
        100
      : 0

  const controlSimulation = async (command: "start" | "pause") => {
    const startedAt = performance.now()
    let status = 0

    try {
      setControlBusy(command)
      setFetchError(null)
      setFetchStatus(null)

      const response = await fetch(`/api/control`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ command, kwargs: {} }),
      })

      status = response.status
      const body = (await response
        .json()
        .catch(() => null)) as ControlResponse | null

      addRequestLog({
        timestamp: new Date().toISOString(),
        method: "POST",
        endpoint: `/api/control (${command})`,
        status: response.status,
        ok: response.ok && body?.ok !== false,
        durationMs: Math.round(performance.now() - startedAt),
        detail: body?.detail,
      })

      if (!response.ok || body?.ok === false) {
        const error = new Error(
          body?.detail
            ? `Control command failed (${response.status}): ${body.detail}`
            : `Control command failed: ${response.status}`
        ) as HttpError
        error.status = response.status
        throw error
      }
    } catch (error) {
      const errorStatus =
        typeof error === "object" && error !== null && "status" in error
          ? Number((error as HttpError).status ?? 0)
          : status

      addRequestLog({
        timestamp: new Date().toISOString(),
        method: "POST",
        endpoint: `/api/control (${command})`,
        status: errorStatus,
        ok: false,
        durationMs: Math.round(performance.now() - startedAt),
        detail:
          error instanceof Error ? error.message : "Control request failed",
      })

      setFetchError(
        error instanceof Error ? error.message : "Control request failed"
      )
    } finally {
      setControlBusy(null)
    }
  }

  return (
    <main className="relative min-h-svh overflow-hidden bg-background">
      <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_20%_20%,hsl(18_90%_45%/.16),transparent_35%),radial-gradient(circle_at_80%_10%,hsl(170_95%_44%/.12),transparent_35%),radial-gradient(circle_at_50%_80%,hsl(220_80%_55%/.15),transparent_35%)]" />

      <div className="relative mx-auto flex max-w-7xl flex-col gap-4 p-4 md:p-8">
        <Card className="border-border/70 bg-card/90 backdrop-blur-sm">
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-lg">
              <Satellite />
              Orbital Wildfire Command Deck
            </CardTitle>
            <CardDescription>
              Continuous Sentinel-2 SWIR/NIR/Red monitoring with low-bandwidth
              direct SimSat integration.
            </CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-4">
            <div className="flex flex-wrap items-center gap-2">
              <Button
                onClick={() => controlSimulation("start")}
                disabled={controlBusy !== null}
              >
                <Play data-icon="inline-start" />
                Start Simulation
              </Button>
              <Button
                variant="outline"
                onClick={() => controlSimulation("pause")}
                disabled={controlBusy !== null}
              >
                <Pause data-icon="inline-start" />
                Pause Simulation
              </Button>
              <Badge variant="outline" className="gap-1">
                <Radio />
                Polling every 5 seconds
              </Badge>
              <Badge variant={alertVariant}>{alertLabel}</Badge>
            </div>

            {fetchError ? (
              <div className="rounded-lg border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
                {fetchError}
              </div>
            ) : null}

            <div className="text-xs text-muted-foreground">
              Last update: {state.updated_at ?? "waiting for first data frame"}
            </div>
          </CardContent>
        </Card>

        <section className="grid gap-4 lg:grid-cols-12">
          <Card className="border-border/70 bg-card/85 backdrop-blur-sm lg:col-span-4">
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <Timer />
                Telemetry
              </CardTitle>
            </CardHeader>
            <CardContent className="grid grid-cols-1 gap-3 text-sm">
              <TelemetryItem
                label="Latitude"
                value={formatNumber(state.telemetry.lat, 4)}
              />
              <TelemetryItem
                label="Longitude"
                value={formatNumber(state.telemetry.lon, 4)}
              />
              <TelemetryItem
                label="Altitude"
                value={formatAltitude(state.telemetry.alt)}
              />
              <TelemetryItem
                label="Frame Time"
                value={state.telemetry.time ?? "-"}
              />
            </CardContent>
          </Card>

          <Card className="border-border/70 bg-card/85 backdrop-blur-sm lg:col-span-8">
            <CardHeader>
              <CardTitle>Observation Window</CardTitle>
              <CardDescription>
                Live false-color Sentinel-2 frame optimized for
                smoke-penetrating thermal context.
              </CardDescription>
            </CardHeader>
            <CardContent>
              {loading ? (
                <div className="flex h-72 items-center justify-center rounded-xl border border-border/60 bg-muted/35 text-sm text-muted-foreground">
                  Awaiting stream...
                </div>
              ) : hasServerStateError ? (
                <div className="flex h-72 flex-col items-center justify-center gap-2 rounded-xl border border-destructive/40 bg-destructive/10 text-center text-sm text-destructive">
                  <AlertTriangle />
                  State service returned {fetchStatus}. Observation stream is
                  temporarily unavailable.
                </div>
              ) : imageUrl && !imageLoadError ? (
                <div className="relative h-76 w-full overflow-hidden rounded-xl border border-border/70">
                  <Image
                    src={imageUrl}
                    alt="Current Sentinel-2 false color frame"
                    fill
                    unoptimized
                    sizes="(max-width: 1024px) 100vw, 66vw"
                    className="aspect-square object-cover"
                    onError={() => setImageLoadError(true)}
                  />
                </div>
              ) : imageLoadError ? (
                <div className="flex h-72 flex-col items-center justify-center gap-2 rounded-xl border border-destructive/40 bg-destructive/10 text-center text-sm text-destructive">
                  <AlertTriangle />
                  Latest image frame could not be rendered. Waiting for the next
                  valid frame.
                </div>
              ) : (
                <div className="flex h-72 flex-col items-center justify-center gap-2 rounded-xl border border-border/60 bg-muted/35 text-center text-sm text-muted-foreground">
                  <ShieldCheck />
                  Image unavailable in current footprint (likely ocean or no
                  valid window).
                </div>
              )}
            </CardContent>
          </Card>
        </section>

        <section className="grid gap-4 lg:grid-cols-12">
          <Card className="border-border/70 bg-card/85 backdrop-blur-sm lg:col-span-7">
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <AlertTriangle />
                AI Alert Feed
              </CardTitle>
              <CardDescription>
                Strict downlink payload (JSON) generated by the onboard
                vision-language model.
              </CardDescription>
            </CardHeader>
            <CardContent className="flex flex-col gap-3">
              {hasAIResult ? (
                <>
                  <div className="flex items-center gap-2">
                    <Badge variant={alertVariant}>{alertLabel}</Badge>
                    <Badge variant="outline">
                      Severity: {aiPayload.severity}
                    </Badge>
                    <Badge variant="outline">
                      Confidence: {(aiPayload.confidence * 100).toFixed(1)}%
                    </Badge>
                  </div>
                  <Separator />
                  <div className="grid gap-2 rounded-lg border border-border/70 bg-muted/35 p-3 text-sm">
                    <MetricRow
                      label="Fire Detected"
                      value={aiPayload.fire_detected ? "Yes" : "No"}
                    />
                    <MetricRow
                      label="Flood Detected"
                      value={aiPayload.flood_detected ? "Yes" : "No"}
                    />
                    <MetricRow
                      label="Drought Detected"
                      value={aiPayload.drought_detected ? "Yes" : "No"}
                    />
                    <MetricRow
                      label="Oil Spill Detected"
                      value={aiPayload.oil_spill_detected ? "Yes" : "No"}
                    />
                    <MetricRow
                      label="Deforestation Detected"
                      value={aiPayload.deforestation_detected ? "Yes" : "No"}
                    />
                    <MetricRow
                      label="Confidence"
                      value={`${(aiPayload.confidence * 100).toFixed(1)}%`}
                    />
                    <MetricRow
                      label="Flood Confidence"
                      value={`${(aiPayload.disasters.flood.confidence * 100).toFixed(1)}%`}
                    />
                    <MetricRow
                      label="Drought Confidence"
                      value={`${(aiPayload.disasters.drought.confidence * 100).toFixed(1)}%`}
                    />
                    <MetricRow
                      label="Oil Spill Confidence"
                      value={`${(aiPayload.disasters.oil_spill.confidence * 100).toFixed(1)}%`}
                    />
                    <MetricRow
                      label="Deforestation Confidence"
                      value={`${(aiPayload.disasters.deforestation.confidence * 100).toFixed(1)}%`}
                    />
                    <MetricRow
                      label="Latitude"
                      value={aiPayload.lat.toFixed(6)}
                    />
                    <MetricRow
                      label="Longitude"
                      value={aiPayload.lon.toFixed(6)}
                    />
                    <MetricRow label="Severity" value={aiPayload.severity} />
                  </div>
                </>
              ) : (
                <div className="rounded-lg border border-border/60 bg-muted/25 px-3 py-2 text-sm text-muted-foreground">
                  {hasObservation
                    ? "Inference did not return a valid alert for this frame yet."
                    : "No observation image available for this frame. AI alert payload appears when a valid frame is received."}
                </div>
              )}
              {state.errors.length > 0 ? (
                <div className="rounded-lg border border-destructive/40 bg-destructive/10 p-3 text-xs text-destructive">
                  {state.errors.join(" | ")}
                </div>
              ) : null}
            </CardContent>
          </Card>

          <Card className="border-border/70 bg-card/85 backdrop-blur-sm lg:col-span-5">
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <Zap />
                Bandwidth Dashboard
              </CardTitle>
              <CardDescription>
                Compare raw frame bytes with compact event-only AI downlink
                payload.
              </CardDescription>
            </CardHeader>
            <CardContent className="flex flex-col gap-4">
              <MetricRow
                label="Raw Image"
                value={formatBytes(cumulativeBandwidth.rawImageBytes)}
              />
              <MetricRow
                label="VLM Alert Payload"
                value={formatBytes(cumulativeBandwidth.vlmPayloadBytes)}
              />
              <MetricRow
                label="Estimated Savings"
                value={`${cumulativeSavingsPercent.toFixed(2)}%`}
              />
              <Progress value={cumulativeSavingsPercent} className="h-2" />
              <div className="text-xs text-muted-foreground">
                Mission goal: maximize cumulative downlink efficiency while
                preserving actionable disaster alerts.
              </div>
            </CardContent>
          </Card>
        </section>

        <Card className="border-border/70 bg-card/85 backdrop-blur-sm">
          <CardHeader>
            <CardTitle>Request Logs</CardTitle>
            <CardDescription>
              Client-side log of all API calls made from this dashboard session.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <Tabs defaultValue="all">
              <TabsList>
                <TabsTrigger value="all">
                  All ({requestLogs.length})
                </TabsTrigger>
                <TabsTrigger value="errors">
                  Errors ({errorLogs.length})
                </TabsTrigger>
              </TabsList>
              <TabsContent value="all" className="mt-3">
                <LogList
                  logs={requestLogs}
                  emptyText="No requests captured yet."
                />
              </TabsContent>
              <TabsContent value="errors" className="mt-3">
                <LogList logs={errorLogs} emptyText="No failed requests." />
              </TabsContent>
            </Tabs>
          </CardContent>
        </Card>
      </div>
    </main>
  )
}

function LogList({
  logs,
  emptyText,
}: {
  logs: RequestLog[]
  emptyText: string
}) {
  if (logs.length === 0) {
    return (
      <div className="rounded-lg border border-border/60 bg-muted/20 px-3 py-2 text-xs text-muted-foreground">
        {emptyText}
      </div>
    )
  }

  return (
    <div className="max-h-56 overflow-y-auto rounded-lg border border-border/60 bg-muted/20">
      <ScrollArea className="flex h-48 flex-col">
        {logs.map((log) => (
          <div
            key={log.id}
            className="flex flex-wrap items-center gap-2 border-b border-border/50 px-3 py-2 text-xs last:border-b-0"
          >
            <Badge variant={log.ok ? "secondary" : "destructive"}>
              {log.method}
            </Badge>
            <span className="font-mono text-muted-foreground">
              {log.endpoint}
            </span>
            <span className="font-mono">{log.status}</span>
            <span className="font-mono text-muted-foreground">
              {log.durationMs} ms
            </span>
            <span className="font-mono text-muted-foreground">
              {formatTimestamp(log.timestamp)}
            </span>
            {log.detail ? (
              <span className="text-destructive">{log.detail}</span>
            ) : null}
          </div>
        ))}
        <ScrollBar orientation="horizontal" />
      </ScrollArea>
    </div>
  )
}

function TelemetryItem({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border border-border/60 bg-muted/25 p-3">
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className="mt-1 font-mono text-sm">{value}</div>
    </div>
  )
}

function MetricRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between rounded-lg border border-border/60 bg-muted/25 px-3 py-2 text-sm">
      <span className="text-muted-foreground">{label}</span>
      <span className="font-mono">{value}</span>
    </div>
  )
}

function formatNumber(value: number | null, digits: number) {
  if (value === null || Number.isNaN(value)) {
    return "-"
  }
  return value.toFixed(digits)
}

function formatAltitude(value: number | null) {
  if (value === null || Number.isNaN(value)) {
    return "-"
  }
  return `${value.toFixed(2)} km`
}

function formatBytes(bytes: number) {
  if (!bytes || bytes <= 0) {
    return "0 B"
  }

  const units = ["B", "KB", "MB", "GB"]
  let value = bytes
  let index = 0

  while (value >= 1024 && index < units.length - 1) {
    value /= 1024
    index += 1
  }

  return `${value.toFixed(index === 0 ? 0 : 2)} ${units[index]}`
}

function formatTimestamp(value: string) {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) {
    return value
  }
  return date.toLocaleTimeString()
}

function isAlertPayload(
  payload: Partial<AlertPayload>
): payload is AlertPayload {
  return (
    typeof payload.fire_detected === "boolean" &&
    typeof payload.confidence === "number" &&
    typeof payload.lat === "number" &&
    typeof payload.lon === "number" &&
    typeof payload.flood_detected === "boolean" &&
    typeof payload.drought_detected === "boolean" &&
    typeof payload.oil_spill_detected === "boolean" &&
    typeof payload.deforestation_detected === "boolean" &&
    (payload.severity === "low" ||
      payload.severity === "medium" ||
      payload.severity === "high") &&
    !!payload.disasters &&
    typeof payload.disasters.flood?.detected === "boolean" &&
    typeof payload.disasters.flood?.confidence === "number" &&
    typeof payload.disasters.drought?.detected === "boolean" &&
    typeof payload.disasters.drought?.confidence === "number" &&
    typeof payload.disasters.oil_spill?.detected === "boolean" &&
    typeof payload.disasters.oil_spill?.confidence === "number" &&
    typeof payload.disasters.deforestation?.detected === "boolean" &&
    typeof payload.disasters.deforestation?.confidence === "number"
  )
}
