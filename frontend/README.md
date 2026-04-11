# Frontend - SpaceAI Dashboard

Next.js App Router dashboard for live SimSat telemetry, observation frames, simulation control, and mission logs.

## Start

```bash
npm install
npm run dev
```

Default URL: `http://localhost:3000`

## Environment

This frontend uses local Next.js route handlers:

- GET /api/state proxies SimSat state and image data.
- POST /api/control relays simulation commands to SimSat dashboard API.

Optional server-side environment overrides:

```env
SIMSAT_CONTROL_URL=http://localhost:8000
SIMSAT_DATA_URL=http://localhost:9005
IMAGE_PROVIDER=mapbox
SPECTRAL_BANDS=swir22,nir,red
SIZE_KM=10.0
WINDOW_SECONDS=864000
MAPBOX_TARGET_LON=
MAPBOX_TARGET_LAT=
IMAGE_FETCH_TIMEOUT_MS=8000
IMAGE_FETCH_RETRIES=2
IMAGE_FETCH_RETRY_DELAY_MS=250
IMAGE_FETCH_SUPPRESS_UPSTREAM_5XX=true
IMAGE_FETCH_SUPPRESS_TIMEOUT_ABORT=true
```

The dashboard polls /api/state every 5 seconds and posts controls to /api/control.

Bandwidth dashboard values are cumulative across the current browser session.

## shadcn

If you need to initialize shadcn in a clean clone:

```bash
npx shadcn-ui@latest init
```

This project already includes pre-generated components under `components/ui`.

## Tailwind

Tailwind v4 CSS-first setup is used in this frontend:

- Global tokens and theming: `app/globals.css`
- PostCSS plugin config: `postcss.config.mjs`
- No `tailwind.config.*` file is required for this setup
