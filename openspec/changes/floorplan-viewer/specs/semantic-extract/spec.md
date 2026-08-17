## ADDED Requirements

### Requirement: Extract remains compatible with footprint join keys
Semantic extract MUST continue to provide storey and space GlobalIds (and door GlobalIds) so footprint and graph artifacts can join on the same IFC identifiers.

#### Scenario: Shared GlobalIds across artifacts
- **WHEN** extract and footprints are both available for a model
- **THEN** space and storey GlobalIds in the extract can be matched to corresponding footprint entries that use the same GlobalIds
