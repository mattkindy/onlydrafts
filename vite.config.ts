import { defineConfig } from "vite";
import preact from "@preact/preset-vite";

/**
 * The draft page, built into the folder the site is served from.
 *
 * It used to be one hand written html file assigning strings to
 * innerHTML, which is how a team name from somebody else's league came
 * to be able to run script here. A framework escapes what it puts on
 * the page, so that whole class of mistake goes away.
 */
export default defineConfig({
  plugins: [preact()],
  root: "app",
  base: "./",
  build: {
    outDir: "../docs",
    emptyOutDir: false,
    target: "es2022",
  },
});
