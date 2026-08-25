## Why

The `topologic` graph variant is a stub: even with TopologicPy installed, builds fail with “extractor not fully wired.” We need a real on-prem adjacency extract so we can compare TopologicPy healing against IFC boundaries and the deterministic geometry rules — without inventing fake edges.

## What Changes

- Replace the stub in `build_topologic_graph` with a real extractor that uses TopologicPy’s IFC access/adjacency APIs (e.g. `IFC.AccessGraph`) against the stored local IFC
- Map TopologicPy vertices back to `IfcSpace` GlobalIds and emit inferred edges on the existing IFC node id scheme (`space:…`), merged as a superset of the IFC graph
- Prefer portal-mediated links when the library can expose connecting elements (doors/openings); otherwise emit labelled space↔space adjacency
- Keep TopologicPy **optional**: missing package or extract failure → structured error; `ifc` / `geometry` unchanged
- Document install + license note; do **not** pin as a hard default dependency until license review is signed off
- Extend unit tests with mocked adjacency pairs and (when available) a skip-if-missing live smoke against a small fixture IFC
- Update `docs/graph-variants.md` to describe the real topologic path (no longer “install-only”)

## Capabilities

### New Capabilities

- `topologic-adjacency`: On-prem TopologicPy IFC→space adjacency extract, GlobalId mapping, inferred-edge merge into the `topologic` graph variant

### Modified Capabilities

- (none in `openspec/specs/` — graph variants live in the prior change archive; this change adds the missing adjacency capability those APIs already advertise)

## Impact

- Backend: `app/services/graph_topologic.py`, graph build routes, tests, optional dependency docs
- Security: TopologicPy runs locally only; no cloud IFC upload; inferred edges labelled `topologicpy_adjacency`; source IFC never rewritten
- Non-goals: no Autodesk APS; no IFC write-back; no claim TopologicPy is ground truth; do not replace the deterministic `geometry` variant
- Frontend: existing TopologicPy dropdown should start working when the package is installed; no redesign required
