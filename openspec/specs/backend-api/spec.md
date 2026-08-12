# backend-api Specification

## Purpose
Provides the on-prem FastAPI service shell for INFER: health checks, localhost-first operation, CORS for an external frontend, and a local data directory convention for future IFC storage.
## Requirements
### Requirement: Health endpoint
The backend MUST expose an HTTP health endpoint that reports the service is running without requiring IFC input.

#### Scenario: Health check succeeds
- **WHEN** a client requests the health endpoint
- **THEN** the service responds with HTTP 200 and a JSON body indicating a healthy status

### Requirement: Localhost-first binding
The backend MUST default to binding on localhost for the POC so it is not publicly reachable without explicit configuration.

#### Scenario: Default start is local only
- **WHEN** an operator starts the backend with default settings
- **THEN** the service listens on a localhost address (for example 127.0.0.1)

### Requirement: CORS for external frontend development
The backend MUST support a configurable CORS allowlist so a separately developed frontend can call the API during local development.

#### Scenario: Allowed origin can call the API
- **WHEN** the CORS allowlist includes the frontend origin
- **THEN** browser preflight/requests from that origin are permitted for configured methods and headers

#### Scenario: Default deny unknown origins
- **WHEN** a browser request comes from an origin not on the allowlist
- **THEN** the CORS policy does not grant that origin access

### Requirement: Local data directory convention
The backend MUST define a local filesystem data directory for future model and derived-artifact storage, and MUST NOT require cloud object storage for the POC.

#### Scenario: Data directory is available
- **WHEN** the backend starts
- **THEN** a configured local data directory exists or is created for subsequent IFC/model storage

### Requirement: Documented run instructions
The backend MUST include documentation for creating a virtual environment, installing dependencies, and starting the API locally.

#### Scenario: Developer follows docs
- **WHEN** a developer follows the backend setup documentation
- **THEN** they can install dependencies and start the health endpoint successfully

