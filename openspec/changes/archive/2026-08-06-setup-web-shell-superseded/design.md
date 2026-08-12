## Context

See `proposal.md` for motivation. Project root already has OpenSpec (`openspec/`, `.cursor/`) and docs. No application code yet. Locked stack: browser-only, Vite + React + TypeScript, no backend for POC.

## Goals / Non-Goals

**Goals:**
- Scaffold a maintainable Vite + React + TS app co-located with OpenSpec
- Minimal INFER chrome + main pane placeholder
- Static `dist/` build + short README run/deploy/CSP notes
- Pin deps via lockfile; keep the door open for WASM/Three.js in a later change

**Non-Goals:**
- IFC viewer, extraction, or routing
- Backend, auth, database
- Fancy design system or marketing landing page

## Decisions

### 1. Scaffold at project root (not `apps/web`)
- **Choice:** Single-package Vite app at `C:\Users\Isaac Chia\INFER` alongside `openspec/` and `docs/`
- **Rationale:** Simplest POC layout; one `npm install` / `npm run dev`
- **Alternative:** `apps/web` monorepo — deferred until a second package appears

### 2. Tooling: `npm create vite@latest` with React + TypeScript template
- **Choice:** Official Vite React-TS template, then lightly customize
- **Rationale:** Standard, well-supported, MIT; good WASM/worker story for later That Open work
- **Alternative:** Manual webpack/CRA — rejected (legacy / more config)

### 3. No React Router yet
- **Choice:** Single-page shell without a router
- **Rationale:** MVP is one composition (viewer + panels later); add router only when multi-route UX is needed

### 4. Security baseline in docs (not a full CSP enforcement layer yet)
- **Choice:** Document recommended CSP / no-upload posture in README; keep baseline app free of analytics and outbound model APIs
- **Rationale:** Hard CSP can break Vite HMR and later WASM workers; enforce stricter headers at static host when deploying
- **Alternative:** Strict meta CSP in `index.html` now — deferred to avoid blocking `ifc-viewer` WASM setup

### 5. UI scope for this change
- **Choice:** Simple header with “INFER” + short subtitle; main pane with empty-state copy (“Load an IFC model” comes in `ifc-viewer`)
- **Rationale:** Meets shell requirement without pretending the viewer exists

## Risks / Trade-offs

- **[Risk] Vite scaffold may overwrite or conflict with existing root files** → Scaffold carefully; preserve `openspec/`, `docs/`, `.cursor/`; do not delete constitution files
- **[Risk] Strict CSP too early breaks HMR/WASM** → Document CSP for production host; keep dev flexible
- **[Risk] Plan/agent mode blocks non-markdown writes** → Apply phase must run in agent mode

## Migration Plan

1. Apply tasks to create Vite app and docs
2. Verify `npm run dev` and `npm run build`
3. Later: `ifc-viewer` mounts into the main pane

## Open Questions

None blocking. Package manager: npm (already on PATH with Node).
