import { z } from "zod";

// Zod 4 probes for eval support (new Function) to compile faster parsers. Our CSP has no
// 'unsafe-eval', so the browser blocks the probe and reports a CSP violation every time,
// even though zod catches it and falls back. jitless skips the probe: same results, no
// violation. Imported first by app/providers.tsx, before anything parses.
z.config({ jitless: true });
