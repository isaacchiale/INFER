## Purpose

Provides the browser-hosted SPA shell for INFER: local development, static production build, and a minimal layout that later features mount into without introducing a backend.

## ADDED Requirements

### Requirement: Local development server
The system MUST provide a local development command that serves the web application in a browser for interactive development.

#### Scenario: Developer starts the app locally
- **WHEN** a developer runs the documented local start command after installing dependencies
- **THEN** the application loads in a browser without requiring a separate application backend

### Requirement: Static production build
The system MUST produce a static production build that can be hosted on intranet static file servers without a Node runtime at request time.

#### Scenario: Production build succeeds
- **WHEN** a developer runs the documented production build command
- **THEN** the system emits static assets under a `dist/` (or equivalent) output directory

#### Scenario: Static hosting without backend
- **WHEN** the production build is served as static files
- **THEN** the application shell loads without calling a remote API for core shell functionality

### Requirement: Application chrome and main pane
The system MUST present an identifiable INFER application shell with a main content pane reserved for future viewer and tooling features.

#### Scenario: Initial load shows shell
- **WHEN** a user opens the application
- **THEN** the UI shows the INFER product identity and a main pane placeholder suitable for mounting later features

### Requirement: Browser-only data posture for the shell
The web shell MUST NOT upload user files or model data to any remote server as part of its baseline behavior.

#### Scenario: No model upload endpoints
- **WHEN** the application shell is running in its baseline configuration
- **THEN** it does not provide or invoke a remote upload API for IFC or other building model files

### Requirement: Documented run and deploy notes
The system MUST include brief documentation for installing dependencies, running locally, building for production, and hosting the static output with security-minded notes for government POC use.

#### Scenario: Developer follows setup docs
- **WHEN** a developer reads the project setup documentation
- **THEN** they can install, run, and build the shell without undocumented steps
