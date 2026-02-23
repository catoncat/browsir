function loadCss(url) {
  return new Promise((resolve, reject) => {
    const link = document.createElement("link");
    link.rel = "stylesheet";
    link.href = url;
    link.onload = () => resolve(link);
    link.onerror = () => reject(new Error(`CSS load failed: ${url}`));
    document.head.appendChild(link);
  });
}

async function bootSidepanel() {
  try {
    await loadCss("./dist/assets/sidepanel.css");
    await import("./dist/assets/sidepanel.js");
  } catch (err) {
    console.error("[sidepanel-loader] failed to boot dist assets", err);
    document.body.classList.add("no-dist");
  }
}

void bootSidepanel();
