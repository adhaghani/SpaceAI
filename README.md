# SpaceAI - Autonomous On-Orbit Forest Fire Detection

End-to-end wildfire intelligence simulation for the AI in Space challenge (Liquid AI + DPhi Space).

SpaceAI now runs in SimSat-direct mode: the Next.js app proxies SimSat APIs and renders mission telemetry and observations without requiring a separate Python backend process.

## What This App Does

SpaceAI runs a continuous orbit-style monitoring loop:

1. Pulls live orbital telemetry from SimSat.
2. Fetches current observation imagery from SimSat (Mapbox or Sentinel provider).
3. Renders observation and state in a live dashboard.
4. Relays simulation control commands (start and pause) to SimSat.
5. Tracks request logs and cumulative payload-size savings metrics in the UI.

When no valid observation image is available for the current footprint (for example ocean coverage), the UI clearly shows that no image is available.

## Primary Use Case

This app is designed for mission prototyping and hackathon workflows where you need to:

- Control and visualize a simulated orbit quickly.
- Access current position and observation imagery from SimSat APIs.
- Build application logic and UI around real simulation outputs.
- Avoid running a separate custom backend service for basic state and control.

## Functional Capabilities

- Real-time telemetry ingestion from SimSat.
- Mapbox and Sentinel image retrieval through SimSat image endpoints.
- Local API proxy routes in Next.js for state and simulation control.
- Live mission dashboard for telemetry, observation image, status badges, request logs, and cumulative bandwidth savings.
- Direct integration with SimSat control API and data API.

## End-to-End Flow

1. SimSat dashboard API receives control commands.
2. SimSat data API provides current position and current image.
3. Next.js API routes aggregate and normalize response payloads.
4. Frontend polls local routes every 5 seconds and renders mission state.

## Project Structure

```text
frontend/
  app/
    api/
      control/
        route.ts
      state/
        route.ts
    layout.tsx
    page.tsx
    globals.css
  components/
    ui/...
  package.json
  postcss.config.mjs
  components.json
  .env.example
README.md
```

## Prerequisites

- SimSat control API running at http://localhost:8000
- SimSat data API running at http://localhost:9005
- Node.js 20+

## 1) Frontend Setup (Next.js + shadcn/ui)

From project root:

```bash
cd frontend
npm install
npm run dev
```

Frontend runs at http://localhost:3000 and polls local API routes every 5 seconds.

## 2) shadcn Initialization Command (Required by Challenge Notes)

If you need to initialize shadcn in a fresh frontend clone:

```bash
cd frontend
npx shadcn-ui@latest init
```

This repository already contains a working shadcn setup and components in `frontend/components/ui`.

## 3) Tailwind Configuration Notes

This frontend uses Tailwind CSS v4 (CSS-first configuration):

- Primary theme tokens are defined in `frontend/app/globals.css`
- PostCSS integration is in `frontend/postcss.config.mjs`
- No `tailwind.config.*` file is required for this setup

## 4) Run Everything Together

Use two terminals:

Terminal A (SimSat):

- Start SimSat services so APIs are available on ports 8000 and 9005

Terminal B (Frontend):

```bash
cd frontend
npm run dev
```

## 5) Demo Workflow

1. Open dashboard at http://localhost:3000
2. Click Start Simulation
3. Watch telemetry and observation frames update
4. Use Start and Pause controls from the command panel
5. Inspect request logs and state panels for live API activity
