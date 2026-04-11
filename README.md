# SpaceAI - Autonomous On-Orbit Forest Fire Detection

End-to-end wildfire intelligence simulation for the AI in Space challenge (Liquid AI + DPhi Space).

SpaceAI demonstrates how satellites can perform onboard fire analysis and transmit compact alerts instead of streaming full imagery continuously.

## What This App Does

SpaceAI runs a continuous orbit-style monitoring loop:

1. Pulls live orbital telemetry from SimSat (latitude, longitude, altitude, timestamp)
2. Fetches current Sentinel-style false-color observations (SWIR/NIR/Red)
3. Runs image analysis for wildfire indicators using a VLM path (LM Studio LFM-style) with safe fallback behavior
4. Produces strict JSON wildfire events (`fire_detected`, `confidence`, `lat`, `lon`, `severity`)
5. Calculates downlink payload size to compare event-only transmission vs raw image transmission
6. Streams all state to a real-time web dashboard

If no valid observation image is available for the current footprint, the UI explicitly shows a no-observation message rather than presenting fallback AI output as a true observation result.

## Primary Use Case

The app is designed for low-bandwidth emergency monitoring from orbit.

Instead of downlinking every image frame to ground stations, SpaceAI shows a more scalable pattern:

- Analyze imagery onboard
- Transmit only compact, actionable alerts
- Preserve bandwidth for critical events

This is useful for:

- Early wildfire detection over remote regions
- Continuous space-based situational awareness
- Mission concepts where communication windows and throughput are constrained
- Demonstrating edge-AI decision support pipelines in aerospace systems

## Functional Capabilities

- Real-time telemetry ingestion from SimSat
- Observation image ingestion with metadata propagation
- Vision-language inference integration seam in `backend/inference.py`
- LM Studio OpenAI-compatible integration for local LFM-style testing
- Deterministic fallback logic for resilience when model inference is unavailable
- Compact JSON downlink payload generation and byte-size accounting
- Live dashboard for telemetry, observation view, alert feed, and bandwidth savings
- Client-side request logs for operational debugging

## End-to-End Flow

1. SimSat data API provides current position and image observation.
2. Backend (`FastAPI`) processes each cycle in a polling loop.
3. Inference module analyzes image and normalizes structured wildfire output.
4. Backend computes payload vs raw image byte metrics.
5. Frontend (`Next.js`) polls backend state every 2 seconds and renders mission status.

## Project Structure

```text
backend/
  __init__.py
  main.py
  simsat_client.py
  inference.py
  requirements.txt
  .env.example
frontend/
  app/
    layout.tsx
    page.tsx
    globals.css
  components/
    ui/...
  package.json
  postcss.config.mjs
  components.json
  .env.local.example
README.md
```

## Prerequisites

- SimSat control API running at http://localhost:8000
- SimSat data API running at http://localhost:9005
- Python 3.11+
- Node.js 20+

## 1) Backend Setup (FastAPI)

From project root:

```bash
python -m venv .venv
source .venv/bin/activate
pip install -r backend/requirements.txt
cp backend/.env.example backend/.env
uvicorn backend.main:app --reload --port 8001
```

Backend endpoints:

- `GET /api/state` - latest telemetry, image, VLM result, and bandwidth metrics
- `POST /api/control` - relay simulation commands to SimSat control API
- `GET /health` - basic health probe

Example control command:

```bash
curl -X POST http://localhost:8001/api/control \
  -H "Content-Type: application/json" \
  -d '{"command":"start","kwargs":{}}'
```

## 2) Frontend Setup (Next.js + shadcn/ui)

From project root:

```bash
cd frontend
npm install
cp .env.local.example .env.local
npm run dev
```

Frontend runs at http://localhost:3000 and polls backend state every 2 seconds.

## 3) shadcn Initialization Command (Required by Challenge Notes)

If you need to initialize shadcn in a fresh frontend clone:

```bash
cd frontend
npx shadcn-ui@latest init
```

This repository already contains a working shadcn setup and components in `frontend/components/ui`.

## 4) Tailwind Configuration Notes

This frontend uses Tailwind CSS v4 (CSS-first configuration):

- Primary theme tokens are defined in `frontend/app/globals.css`
- PostCSS integration is in `frontend/postcss.config.mjs`
- No `tailwind.config.*` file is required for this setup

## 5) Run Everything Together

Use three terminals:

Terminal A (SimSat):

- Start SimSat services so APIs are available on ports 8000 and 9005

Terminal B (Backend):

```bash
source .venv/bin/activate
uvicorn backend.main:app --reload --port 8001
```

Terminal C (Frontend):

```bash
cd frontend
npm run dev
```

## 6) Liquid AI Model Integration

The integration seam is in `backend/inference.py` inside `analyze_for_fire(...)`.

Current behavior:

- Uses deterministic heuristic placeholder by default
- Supports LM Studio integration for local LFM2-VL-style inference when enabled
- Produces strict JSON output like:

```json
{
  "fire_detected": true,
  "confidence": 0.95,
  "lat": 12.34,
  "lon": 56.78,
  "severity": "high"
}
```

- Computes UTF-8 byte size of this JSON payload to simulate downlink bandwidth usage

### Enable LM Studio (Local) Integration

1. Start LM Studio local server with a vision-language model loaded.
2. Configure backend env (in `backend/.env`):

```env
LM_STUDIO_ENABLED=true
LM_STUDIO_BASE_URL=http://127.0.0.1:1234/v1
LM_STUDIO_MODEL=lfm2-vl
LM_STUDIO_TIMEOUT_SECONDS=40
```

3. Start backend with env file:

```bash
uvicorn backend.main:app --reload --port 8001 --env-file backend/.env
```

If LM Studio is unavailable or returns invalid output, backend automatically falls back to heuristic inference so the stream remains live.

### Notes for direct Liquid SDK integration

- Replace the LM Studio call in `backend/inference.py` with official Liquid API/SDK calls
- Keep `VLM_PROMPT` contract and JSON validation helpers
- Continue returning strict schema and payload byte metrics

## 7) Demo Workflow

1. Open dashboard at http://localhost:3000
2. Click Start Simulation
3. Watch telemetry and observation frames update
4. Inspect AI Alert Feed JSON output
5. Compare raw image bytes vs payload bytes in Bandwidth Dashboard
