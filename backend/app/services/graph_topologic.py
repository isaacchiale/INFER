"""
Optional TopologicPy graph builder.

TopologicPy is NOT pinned by default (license / install review). When the package
is unavailable, callers receive TopologicUnavailableError and IFC/geometry
variants remain usable.

Install (on-prem only, after license review):
  pip install topologicpy
See docs/graph-variants.md.
"""

from __future__ import annotations

from app.schemas.graph import ConnectivityGraph, GraphEdge


class TopologicUnavailableError(Exception):
    """Raised when TopologicPy is not installed or cannot process the model."""


def topologic_available() -> bool:
    try:
        import topologicpy  # noqa: F401

        return True
    except ImportError:
        return False


def build_topologic_graph(
    model_id: str,
    ifc_file_path: str,
    ifc_graph: ConnectivityGraph,
) -> ConnectivityGraph:
    """
    Build a superset graph: IFC edges plus TopologicPy-derived space adjacencies.

    POC strategy: if TopologicPy imports, attempt a lightweight adjacency pass.
    Full cell-complex healing is deferred — when the library API cannot produce
    space GlobalId adjacencies, raise TopologicUnavailableError with detail.
    """
    if not topologic_available():
        raise TopologicUnavailableError(
            "TopologicPy is not installed. Install on-prem after license review "
            "(see docs/graph-variants.md). IFC and geometry variants remain available."
        )

    # Import guarded — optional dependency.
    try:
        # Probe that the expected surface exists; real topology extract varies by version.
        import topologicpy  # noqa: F401
    except ImportError as exc:
        raise TopologicUnavailableError(str(exc)) from exc

    # Conservative POC: do not invent fake adjacencies. Require a successful
    # topology extract; until wired, surface a clear "not yet implemented" path
    # only when the package IS present so operators know the next spike step.
    #
    # Prefer failing soft with an actionable message over silent empty graphs.
    raise TopologicUnavailableError(
        "TopologicPy is installed, but the INFER topologic adjacency extractor "
        "is not fully wired for this environment yet. Use IFC or geometry variants. "
        f"(model={model_id}, ifc={ifc_file_path})"
    )


def merge_topologic_edges(
    ifc_graph: ConnectivityGraph,
    adjacency_pairs: list[tuple[str, str]],
) -> ConnectivityGraph:
    """
    Helper for tests / future extractor: add space↔space inferred edges.
    adjacency_pairs are space GlobalIds.
    """
    nodes = list(ifc_graph.nodes)
    node_ids = {n.id for n in nodes}
    edges = [e.model_copy(deep=True) for e in ifc_graph.edges]
    edge_ids = {e.id for e in edges}

    for a_gid, b_gid in adjacency_pairs:
        a = f"space:{a_gid}"
        b = f"space:{b_gid}"
        if a not in node_ids or b not in node_ids or a == b:
            continue
        lo, hi = (a, b) if a < b else (b, a)
        eid = f"space_space:{lo}:{hi}:topologic"
        if eid in edge_ids:
            continue
        edges.append(
            GraphEdge(
                id=eid,
                kind="space_space",
                source=a,
                target=b,
                method="topologicpy_adjacency",
                bidirectional=True,
                inferred=True,
            )
        )
        edge_ids.add(eid)

    return ConnectivityGraph(
        model_id=ifc_graph.model_id,
        variant="topologic",
        nodes=nodes,
        edges=edges,
    )
