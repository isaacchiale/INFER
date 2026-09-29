# INFER user guide

**Slides:** [INFER-user-guide.pptx](INFER-user-guide.pptx) (figures under [slides/assets](slides/assets)).

**Intelligent Navigation and Facility Environment Reasoning**

This guide is for people using the INFER workspace: opening a building, reading the 3D / plan / graph, asking for a walkable route, running a what-if, and sharing that route. It describes the **current internship proof-of-concept**, not a finished product.

INFER turns a static building file (IFC or IndoorGML) into something you can **route through**: rooms, doors, stairs, lifts, furniture obstacles, and exits. It does **not** change the original BIM file. Anything the software *guesses* (for example an extra door–room link) stays labelled as inferred.

Everyday routing runs on a **per-storey walkability grid** (navmesh), not by clicking nodes on the Graph Viewer. The graph is for understanding connectivity and for **removing** entities from the live model.

---

## 1. What you need

- A PC with **Python 3.11+** and **Node 20+**.
- The backend on `http://127.0.0.1:8000`.
- The frontend in a browser (`npm run dev` — typically `http://localhost:5173` or another Vite port).
- An **`.ifc`**, **`.ifczip`**, **`.gml`**, or **`.indoorgml`** file.

Models stay **on this machine** under `data/`. Do not upload facility IFCs to public cloud BIM tools or public AI services.

### Start the two processes

**Backend** (PowerShell):

```powershell
cd backend
.\.venv\Scripts\Activate.ps1
uvicorn app.main:app --host 127.0.0.1 --port 8000 --reload
```

**Frontend:**

```powershell
cd frontend
npm run dev
```

If the page loads but ingest fails, the API is usually not running. Check `http://127.0.0.1:8000/health`.

---

## 2. The workspace

Three panes sit side by side. Open or close them from the pane bar; drag the splits to resize.

| Pane | What it is for |
| --- | --- |
| **3D Viewer** | Orbit or fly the BIM. Optional navmesh overlay. Storey clip is independent of the 2D level. |
| **2D Viewer** | One storey at a time: architectural plan (**IFC** tab) or walkable regions (**Navmesh** tab). |
| **Graph Viewer** | Rooms (and stairs/lifts) as a network. Most door nodes are hidden so the picture is readable. |

**Reload the page** resets pane sizes to equal thirds and **clears the loaded model from memory**. Derived files remain on disk; you still ingest (or re-select) to populate the UI.

Light / dark theme is the sun/moon control on the top bar.

**Control** is the collapsible tray on the right: search rooms, doors, heals, exits, and stairs by level and name; remove or restore without deleting the file.

---

## 3. Open a model

1. Top bar → model name (says **No model loaded** until you have one) → **Open model…**. Empty panes also have an **Open model** button.
2. Drop a file or browse. Supported: `.ifc`, `.ifczip`, `.gml`, `.indoorgml`.

INFER then, in order:

1. Loads IFC for 3D (IndoorGML has no BIM mesh — 3D falls back to extruded footprints).
2. Uploads the file to the backend.
3. Extracts spaces, doors, stairs, lifts, exit candidates.
4. Builds **2D footprints** (room outlines, walls, doors, furniture occupancy).
5. Builds a **connectivity graph**. After ingest the live graph is **Geometry rules** (IFC relations plus healing so sparse exports still connect).

A large building can take **one to several minutes**, especially footprints (furniture meshes). Watch the dialog and the top-bar status line.

When it finishes you should see spaces on the floorplan and a toast with space / link counts.

---

## 4. Floorplan — IFC tab (the drawing)

Pick the **storey** from the dropdown. The 2D plan is **one floor at a time**.

**IFC** is the architectural view: rooms, walls, door glyphs (swing/slide when the file provides it), stairs, cream furniture, and a route overlay if you already have a navmesh path.

### Camera

- **Left-drag** — pan.
- **Scroll** — zoom.
- **Shift + scroll** — rotate the plan.
- **Fit** — frame the current storey.

A **camera disc** on the plan tracks the 3D viewpoint when the 3D pane is open (heading cone while you fly).

### Legend

Toggle layers: spaces, walls, doors, stairs, furniture, route. Turn furniture off if the plan is busy; **routing still treats those shapes as obstacles** when they are in the footprints.

**Left-click** a room on the IFC tab to select it (same idea as Graph / Control).

---

## 5. How to read the drawings

| You see | Meaning |
| --- | --- |
| Grey room fill | Walkable space from the IFC space (or heal). Holes are voids (atria). |
| Thick wall poché | Wall footprint. Doorways are punched visually. |
| Cream furniture | True occupancy of desks, screens, chairs — **not** a rubber-band box around the cubicle. Chair wells stay empty and walkable. |
| Amber door glyph | IFC door. |
| Dashed stair | Stair overlay (plan hull). |
| Coloured route | Walkable path after smoothing (not the raw grid staircase). |
| Blue camera disc | Where the 3D camera is looking on this storey. |

Tiny fixtures (clocks, frames) are dropped so they do not clutter routing.

---

## 6. 3D Viewer

- **Orbit** — drag to rotate around the building.
- **Fly** — WASD to move, Space up, Shift down, hold **Ctrl** to go faster.
- **IFC / Navmesh** — real BIM mesh, or a simplified portal/navmesh view of the walkable model.
- **Storey filter** — clip which floors you see in 3D. Independent of the 2D storey dropdown.

Clicking a **Worst bottlenecks** row (when evacuation load is on) flies 3D to that door or stair as well as switching the 2D storey.

---

## 7. Graph Viewer

Rooms (and stairs/lifts) as nodes, laid out by storey. **Everyday paths are not picked here** — use Navmesh right-click on the plan.

- **Scroll** — zoom. **Drag background** — pan. **Fit** — whole graph.
- **Left-click** a space or link — select (multi-select is allowed).
- **Right-click a node** — **remove** or restore that entity from the live graph (soft exclude). The room can still show as a ghost on the plan.
- **Right-click a link** — disable or restore (disabled links look dashed).

**Graph variant** (dropdown) — only these two appear in the UI:

| Variant | What it is |
| --- | --- |
| **Geometry rules** (default after ingest) | IFC plus healed door / opening / stair links. Use this while routing. |
| **IFC relations** | Only explicit IFC space-boundary relations. Often too sparse to connect a real export. |

Healed links are coloured: **yellow** door heal, **green** space opening, **purple** stair. Grey is an authored IFC relation. Nested “parent” rooms can show a **red circle** (a large space that contains smaller ones).

There is **no Topologic / TopologicPy choice** in the operator UI. That backend variant is an unfinished optional experiment, not part of a demo.

---

## 8. Control panel

The **Control** tray (right):

- Filter by **level** and **category** (region, IFC door, door heal, space heal, exit, stair/lift).
- Search names.
- See the current selection.
- **Remove** or restore (same idea as Graph Viewer right-click).

Use Control when you need a door by name instead of hunting on the plan.

**Remove vs block:** Remove takes the entity out of the live graph/navmesh until you restore it. **Block** (next section) is a session what-if: the entity stays drawn, with a slash.

---

## 9. Ask for a walkable route (Navmesh tab)

Switch the 2D Viewer to **Navmesh**. You should see walkable **regions**, door/heal/exit **portals**, and (if enabled) furniture.

If the bar says **Recalculating navmesh…**, wait — exclusions and first load rebuild the grids.

### Point to point (**Route**)

1. Choose **Route**.
2. **Right-click** a walkable spot — start pin.
3. **Right-click** another spot — end pin (can be on **another storey**; stairs/lifts bridge floors).

The line stays in rooms, goes through doors, **around furniture**, and tries to stay about **40 cm** off walls so it does not scrape inner corners. In a very narrow pinch it may get closer because there is no wider option.

- **Long right-click** — clear the route.
- Click **inside** a tinted region. A miss does nothing useful.

### Nearest exit (**Nearest exit**)

1. Choose **Nearest exit**.
2. **Right-click** one point.

INFER searches for the closest reachable **exit**, including via stairs to another floor.

### Selection vs block

On Navmesh:

- **Left-click** a portal or room — select after a short delay (Inspector / Control).
- **Double-click a portal** — **block / unblock** that door or opening for this session (slash on the circle).
- **Double-click a space** — **block / unblock** the whole room (pale fill + diagonal slash). Routing and evacuation skip it; the room is not removed.

The status chip **N blocked · clear** clears all blocked doors and rooms at once. The IFC file is unchanged.

---

## 10. Evacuation load

Still on **Navmesh**, turn on **Evacuation load**.

INFER pretends every **unblocked** room walks to its nearest exit and **heats** the doors and stairs that would carry the most traffic. Larger rooms count for more than tiny ones (~area, not a real headcount file).

- You may see **computing…** on a big building.
- Blocking a door or a room **changes the heat**.
- **Worst bottlenecks** (top-right list): ranked doors/stairs; click a row to jump 2D storey and fly 3D to that opening.

This is a **planning sketch**, not a certified fire-engineering model.

---

## 11. Share and export a route

When a **navmesh route** exists (start and end, or nearest-exit path), the top bar shows **Share**.

- **GLB** download (route tube plus rooms, or live IFC geometry if the 3D pane is open and loaded).
- On **iPhone**, **USDZ** for Quick Look / AR when offered.
- **Short-lived share link + QR** so another device on the same network can open the 3D path without installing INFER.

If the 3D pane is closed, export uses a simpler extruded-plan stand-in, not full BIM materials.

---

## 12. Limits (read this before a demo)

- **POC quality.** Paths, heals, and exits are for demonstration. Do not use them as the sole basis for life-safety sign-off.
- **IFC quality matters.** Missing spaces, missing doors, or furniture with no usable mesh leave gaps.
- **Refresh loses the UI session.** Re-open the model.
- **One storey on the 2D plan.** Change the dropdown to see another floor; a multi-storey *route* still draws the piece on the storey you are viewing.
- Walls on the IFC plan can still look like simple strips (hulls). Furniture uses true concave occupancy.
- A few odd furniture types may have no extractable plan outline and will not draw or block.

---

## 13. Quick recipes

**“Show me the building.”**  
Open model → wait for toast → 2D **IFC** tab, pick a storey → Legend if cluttered → 3D Orbit or Fly.

**“Get me from this desk to the lobby.”**  
Navmesh → **Route** → right-click desk well → switch storey if needed → right-click lobby.

**“Nearest way out from here.”**  
Navmesh → **Nearest exit** → right-click.

**“This door is locked” / “This room is closed.”**  
Navmesh → double-click the portal or the space → re-run the route or refresh evacuation load. Unblock the same way, or **N blocked · clear**.

**“This stair should not exist in the live model.”**  
Control or Graph → **Remove** the stair (not the same as a session block). Restore from Control / Graph.

**“Where would people bunch up?”**  
Navmesh → Evacuation load → read the heat and **Worst bottlenecks**.

**“Why won’t it route?”**  
You are on the IFC tab (no pins). Or the click missed a region. Or start and end are disconnected (blocked door/room, removed entity, sparse **IFC relations** graph). Switch to **Geometry rules**, unblock, pick points inside rooms.

---

## 14. For developers (short)

| Need | Where |
| --- | --- |
| Run / API | [README.md](../README.md), [backend/README.md](../backend/README.md) |
| Graph variants (including unused topologic API) | [graph-variants.md](graph-variants.md) |
| Graph pane internals | [graph-viewer.md](graph-viewer.md) |
| Interactive API | http://127.0.0.1:8000/docs |

---

*INFER is an internal government internship proof-of-concept. Not licensed for external distribution.*
