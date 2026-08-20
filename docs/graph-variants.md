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

Source IFC is never modified.
"""
