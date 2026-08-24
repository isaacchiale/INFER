"""Graph variant layers: IFC / geometry / TopologicPy (on-prem).

Variants
--------
- ``ifc`` — strict IfcRelSpaceBoundary graph → ``graph.json``
- ``geometry`` — IFC ∪ door/stair footprint healing → ``graph.geometry.json``
- ``topologic`` — IFC ∪ TopologicPy adjacency → ``graph.topologic.json``

TopologicPy
-----------
Not installed by default. After license review (prefer MIT/MPL/LGPL; flag AGPL):

.. code-block:: bash

   pip install topologicpy

Processing must stay on-prem; never upload IFC to a cloud topology service.
If TopologicPy is missing, ``POST /models/{id}/graph?variant=topologic`` returns
an error while ``ifc`` and ``geometry`` continue to work.

Inferred edges
--------------
Edges with ``inferred: true`` (methods ``geom_door_space``, ``geom_stair_space``,
``topologicpy_adjacency``) are drawn green in the Graph Viewer. Baseline
``ifc_rel_space_boundary`` edges stay grey.

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

Nested parents (geometry)
-------------------------
Spaces whose footprints contain smaller same-storey spaces are flagged
``nested_parent: true`` on the geometry graph. The Graph Viewer draws a red
circle around them. Detection only — parents are not removed or reduced yet.

Source IFC is never modified.
"""
