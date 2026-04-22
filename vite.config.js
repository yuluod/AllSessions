import { defineConfig } from "vite";
import path from "node:path";
import { fileURLToPath } from "node:url";

const currentDir = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  root: path.join(currentDir, "public"),
  build: {
    outDir: path.join(currentDir, "dist"),
    emptyOutDir: true,
  },
});
