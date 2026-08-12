## Purpose

Accepts IFC model uploads and stores them on local on-prem disk with stable identifiers and metadata for later extraction and analysis.

## ADDED Requirements

### Requirement: Upload IFC model
The system MUST accept an IFC file upload over HTTP and store the original bytes on local disk without modifying the source file contents.

#### Scenario: Successful upload
- **WHEN** a client uploads a valid `.ifc` file to the ingest endpoint
- **THEN** the system stores the file under the local models data directory
- **AND** returns a stable model identifier and basic metadata (original filename, size, created time)

#### Scenario: Reject non-IFC extension
- **WHEN** a client uploads a file that does not use an allowed IFC extension
- **THEN** the system rejects the request with a client error

### Requirement: Retrieve model metadata
The system MUST allow clients to retrieve metadata for a previously uploaded model by its identifier.

#### Scenario: Known model
- **WHEN** a client requests metadata for an existing model id
- **THEN** the system returns the stored metadata

#### Scenario: Unknown model
- **WHEN** a client requests metadata for a missing model id
- **THEN** the system returns a not-found error

### Requirement: On-prem only storage
Uploaded IFC models MUST remain on local filesystem storage configured for the service and MUST NOT be forwarded to external cloud or SaaS endpoints by this capability.

#### Scenario: Storage location is local
- **WHEN** a model is uploaded
- **THEN** its bytes are written only under the configured local data directory
