const tryBootDist = async () => {
  const app = document.getElementById("app");
  if (!app) return false;

  const loadCss = (href) =>
    new Promise((resolve, reject) => {
      const link = document.createElement("link");
      link.rel = "stylesheet";
      link.href = href;
      link.onload = () => resolve();
      link.onerror = reject;
      document.head.appendChild(link);
    });

  const loadCssList = async (urls, options = {}) => {
    const { optional = [] } = options;
    for (const url of urls) {
      const isOptional = optional.includes(url);
      try {
        await loadCss(url);
      } catch (error) {
        if (!isOptional) throw error;
      }
    }
  };

  try {
    await loadCssList(
      [
        "./dist/assets/styles.css",
        "./dist/assets/plugin-studio.css"
      ],
      {
        optional: ["./dist/assets/plugin-studio.css"]
      }
    );
    await import("./dist/assets/plugin-studio.js");
    return true;
  } catch (err) {
    console.error("[plugin-studio-loader] failed to boot dist assets", err);
    return false;
  }
};

(async () => {
  const ok = await tryBootDist();
  if (!ok) document.body.classList.add("no-dist");
})();
