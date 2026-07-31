import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      "/api": "http://localhost:8000",
    },
    // The repository root, one level above this Vite root. AboutPanel.test.tsx
    // reads LICENSE with `?raw` to prove the panel's copyright line still
    // matches the file, and without this Vite refuses the id outright —
    // "Denied ID .../LICENSE?raw", which at least fails loudly rather than
    // resolving to the empty string the CSS import used to.
    // Nothing outside the repository becomes readable, and this affects the
    // dev server and the test runner only: `vite build` never consults it.
    fs: {
      allow: [".."],
    },
  },
  test: {
    // Without this, vitest stubs CSS out of the module graph and
    // `import css from "./index.css?raw"` yields an EMPTY STRING rather than
    // failing. focus-visible.test.ts reads the stylesheet to prove a focus rule
    // exists and no rule suppresses one, and half of those assertions are
    // negative — against "" they would all pass while proving nothing.
    // The alternative was node:fs, which needs @types/node as a dependency.
    css: true,
  },
});
