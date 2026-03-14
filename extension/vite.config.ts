import { cpSync, existsSync, readFileSync, renameSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath, URL } from "node:url";
import tailwindcss from "@tailwindcss/vite";
import vue from "@vitejs/plugin-vue";
import { defineConfig } from "vite";

const WORKER_SAFE_PRELOAD_HELPER_SOURCE = [
  "const seen = {};",
  "const resolveUrl = (url, importerUrl) => new URL(url, importerUrl).href;",
  "const settleAll = (items) => Promise.all(items.map((item) => Promise.resolve(item).then((value) => ({ status: 'fulfilled', value }), (reason) => ({ status: 'rejected', reason }))));",
  "function reportPreloadError(error) {",
  "  const canDispatch = typeof globalThis !== 'undefined' && typeof globalThis.dispatchEvent === 'function' && typeof Event === 'function';",
  "  if (canDispatch) {",
  "    const event = new Event('vite:preloadError', { cancelable: true });",
  "    event.payload = error;",
  "    globalThis.dispatchEvent(event);",
  "    if (event.defaultPrevented) return;",
  "  }",
  "  throw error;",
  "}",
  "const preload = (importer, deps, importerUrl) => {",
  "  const hasDom = typeof document !== 'undefined' && typeof document.createElement === 'function' && typeof document.querySelector === 'function' && !!document.head;",
  "  let preloadPromise = Promise.resolve();",
  "  if (hasDom && deps && deps.length > 0) {",
  "    preloadPromise = settleAll(deps.map((dep) => {",
  "      const href = resolveUrl(dep, importerUrl);",
  "      if (href in seen) return;",
  "      seen[href] = true;",
  "      const isCss = href.endsWith('.css');",
  "      const selector = isCss ? 'link[href=\"' + href + '\"][rel=\"stylesheet\"]' : 'link[href=\"' + href + '\"]';",
  "      if (document.querySelector(selector)) return;",
  "      const link = document.createElement('link');",
  "      link.rel = isCss ? 'stylesheet' : 'modulepreload';",
  "      if (!isCss) link.as = 'script';",
  "      link.crossOrigin = '';",
  "      link.href = href;",
  "      document.head.appendChild(link);",
  "      if (!isCss) return;",
  "      return new Promise((resolve, reject) => {",
  "        link.addEventListener('load', resolve);",
  "        link.addEventListener('error', () => reject(new Error('Unable to preload CSS for ' + href)));",
  "      });",
  "    }));",
  "  }",
  "  return preloadPromise.then((results) => {",
  "    for (const item of results || []) {",
  "      if (item.status === 'rejected') reportPreloadError(item.reason);",
  "    }",
  "    return importer().catch(reportPreloadError);",
  "  });",
  "};",
  "export { preload as t };"
].join("\n");

function emitManifest() {
  const manifestPath = fileURLToPath(new URL("./manifest.json", import.meta.url));
  let rootDir = "";
  let outDir = "dist";
  const SERVICE_WORKER_FILE = "service-worker.js";

  return {
    name: "emit-manifest",
    apply: "build",
    configResolved(config) {
      rootDir = config.root;
      outDir = config.build.outDir;
    },
    generateBundle(_outputOptions, bundle) {
      this.emitFile({
        type: "asset",
        fileName: "manifest.json",
        source: readFileSync(manifestPath, "utf-8")
      });

      // Vite preload helper assumes DOM (window/document) by default.
      // Service Worker does not provide DOM, so command lazy-load in lifo
      // can throw "window/document is not defined". Replace helper with
      // a worker-safe implementation (skip preload when DOM is unavailable).
      for (const [fileName, output] of Object.entries(bundle)) {
        if (!/\/?preload-helper(?:-[^/]+)?\.js$/i.test(fileName)) continue;
        if (output.type !== "chunk") continue;
        output.code = WORKER_SAFE_PRELOAD_HELPER_SOURCE;
      }

      // Service Worker 运行时禁止 dynamic import()，而 lifo 的命令注册默认使用
      // import("./assets/*.js") 懒加载。这里把该模式改为静态导入模块命名空间，
      // 再用 Promise.resolve(moduleNs) 保持原有 Promise 语义。
      const swChunk = bundle[SERVICE_WORKER_FILE];
      if (swChunk && swChunk.type === "chunk") {
        const code = swChunk.code;
        const pattern = /import\((['"`])(\.\/assets\/[^'"`]+?\.js)\1\)/g;
        const shouldKeepDynamicImport = (path: string): boolean => {
          // Keep UI/runtime browser-only bundles dynamic so Service Worker
          // won't evaluate DOM-dependent modules at registration time.
          return /\/(?:core|dist\d*|__vite-browser-external)\.js$/i.test(path);
        };
        const moduleByPath = new Map<string, string>();
        let transformed = code.replace(pattern, (full, _quote, path: string) => {
          if (shouldKeepDynamicImport(path)) {
            return full;
          }
          let id = moduleByPath.get(path);
          if (!id) {
            id = `__bbl_sw_static_import_${moduleByPath.size}`;
            moduleByPath.set(path, id);
          }
          return `Promise.resolve(${id})`;
        });

        if (moduleByPath.size > 0) {
          const importLines = [...moduleByPath.entries()]
            .map(([path, id]) => `import * as ${id} from "${path}";`)
            .join("\n");
          transformed = `${importLines}\n${transformed}`;
          swChunk.code = transformed;
        }
      }
    },
    closeBundle() {
      const indexPath = resolve(rootDir, outDir, "index.html");
      const sidepanelPath = resolve(rootDir, outDir, "sidepanel.html");
      const debugIndexPath = resolve(rootDir, outDir, "debug-index.html");
      const debugPath = resolve(rootDir, outDir, "debug.html");
      const pluginStudioIndexPath = resolve(rootDir, outDir, "plugin-studio-index.html");
      const pluginStudioPath = resolve(rootDir, outDir, "plugin-studio.html");
      const pluginsSourcePath = resolve(rootDir, "plugins");
      const pluginsOutPath = resolve(rootDir, outDir, "plugins");
      if (existsSync(indexPath)) renameSync(indexPath, sidepanelPath);
      if (existsSync(debugIndexPath)) renameSync(debugIndexPath, debugPath);
      if (existsSync(pluginStudioIndexPath)) renameSync(pluginStudioIndexPath, pluginStudioPath);
      if (existsSync(pluginsSourcePath)) {
        cpSync(pluginsSourcePath, pluginsOutPath, { recursive: true, force: true });
      }
    }
  };
}

export default defineConfig({
  base: "./",
  plugins: [tailwindcss(), vue(), emitManifest()],
  build: {
    // Service Worker 没有 DOM，不能注入 Vite preload helper（其内部依赖 window/document）。
    modulePreload: false,
    outDir: "dist",
    emptyOutDir: true,
    target: "chrome120",
    rollupOptions: {
      input: {
        sidepanel: fileURLToPath(new URL("./index.html", import.meta.url)),
        debug: fileURLToPath(new URL("./debug-index.html", import.meta.url)),
        "plugin-studio": fileURLToPath(new URL("./plugin-studio-index.html", import.meta.url)),
        "eval-sandbox": fileURLToPath(new URL("./eval-sandbox.html", import.meta.url)),
        "sandbox-host": fileURLToPath(new URL("./sandbox-host.html", import.meta.url)),
        "service-worker": fileURLToPath(new URL("./src/background/sw-main.ts", import.meta.url)),
        "cursor-help-content": fileURLToPath(new URL("./src/content/cursor-help-content.ts", import.meta.url)),
        "cursor-help-page-hook": fileURLToPath(new URL("./src/injected/cursor-help-page-hook.ts", import.meta.url))
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
