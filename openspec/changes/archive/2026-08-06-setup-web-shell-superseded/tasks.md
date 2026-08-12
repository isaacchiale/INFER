## 1. Scaffold Vite app

- [x] 1.1 Create Vite React-TypeScript project at INFER root without deleting `openspec/`, `docs/`, or `.cursor/`
- [x] 1.2 Install dependencies with npm and ensure a lockfile is present
- [x] 1.3 Confirm TypeScript and Vite configs build cleanly

## 2. Application shell UI

- [x] 2.1 Replace default Vite boilerplate with an INFER header (brand + short subtitle)
- [x] 2.2 Add a main content pane placeholder for the future IFC viewer
- [x] 2.3 Apply minimal base styles (readable layout; no analytics or external font CDNs required)

## 3. Docs and security notes

- [x] 3.1 Add or update README with `npm install`, `npm run dev`, `npm run build`
- [x] 3.2 Document static `dist/` hosting and browser-only / no-upload posture
- [x] 3.3 Add brief production CSP guidance (recommended headers; note HMR/WASM caveats)

## 4. Verification

- [x] 4.1 Run `npm run build` successfully
- [x] 4.2 Smoke-check `npm run dev` loads the INFER shell in the browser
- [x] 4.3 Confirm no backend server or remote model-upload path was introduced
