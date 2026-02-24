import MarkdownIt from "markdown-it";
import hljs from "highlight.js";
// We use custom minimalist styles in styles.css

const md = new MarkdownIt({
  html: false,
  linkify: true,
  typographer: true,
  highlight: (str: string, lang: string): string => {
    if (lang && hljs.getLanguage(lang)) {
      try {
        return hljs.highlight(str, { language: lang, ignoreIllegals: true }).value;
      } catch {
        // Fall through
      }
    }
    return md.utils.escapeHtml(str);
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
