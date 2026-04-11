# Frontend - SpaceAI Dashboard

Next.js App Router dashboard for live SimSat telemetry, false-color observation frames, onboard AI alerts, and bandwidth metrics.

## Start

```bash
npm install
cp .env.local.example .env.local
npm run dev
```

Default URL: `http://localhost:3000`

## Environment

Set backend endpoint in `.env.local`:

```env
NEXT_PUBLIC_BACKEND_URL=http://localhost:8001
```

The dashboard polls `${NEXT_PUBLIC_BACKEND_URL}/api/state` every 2 seconds and sends simulation controls to `${NEXT_PUBLIC_BACKEND_URL}/api/control`.

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
