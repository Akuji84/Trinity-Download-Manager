# Download Test Harness

Standalone local site for testing Trinity against delivery behaviors instead of specific public websites.

## Scenarios

- Direct static file
- Redirected file
- Browser-managed gated file
- JS-triggered download
- Resumable large file

## Run

From the repo root:

```bash
npm run harness
```

Then open:

```text
http://127.0.0.1:48612
```

## Design constraints

- No large binary fixtures are committed to git.
- Files are generated on demand with deterministic bytes.
- Range requests are supported for resumable testing.
- The harness is intentionally generic and should not drive production Trinity behavior through hardcoded assumptions.
