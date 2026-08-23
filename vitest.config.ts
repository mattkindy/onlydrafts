import { defineConfig } from "vite";
import preact from "@preact/preset-vite";

/**
 * Vitest reads vite.config.ts by default, and that one roots itself at
 * app/ so the site builds from there. Tests live all over the tree.
 */
export default defineConfig({
  plugins: [preact()],
  test: {
    environmentMatchGlobs: [["app/**", "jsdom"]],
  },
});
