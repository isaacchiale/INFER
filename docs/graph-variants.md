"""Graph variant layers: IFC / geometry / TopologicPy (on-prem).

Variants
--------
- ``ifc`` — strict IfcRelSpaceBoundary graph → ``graph.json``
- ``geometry`` — IFC ∪ door/opening/stair/wall-strip healing → ``graph.geometry.json``
- ``topologic`` — IFC ∪ TopologicPy adjacency → ``graph.topologic.json``
  (optional stub; not required for space↔space heal)

TopologicPy
-----------
Not installed by default. After license review (prefer MIT/MPL/LGPL; flag AGPL):

.. code-block:: bash

   pip install topologicpy

Processing must stay on-prem; never upload IFC to a cloud topology service.
If TopologicPy is missing, ``POST /models/{id}/graph?variant=topologic`` returns
an error while ``ifc`` and ``geometry`` continue to work.

Inferred edge colours (Graph Viewer)
------------------------------------
Baseline ``ifc_rel_space_boundary`` edges stay grey. Healed edges:

- **Yellow** — door heal (``geom_door_space`` / collapsed space–door–space)
- **Green** — space↔space heal (``geom_opening_space``)
- **Purple** — stair heal (``geom_stair_space``)

Door healing (geometry)
-----------------------
A door has at most two space links (IFC ∪ geom):

- **≥2 IFC links** — no geometry top-up for that door
- **1 IFC link** — add at most one partner: closest same-storey candidate within
  1 m that passes the between-math **with the IFC-linked space**
- **0 IFC links** — pick ≤2 spaces via between/nearest rules

Between-math uses closest footprint points (not centroids): opposite approach
directions when outside both (angle ≳ ~110°, contacts collinear through the
door); when on/in one space, the other contact must lie along that space's
outward wall normal at the door and near the same opening.

Space↔space healing (geometry) — wall strip
-------------------------------------------
Footprints include ``IfcWall`` hulls plus openings/doors. For each same-storey
pair of spaces that share a facing frontage:

1. Sample the strip between them along that frontage.
2. Mark samples blocked where they hit a wall polygon.
3. Carve samples clear near **same-storey** opening/door portals (voids often
   absent from wall mesh). Doors stacked at the same XY on other floors are ignored.
   Only openings that void an ``IfcWall`` (``host_is_wall``) may carve: Revit
   exports cabinet and countertop recesses as ``IfcOpeningElement`` hosted by
   ``IfcFurnishingElement``, and those stand against walls, so trusting them
   punches doorways through solid partitions.
4. If a contiguous **clear span** ≥ ~0.7 m remains along the shared outline
   (room-A boundary order, not the line between space centroids) → emit
   inferred ``space_space`` (``geom_opening_space``). Partial wall + opening
   ⇒ connect; full wall seal ⇒ no.
5. Set edge ``portal`` to the **centre of the walkable clear frontage** (wide open
   strip → average of all clear midpoints; narrow doorway → longest clear run).
   Optionally tag ``global_id`` when an unfilled IfcOpening sits near that portal —
   never overwrite the portal with furniture openings.
6. Skip if the same door already links both spaces.

Never: pick “two nearest rooms to an opening” across the plan.

Nested parents (geometry)
-------------------------
Spaces whose **walkable** footprints contain smaller same-storey spaces are
flagged ``nested_parent: true`` on the geometry graph. Containment uses
exterior-minus-holes: a lift/courtyard space sitting only in a parent hole
does **not** count. The Graph Viewer draws a red circle around flagged nodes.
Right-click remove recalculates geometry healing for that node's storey
without it (other storeys keep their inferred edges).

Source IFC is never modified.
"""
