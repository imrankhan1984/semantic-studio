import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      "/api": "http://localhost:8000",
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
