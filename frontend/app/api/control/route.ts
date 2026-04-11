import { NextRequest, NextResponse } from "next/server"

const SIMSAT_CONTROL_URL =
  process.env.SIMSAT_CONTROL_URL ?? "http://localhost:8000"
const CONTROL_TIMEOUT_MS = Number(
  process.env.SIMSAT_CONTROL_TIMEOUT_MS ?? "8000"
)

type ControlBody = {
  command?: string
  kwargs?: Record<string, unknown>
  [key: string]: unknown
}

export async function POST(request: NextRequest) {
  let body: ControlBody = {}

  try {
    body = (await request.json()) as ControlBody
  } catch {
    return NextResponse.json(
      { ok: false, detail: "Invalid JSON body" },
      { status: 400 }
    )
  }

  const command = body.command
  if (!command || typeof command !== "string") {
    return NextResponse.json(
      { ok: false, detail: "Missing or invalid 'command'" },
      { status: 400 }
    )
  }

  const kwargs =
    body.kwargs &&
    typeof body.kwargs === "object" &&
    !Array.isArray(body.kwargs)
      ? body.kwargs
      : {}

  const passthrough = Object.fromEntries(
    Object.entries(body).filter(
      ([key]) => key !== "command" && key !== "kwargs"
    )
  )

  const payload = {
    command,
    ...kwargs,
    ...passthrough,
  }

  const baseUrl = SIMSAT_CONTROL_URL.replace(/\/$/, "")
  const endpoints = ["/api/commands/", "/api/commands"]

  try {
    let lastStatus = 502
    let lastDetail = "Unknown control relay failure"

    for (const endpoint of endpoints) {
      const controller = new AbortController()
      const timeout = setTimeout(
        () => controller.abort(),
        Math.max(1000, CONTROL_TIMEOUT_MS)
      )

      try {
        const response = await fetch(`${baseUrl}${endpoint}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
          cache: "no-store",
          signal: controller.signal,
        })

        const text = await response.text()
        let result: unknown = text
        try {
          result = JSON.parse(text)
        } catch {
          // Keep raw text when response is not valid JSON.
        }

        if (response.ok) {
          return NextResponse.json(
            {
              ok: true,
              command,
              result,
            },
            { status: response.status }
          )
        }

        lastStatus = response.status
        lastDetail =
          typeof result === "object" &&
          result !== null &&
          "detail" in result &&
          typeof (result as { detail?: unknown }).detail === "string"
            ? String((result as { detail: string }).detail)
            : `SimSat control endpoint returned status ${response.status}`
      } catch (error) {
        lastStatus = 502
        lastDetail =
          error instanceof Error
            ? error.message
            : "Control relay request failed"
      } finally {
        clearTimeout(timeout)
      }
    }

    return NextResponse.json(
      {
        ok: false,
        command,
        detail: lastDetail,
      },
      { status: lastStatus }
    )
  } catch (error) {
    return NextResponse.json(
      {
        ok: false,
        detail: `SimSat control relay failed: ${error instanceof Error ? error.message : String(error)}`,
      },
      { status: 502 }
    )
  }
}
