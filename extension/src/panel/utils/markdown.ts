import MarkdownIt from "markdown-it";
import hljs from "highlight.js";
// Import common languages to reduce bundle size if needed, but for now we use all
import "highlight.js/styles/github.css"; // We'll override with Claude style in CSS

const md = new MarkdownIt({
  html: true,
  linkify: true,
  typographer: true,
  highlight: (str, lang) => {
    if (lang && hljs.getLanguage(lang)) {
      try {
        return (
          '<pre class="hljs"><code>' +
          hljs.highlight(str, { language: lang, ignoreIllegals: true }).value +
          "</code></pre>"
        );
      } catch (__) {}
    }

    return '<pre class="hljs"><code>' + md.utils.escapeHtml(str) + "</code></pre>";
  },
});

export function renderMarkdown(content: string): string {
  if (!content) return "";
  return md.render(content);
}
