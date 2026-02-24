import MarkdownIt from "markdown-it";
import hljs from "highlight.js";
// We use custom minimalist styles in styles.css

const md = new MarkdownIt({
  html: false,
  linkify: true,
  typographer: true,
  highlight: (str: string, lang: string): string => {
    const code = (lang && hljs.getLanguage(lang))
      ? hljs.highlight(str, { language: lang, ignoreIllegals: true }).value
      : md.utils.escapeHtml(str);

    return `<div class="code-block-wrapper group/code relative">
      <button class="copy-code-button" title="复制代码" type="button" aria-label="复制代码">
        <svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect width="14" height="14" x="8" y="8" rx="2" ry="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/></svg>
      </button>
      <pre class="hljs"><code>${code}</code></pre>
    </div>`;
  },
});

// Add a plugin or rule to ensure all links open in a new tab
const defaultRender = md.renderer.rules.link_open || function(tokens, idx, options, env, self) {
  return self.renderToken(tokens, idx, options);
};

md.renderer.rules.link_open = function(tokens, idx, options, env, self) {
  // If you are sure other plugins won't add target/rel, you can just set them
  const aIndex = tokens[idx].attrIndex("target");

  if (aIndex < 0) {
    tokens[idx].attrPush(["target", "_blank"]); // add new attribute
  } else {
    (tokens[idx].attrs as [string, string][])[aIndex][1] = "_blank"; // replace value of existing attribute
  }

  const relIndex = tokens[idx].attrIndex("rel");
  if (relIndex < 0) {
    tokens[idx].attrPush(["rel", "noopener noreferrer"]);
  } else {
    (tokens[idx].attrs as [string, string][])[relIndex][1] = "noopener noreferrer";
  }

  // pass token to default renderer.
  return defaultRender(tokens, idx, options, env, self);
};

export function renderMarkdown(content: string): string {
  if (!content) return "";
  return md.render(content);
}
