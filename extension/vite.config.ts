import { existsSync, readFileSync, renameSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath, URL } from "node:url";
import tailwindcss from "@tailwindcss/vite";
import vue from "@vitejs/plugin-vue";
import { defineConfig } from "vite";

function emitManifest() {
  const manifestPath = fileURLToPath(new URL("./manifest.json", import.meta.url));
  let rootDir = "";
  let outDir = "dist";

  return {
    name: "emit-manifest",
    apply: "build",
    configResolved(config) {
      rootDir = config.root;
      outDir = config.build.outDir;
    },
    generateBundle() {
      this.emitFile({
        type: "asset",
        fileName: "manifest.json",
        source: readFileSync(manifestPath, "utf-8")
      });
    },
    closeBundle() {
      const indexPath = resolve(rootDir, outDir, "index.html");
      const sidepanelPath = resolve(rootDir, outDir, "sidepanel.html");
      const debugIndexPath = resolve(rootDir, outDir, "debug-index.html");
      const debugPath = resolve(rootDir, outDir, "debug.html");
      if (existsSync(indexPath)) renameSync(indexPath, sidepanelPath);
      if (existsSync(debugIndexPath)) renameSync(debugIndexPath, debugPath);
    }
  };
}

export default defineConfig({
  base: "./",
  plugins: [tailwindcss(), vue(), emitManifest()],
  build: {
    outDir: "dist",
    emptyOutDir: true,
    target: "chrome120",
    rollupOptions: {
      input: {
        sidepanel: fileURLToPath(new URL("./index.html", import.meta.url)),
        debug: fileURLToPath(new URL("./debug-index.html", import.meta.url)),
        "service-worker": fileURLToPath(new URL("./src/background/sw-main.ts", import.meta.url))
      },
      output: {
        entryFileNames: (chunkInfo) =>
          chunkInfo.name === "service-worker" ? "service-worker.js" : "assets/[name].js",
        chunkFileNames: "assets/[name].js",
        assetFileNames: "assets/[name][extname]"
      }
    }
  }
});
