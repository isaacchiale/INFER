# Future plans

Not scoped for current work — captured so decisions aren't lost and so current
design doesn't accidentally foreclose them. Revisit each when its trigger hits.

## Format roadmap: IFC → IndoorGML → CityGML

- **IFC (current)** — right starting point: semantically rich, and most
  buildings already have it from construction/facilities management. No
  change needed here.
- **IndoorGML (next, when reworking the graph/routing model)** — the OGC
  standard for exactly what this project's `ConnectivityGraph` /
  cellular-space model already does ad hoc (cellular space subdivision +
  navigable connectivity graph). Worth evaluating as a target the schema
  converges toward rather than a from-scratch alternative — would buy
  interoperability with other indoor-nav tooling. Higher priority than
  CityGML for the actual routing engine.
- **CityGML (later, when going multi-building/"estates")** — city/estate-scale
  massing + terrain (LOD1-4), not indoor routing itself. The right answer for
  placing multiple buildings on one map, not for anything inside a single
  building. Pairs with the georeferencing item below.

## Georeferencing (deferred — see conversation, explicitly called premature)

`FootprintsDocument.coordinate_system` is hardcoded to a per-building local
frame (`ifc_world_xy_metres`), with no real-world anchor. Fine for one
building. The moment "estates" means multiple buildings on one map, each
building needs a real-world CRS anchor (lat/lon/rotation) to place it
relative to others — CityGML carries this natively; IFC can too
(`IfcSite.RefLatitude/RefLongitude`, or `IfcMapConversion` in IFC4).

- Don't build this now — nothing downstream consumes it yet.
- Don't design it out either — when the time comes, capturing it is cheap
  during IFC ingest; retrofitting across every already-ingested model is not.

## Phygital: phone-relative positioning pegged to the model

**Problem**: no GPS indoors. Want a phone to know roughly where it is inside
the building, tied to the same coordinate frame as the IFC-derived floorplan
and graph.

**Why raw IMU/INS doesn't work**: phone-grade accelerometers drift badly
under double integration — dead reckoning degrades to metres of error within
tens of seconds. Not an engineering detail, a physics one. Don't build on
raw IMU integration.

**What actually works — three pieces, all realistic to build:**

1. **Anchor**: a QR code at every building entrance, each encoding a known
   point in IFC coordinates. Scan once on entry to zero the tracking session
   against a known position ("I am here"). Cheap (printed stickers), no new
   hardware/infrastructure (no BLE beacons, no UWB).
   - Add secondary anchors at interior choke points too (stairwells,
     elevator lobbies, major junctions) so long walks can re-anchor and
     stop accumulating drift. These are cheap to identify programmatically
     — high-degree nodes in the existing connectivity graph — not something
     that needs manual floorplan inspection.

2. **Tracking**: ARKit (iPhone first — mature VIO, consistent across
   devices; LiDAR on 12 Pro+ is a bonus for later cross-checking against IFC
   geometry) for continuous *relative* motion tracking. This is NOT visual
   place recognition / SLAM — ARKit's camera use is motion stabilization
   (optical flow correcting IMU drift), not scene understanding. It has no
   idea what room it's looking at and doesn't need to. The QR scan is the
   only "understand what's in view" moment, and it's momentary (decode a
   code, done).
   - Full visual place recognition (walk in cold, no QR, system infers
     location from camera view alone — à la Niantic VPS / Matterport
     relocalization) is a genuinely harder, separate capability requiring a
     prebuilt visual map of the space and real inference compute. Not
     needed for a first version; would be a later upgrade, not a
     prerequisite.
   - Android/ARCore also works but sensor/camera quality varies more across
     devices — prototype on iPhone first.

3. **Drift correction**: snap the ARKit-tracked position against the
   already-computed space polygons / wall footprints (corridor-snapping /
   map-matching), so estimated position can't wander through walls and
   errors don't compound unbounded between anchor points. This is the part
   that's mostly already built — the geometry pipeline (footprints, graph)
   this project already produces is exactly the substrate a map-matching
   localizer needs. Not starting from zero here.

**Scope / sequencing**: this is a separate workstream, not a small add-on —
a new iOS client, ARKit integration, and new backend endpoints (register an
anchor, ingest/stream pose updates). Don't start until the core routing/graph
pipeline is solid. The only thing worth doing *now*, cheaply: sanity-check
that nothing in the current schema assumes a single anchor per model in a
way that would block multi-anchor later — a quick check, not a redesign.
