import { NextRequest, NextResponse } from "next/server"

import { runWildfireInference } from "@/lib/wildfire-inference"

type InferBody = {
  image_base64?: string
  image_mime_type?: string | null
  metadata?: {
    lat?: number | null
    lon?: number | null
  }
}

export async function POST(request: NextRequest) {
  let body: InferBody = {}

  try {
    body = (await request.json()) as InferBody
  } catch {
    return NextResponse.json(
      { ok: false, detail: "Invalid JSON body" },
      { status: 400 }
    )
  }

  if (!body.image_base64 || typeof body.image_base64 !== "string") {
    return NextResponse.json(
      { ok: false, detail: "Missing or invalid 'image_base64'" },
      { status: 400 }
    )
  }

  const inference = await runWildfireInference({
    imageBase64: body.image_base64,
    imageMimeType: body.image_mime_type,
    metadata: body.metadata,
  })

  return NextResponse.json(
    {
      ok: true,
      ...inference,
    },
    {
      headers: { "Cache-Control": "no-store" },
    }
  )
}
