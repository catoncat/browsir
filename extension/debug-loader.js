import("./dist/assets/debug.js").catch(() => {
  document.body.classList.add("no-dist");
});
