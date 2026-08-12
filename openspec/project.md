# INFER — Project Constitution

**Intelligent Navigation and Facility Environment Reasoning**

Internship POC (Aug–Dec 2026). Transforms IFC building models into an executable indoor spatial model for route planning and emergency scenario analysis.

## Architecture (updated 2026-08-06)

| Layer | Choice |
| --- | --- |
| This repository | **Backend only** |
| Frontend | Developed **elsewhere**; wire to this API later |
| API | **Python FastAPI** |
| IFC processing | **ifcopenshell** (server-side) |
| Storage (POC) | Local filesystem under a controlled data directory |
| Deploy | On-prem / localhost for POC |

The earlier Vite frontend scaffold in this repo was **discarded**. Do not reintroduce a full SPA here unless requested.

## Non-negotiables (government / security)

1. Treat IFC/BIM as sensitive. No third-party cloud upload of models.
2. No proprietary BIM SaaS for the core path (e.g. Autodesk APS / Forge).
3. Prefer MIT/MPL/LGPL with legal review; flag AGPL and proprietary SaaS.
4. No sending building models or their contents to public LLM APIs.
5. AI product inferences MUST be labelled as inferred and validated deterministically. Never silently modify the source IFC.
6. Preserve traceability: navigation entities ↔ IFC GUIDs.
7. Modular routing: swap engines behind an interface.
8. Default API bind to localhost; document CORS allowlist for the external frontend.
9. Pin dependencies (lockfiles / pinned requirements).

## MVP backend capabilities (eventual)

1. Accept / store IFC (local)
2. Extract storeys, spaces, doors, stairs, lifts, exit candidates
3. Build connectivity graph
4. Multi-storey route calculation
5. Dynamic blockages → reroute
6. Navigation-readiness report
7. Explainable route traces (JSON)

## OpenSpec workflow

- `/opsx-explore` — think through an idea
- `/opsx-propose <change>` — draft proposal, specs, design, tasks
- `/opsx-apply` — implement tasks
- `/opsx-archive` — merge specs and archive the change

## Telemetry

```powershell
openspec config set telemetry.enabled false
```
