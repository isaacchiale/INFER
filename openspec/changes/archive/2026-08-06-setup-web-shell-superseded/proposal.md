## Why

INFER needs a reproducible browser-only web app shell before IFC viewing or navigation work can start. Scaffolding Vite + React + TypeScript now establishes the locked POC stack, static deploy path, and security baseline (no backend, no model upload).

## What Changes

- Create a Vite + React + TypeScript application at the INFER project root (or `app/` if root must stay docs-only — prefer root for a single-package POC)
- Add a minimal UI shell (app chrome + placeholder main pane) ready for the later IFC viewer
- Configure TypeScript strictness, ESLint baseline, and a production `build` that emits static `dist/`
- Document local run / static hosting and CSP-oriented notes for browser-only posture
- Pin npm dependencies via lockfile; no backend, no cloud services

## Non-goals

- No IFC loading, Three.js, or That Open integration yet (next change: `ifc-viewer`)
- No backend / API / file upload to a server
- No Autodesk APS, Speckle Cloud, or other BIM SaaS
- No analytics or telemetry that could transmit model data
- No git init unless requested separately

## Capabilities

### New Capabilities

- `web-shell`: Browser-hosted SPA shell — local dev server, static production build, basic app layout, and security-minded hosting constraints for the INFER POC

### Modified Capabilities

- (none — greenfield)

## Impact

- New npm project files (`package.json`, Vite/React/TS config, `src/`, `index.html`, lockfile)
- Developers run `npm install` + `npm run dev` locally; deploy via static `dist/`
- Later changes mount the IFC viewer into the shell’s main pane
- Dependencies are limited to Vite, React, TypeScript, and standard lint tooling (MIT-friendly)
