import("./dist/assets/sidepanel.js").catch(() => {
  document.body.classList.add("no-dist");
});
