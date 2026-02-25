import langBash from "@shikijs/langs/bash";
import langJavaScript from "@shikijs/langs/javascript";
import langJson from "@shikijs/langs/json";
import langJsx from "@shikijs/langs/jsx";
import langMarkdown from "@shikijs/langs/markdown";
import langPython from "@shikijs/langs/python";
import langTsx from "@shikijs/langs/tsx";
import langTypeScript from "@shikijs/langs/typescript";
import langYaml from "@shikijs/langs/yaml";
import themeGithubDark from "@shikijs/themes/github-dark";
import themeGithubLight from "@shikijs/themes/github-light";
import { createHighlighterCore } from "shiki/core";
import { createJavaScriptRegexEngine } from "shiki/engine/javascript";

export type ShikiTheme = "github-light" | "github-dark";

type HighlighterCoreInstance = Awaited<ReturnType<typeof createHighlighterCore>>;
type HighlightLanguage = string | "text";

const PRELOADED_LANGUAGE_MODULES = [
  langBash,
  langJavaScript,
  langJson,
  langJsx,
  langMarkdown,
  langPython,
  langTsx,
  langTypeScript,
  langYaml
];

const SUPPORTED_LANGUAGES = new Set<string>([
  "text",
  "bash",
  "javascript",
  "json",
  "jsx",
  "markdown",
  "python",
  "tsx",
  "typescript",
  "yaml"
]);

const LANGUAGE_ALIASES: Record<string, HighlightLanguage> = {
  "": "text",
  plain: "text",
  plaintext: "text",
  txt: "text",
  text: "text",
  js: "javascript",
  ts: "typescript",
  py: "python",
  rb: "text",
  sh: "bash",
  shell: "bash",
  zsh: "bash",
  yml: "yaml",
  md: "markdown",
  "c++": "text",
  "c#": "text"
};

let highlighterPromise: Promise<HighlighterCoreInstance> | null = null;

function normalizeLanguage(lang: string | null | undefined): string {
  return String(lang || "")
    .trim()
    .toLowerCase()
    .split(/\s+/)[0] || "text";
}

function resolveLanguage(lang: string | null | undefined): HighlightLanguage {
  const normalized = normalizeLanguage(lang);
  const alias = LANGUAGE_ALIASES[normalized] || normalized;
  if (SUPPORTED_LANGUAGES.has(alias)) return alias;
  return "text";
}

async function getHighlighter(): Promise<HighlighterCoreInstance> {
  if (!highlighterPromise) {
    highlighterPromise = createHighlighterCore({
      engine: createJavaScriptRegexEngine(),
      themes: [themeGithubLight, themeGithubDark],
      langs: PRELOADED_LANGUAGE_MODULES
    });
  }
  return highlighterPromise;
}

export async function highlightCodeToHtml(
  code: string,
  language: string | null | undefined,
  theme: ShikiTheme
): Promise<string> {
  const highlighter = await getHighlighter();
  const resolvedLanguage = resolveLanguage(language);
  return highlighter.codeToHtml(code, {
    lang: resolvedLanguage,
    theme
  });
}

export function normalizeCodeLanguage(language: string | null | undefined): string {
  const resolvedLanguage = resolveLanguage(language);
  return resolvedLanguage === "text" ? "TEXT" : resolvedLanguage.toUpperCase();
}
