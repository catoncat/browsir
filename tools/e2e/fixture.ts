import { TEST_TAB_TITLE } from "./constants";

export function buildTestPageFixtureScript(): string {
  return `(() => {
    document.title = ${JSON.stringify(TEST_TAB_TITLE)};
    document.body.innerHTML = [
      '<main id="app">',
      '  <label for="name">Name</label>',
      '  <input id="name" type="text" value="" />',
      '  <label>Plain Text</label>',
      '  <textarea placeholder="Write plain text here"></textarea>',
      '  <button id="act" type="button">Act</button>',
      '  <button id="focus-act" type="button">Focus Act</button>',
      '  <button id="share" type="button">Share</button>',
      '  <button id="rerender" type="button">Rerender</button>',
      '  <div id="out">idle</div>',
      '  <div id="share-out">share:idle</div>',
      '  <section id="dyn-vue-root">loading-dynamic...</section>',
      '  <section id="dyn-monaco-root">loading-monaco...</section>',
      '</main>'
    ].join('');

    const wireAct = (el) => {
      el.addEventListener("click", () => {
        const value = (document.querySelector("#name") || {}).value || "";
        const out = document.querySelector("#out");
        if (out) out.textContent = "clicked:" + value;
      });
    };

    const act = document.querySelector("#act");
    if (act) wireAct(act);

    const focusAct = document.querySelector("#focus-act");
    if (focusAct) {
      focusAct.addEventListener("click", () => {
        const out = document.querySelector("#out");
        if (!out) return;
        out.textContent = document.hasFocus() ? "focus-ok" : "focus-needed";
      });
    }

    const share = document.querySelector("#share");
    if (share) {
      share.addEventListener("click", () => {
        const textarea = document.querySelector("textarea[placeholder='Write plain text here']");
        const text = textarea && "value" in textarea ? String(textarea.value || "") : "";
        const out = document.querySelector("#share-out");
        if (out) out.textContent = "shared:" + text;
      });
    }

    const rerender = document.querySelector("#rerender");
    if (rerender) {
      rerender.addEventListener("click", () => {
        const current = document.querySelector("#act");
        if (!current) return;
        const next = current.cloneNode(true);
        next.textContent = "Act2";
        current.replaceWith(next);
        wireAct(next);
        const out = document.querySelector("#out");
        if (out) out.setAttribute("data-rerendered", "1");
      });
    }

    const dynState = { text: "" };
    const mountDynamicVueLike = () => {
      const root = document.querySelector("#dyn-vue-root");
      if (!root) return;
      root.innerHTML = [
        '<label for="dyn-vue-input">Dynamic Vue-like Input</label>',
        '<textarea id="dyn-vue-input" data-testid="dyn-vue-input" placeholder="Dynamic plain text"></textarea>',
        '<button id="dyn-vue-share" data-testid="dyn-vue-share" type="button">Dynamic Share</button>',
        '<div id="dyn-vue-out">dyn:idle</div>',
        '<a id="dyn-vue-link" data-testid="dyn-vue-link" href="" rel="noopener">dyn:link:idle</a>'
      ].join("");
      const input = root.querySelector("#dyn-vue-input");
      if (input && "value" in input) input.value = dynState.text;
      if (input) {
        input.addEventListener("input", () => {
          dynState.text = "value" in input ? String(input.value || "") : "";
          const out = root.querySelector("#dyn-vue-out");
          if (out) out.textContent = dynState.text ? "dyn:typing:" + dynState.text : "dyn:idle";
        });
      }
      const shareBtn = root.querySelector("#dyn-vue-share");
      if (shareBtn) {
        shareBtn.addEventListener("click", () => {
          const encoded = encodeURIComponent(String(dynState.text || ""));
          const shareUrl = "https://plain.example/share#dyn-share=" + encoded;
          const out = root.querySelector("#dyn-vue-out");
          if (out) out.textContent = "dyn:shared:" + dynState.text;
          const link = root.querySelector("#dyn-vue-link");
          if (link) {
            link.setAttribute("href", shareUrl);
            link.textContent = "dyn:link:" + shareUrl;
          }
          const shareOut = document.querySelector("#share-out");
          if (shareOut) shareOut.textContent = "share-link:" + shareUrl;
        });
      }
    };
    setTimeout(mountDynamicVueLike, 320);

    const mountMonacoLike = () => {
      const root = document.querySelector("#dyn-monaco-root");
      if (!root) return;
      root.innerHTML = [
        '<label for="dyn-monaco-input">Dynamic Monaco-like Input</label>',
        '<div class="monaco-editor" data-monaco-uri="inmemory://model/main">',
        '  <textarea id="dyn-monaco-input" data-testid="dyn-monaco-input" data-monaco-uri="inmemory://model/main" placeholder="Monaco plain text"></textarea>',
        '</div>',
        '<button id="dyn-monaco-share" data-testid="dyn-monaco-share" type="button">Monaco Share</button>',
        '<div id="dyn-monaco-out">monaco:idle</div>',
        '<a id="dyn-monaco-link" data-testid="dyn-monaco-link" href="" rel="noopener">monaco:link:idle</a>'
      ].join("");

      const uri = "inmemory://model/main";
      const models = new Map();
      const model = {
        _value: "",
        setValue(next) { this._value = String(next || ""); },
        getValue() { return this._value; }
      };
      models.set(uri, model);

      const monacoGlobal = globalThis.monaco || {};
      monacoGlobal.Uri = monacoGlobal.Uri || {
        parse(input) {
          const raw = String(input || "");
          return { toString: () => raw };
        }
      };
      monacoGlobal.editor = monacoGlobal.editor || {};
      monacoGlobal.editor.getModel = (input) => {
        const key = input && typeof input.toString === "function" ? String(input.toString()) : String(input || "");
        return models.get(key) || null;
      };
      monacoGlobal.editor.getModels = () => Array.from(models.values());
      globalThis.monaco = monacoGlobal;

      const shareBtn = root.querySelector("#dyn-monaco-share");
      if (shareBtn) {
        shareBtn.addEventListener("click", () => {
          const text = String(model.getValue() || "");
          const encoded = encodeURIComponent(text);
          const shareUrl = "https://plain.example/share#monaco-share=" + encoded;
          const out = root.querySelector("#dyn-monaco-out");
          if (out) out.textContent = "monaco:shared:" + text;
          const link = root.querySelector("#dyn-monaco-link");
          if (link) {
            link.setAttribute("href", shareUrl);
            link.textContent = "monaco:link:" + shareUrl;
          }
          const shareOut = document.querySelector("#share-out");
          if (shareOut) shareOut.textContent = "share-link:" + shareUrl;
        });
      }
    };
    setTimeout(mountMonacoLike, 480);
    return { ok: true, title: document.title };
  })()`;
}
