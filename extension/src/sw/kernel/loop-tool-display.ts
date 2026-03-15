/**
 * loop-tool-display.ts — 工具展示与 payload 构建
 */
import type { ToolCallItem } from "./loop-shared-types";
import {
  clipText,
  normalizeErrorCode,
  safeJsonParse,
  toRecord,
} from "./loop-shared-utils";
import {
  buildToolRetryHint,
} from "./loop-failure-protocol";

type JsonRecord = Record<string, unknown>;

export function parseToolCallArgs(raw: string): JsonRecord | null {
  const text = String(raw || "").trim();
  if (!text) return null;
  const parsed = safeJsonParse(text);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return null;
  }
  return parsed as JsonRecord;
}

export function stringifyToolCallArgs(args: JsonRecord): string {
  try {
    return JSON.stringify(args);
  } catch {
    return "{}";
  }
}

export function buildFocusEscalationToolCall(
  toolCall: ToolCallItem,
): ToolCallItem | null {
  const normalized = String(toolCall.function.name || "")
    .trim()
    .toLowerCase();
  if (
    ![
      "click",
      "fill_element_by_uid",
      "select_option_by_uid",
      "hover_element_by_uid",
      "press_key",
      "scroll_page",
      "navigate_tab",
      "scroll_to_element",
      "highlight_element",
      "highlight_text_inline",
      "fill_form",
    ].includes(normalized)
  ) {
    return null;
  }
  const args = parseToolCallArgs(toolCall.function.arguments || "");
  if (!args) return null;
  const nextArgs: JsonRecord = {
    ...args,
    forceFocus: true,
  };
  const nestedAction = toRecord(nextArgs.action);
  if (Object.keys(nestedAction).length > 0) {
    nextArgs.action = {
      ...nestedAction,
      forceFocus: true,
    };
  }
  return {
    ...toolCall,
    function: {
      ...toolCall.function,
      arguments: stringifyToolCallArgs(nextArgs),
    },
  };
}

export function summarizeToolTarget(
  toolName: string,
  args: JsonRecord | null,
  rawArgs: string,
): string {
  const normalized = String(toolName || "")
    .trim()
    .toLowerCase();
  const raw = String(rawArgs || "").trim();
  const pick = (key: string) => String(args?.[key] || "").trim();

  if (["host_bash", "browser_bash"].includes(normalized)) {
    const command = pick("command") || raw;
    return command ? `命令：${clipText(command, 220)}` : "";
  }
  if (normalized === "create_new_tab") {
    const url = pick("url");
    return url ? `目标：${clipText(url, 220)}` : "";
  }
  if (normalized === "get_tab_info") {
    const tabId = pick("tabId");
    return tabId
      ? `读取标签页详情 · tabId=${clipText(tabId, 80)}`
      : "读取标签页详情";
  }
  if (normalized === "close_tab") {
    const tabId = pick("tabId");
    return tabId
      ? `关闭标签页 · tabId=${clipText(tabId, 80)}`
      : "关闭当前标签页";
  }
  if (normalized === "ungroup_tabs") {
    return "取消标签页分组";
  }
  if (
    [
      "host_read_file",
      "browser_read_file",
      "host_write_file",
      "browser_write_file",
      "host_edit_file",
      "browser_edit_file",
    ].includes(normalized)
  ) {
    const path = pick("path");
    return path ? `路径：${clipText(path, 220)}` : "";
  }
  if (normalized === "search_elements") {
    const query = pick("query");
    const selector = pick("selector");
    if (query && selector) {
      return `元素检索：${clipText(query, 120)} · 作用域：${clipText(selector, 120)}`;
    }
    if (query) return `元素检索：${clipText(query, 120)}`;
    if (selector) return `元素检索作用域：${clipText(selector, 120)}`;
    return "元素检索";
  }
  if (normalized === "click") {
    const target = pick("uid") || pick("ref") || pick("selector");
    return target ? `点击 · ${clipText(target, 180)}` : "点击";
  }
  if (normalized === "fill_element_by_uid") {
    const target = pick("uid") || pick("ref") || pick("selector");
    return target ? `填写 · ${clipText(target, 180)}` : "填写";
  }
  if (normalized === "select_option_by_uid") {
    const target = pick("uid") || pick("ref") || pick("selector");
    const value = pick("value");
    if (target && value) {
      return `选择选项 · ${clipText(target, 120)} = ${clipText(value, 120)}`;
    }
    return target ? `选择选项 · ${clipText(target, 180)}` : "选择选项";
  }
  if (normalized === "hover_element_by_uid") {
    const target = pick("uid") || pick("ref") || pick("selector");
    return target ? `悬停 · ${clipText(target, 180)}` : "悬停元素";
  }
  if (normalized === "get_editor_value") {
    const target = pick("uid") || pick("ref") || pick("selector");
    return target
      ? `读取编辑器内容 · ${clipText(target, 180)}`
      : "读取编辑器内容";
  }
  if (normalized === "press_key") {
    const key = pick("key") || pick("value");
    return key ? `按键 · ${clipText(key, 120)}` : "按键";
  }
  if (normalized === "scroll_page") {
    const delta = pick("deltaY") || pick("value");
    return delta ? `滚动页面 · ${clipText(delta, 120)}` : "滚动页面";
  }
  if (normalized === "navigate_tab") {
    const url = pick("url");
    return url ? `导航 · ${clipText(url, 220)}` : "导航";
  }
  if (normalized === "fill_form") {
    const elements = Array.isArray(args?.elements) ? args.elements : [];
    return `批量填表：${elements.length} 项`;
  }
  if (normalized === "computer") {
    const action = pick("action");
    return action ? `视觉操作 · ${clipText(action, 120)}` : "视觉操作";
  }
  if (normalized === "get_page_metadata") return "读取页面元信息";
  if (normalized === "scroll_to_element") {
    const target = pick("uid") || pick("ref") || pick("selector");
    return target ? `滚动到元素 · ${clipText(target, 180)}` : "滚动到元素";
  }
  if (normalized === "highlight_element") {
    const target = pick("uid") || pick("ref") || pick("selector");
    return target ? `高亮元素 · ${clipText(target, 180)}` : "高亮元素";
  }
  if (normalized === "highlight_text_inline") {
    const selector = pick("selector");
    const text = pick("searchText");
    if (selector && text) {
      return `高亮文本 · ${clipText(text, 120)} @ ${clipText(selector, 120)}`;
    }
    return "高亮文本";
  }
  if (normalized === "capture_screenshot") return "截图";
  if (normalized === "capture_tab_screenshot") {
    const tabId = pick("tabId");
    return tabId ? `标签页截图 · tabId=${clipText(tabId, 80)}` : "标签页截图";
  }
  if (normalized === "capture_screenshot_with_highlight") {
    const selector = pick("selector");
    return selector ? `高亮截图 · ${clipText(selector, 120)}` : "高亮截图";
  }
  if (normalized === "download_image") {
    const filename = pick("filename");
    return filename ? `下载图片 · ${clipText(filename, 160)}` : "下载图片";
  }
  if (normalized === "download_chat_images") return "批量下载聊天图片";
  if (normalized === "list_interventions") return "读取可用人工干预";
  if (normalized === "get_intervention_info") {
    const type = pick("type");
    return type ? `读取干预详情 · ${clipText(type, 120)}` : "读取干预详情";
  }
  if (normalized === "request_intervention") {
    const type = pick("type");
    return type ? `请求人工干预 · ${clipText(type, 120)}` : "请求人工干预";
  }
  if (normalized === "cancel_intervention") {
    const id = pick("id");
    return id ? `取消干预 · ${clipText(id, 160)}` : "取消干预";
  }
  if (normalized === "create_skill") {
    const name = pick("name") || pick("id");
    return name ? `创建技能 · ${clipText(name, 160)}` : "创建技能";
  }
  if (normalized === "load_skill") {
    const name = pick("name");
    return name ? `加载技能 · ${clipText(name, 160)}` : "加载技能";
  }
  if (normalized === "execute_skill_script") {
    const name = pick("skillName");
    const scriptPath = pick("scriptPath");
    if (name && scriptPath) {
      return `执行技能脚本 · ${clipText(name, 120)}:${clipText(scriptPath, 120)}`;
    }
    return "执行技能脚本";
  }
  if (normalized === "read_skill_reference") {
    const name = pick("skillName");
    const refPath = pick("refPath");
    if (name && refPath) {
      return `读取技能参考 · ${clipText(name, 120)}:${clipText(refPath, 120)}`;
    }
    return "读取技能参考";
  }
  if (normalized === "get_skill_asset") {
    const name = pick("skillName");
    const assetPath = pick("assetPath");
    if (name && assetPath) {
      return `读取技能资产 · ${clipText(name, 120)}:${clipText(assetPath, 120)}`;
    }
    return "读取技能资产";
  }
  if (normalized === "list_skills") return "读取技能列表";
  if (normalized === "get_skill_info") {
    const name = pick("skillName");
    return name ? `读取技能详情 · ${clipText(name, 160)}` : "读取技能详情";
  }
  if (normalized === "browser_verify") return "页面验证";
  if (normalized === "get_all_tabs") return "读取标签页列表";
  if (normalized === "get_current_tab") return "读取当前标签页";
  if (raw) return `参数：${clipText(raw, 220)}`;
  return "";
}

export function buildToolFailurePayload(
  toolCall: ToolCallItem,
  result: JsonRecord,
): JsonRecord {
  const toolName = String(toolCall.function.name || "").trim();
  const rawArgs = String(toolCall.function.arguments || "").trim();
  const args = parseToolCallArgs(rawArgs);
  const target = summarizeToolTarget(toolName, args, rawArgs);
  const errorCode = normalizeErrorCode(result.errorCode);
  return {
    ...result,
    error: String(result.error || "工具执行失败"),
    errorCode: errorCode || undefined,
    retryHint: String(
      result.retryHint || buildToolRetryHint(toolName, errorCode),
    ),
    tool: toolName,
    target,
  };
}

export function buildToolSuccessPayload(
  toolCall: ToolCallItem,
  data: unknown,
  meta: {
    modeUsed?: unknown;
    providerId?: unknown;
    fallbackFrom?: unknown;
  } = {},
): JsonRecord {
  const toolName = String(toolCall.function.name || "").trim();
  const rawArgs = String(toolCall.function.arguments || "").trim();
  const args = parseToolCallArgs(rawArgs);
  const target = summarizeToolTarget(toolName, args, rawArgs);
  const base =
    data && typeof data === "object" && !Array.isArray(data)
      ? ({ ...(data as JsonRecord) } as JsonRecord)
      : { data };
  return {
    ...base,
    tool: toolName,
    target,
    args: args || null,
    modeUsed: String(meta.modeUsed || "") || undefined,
    providerId: String(meta.providerId || "") || undefined,
    fallbackFrom: String(meta.fallbackFrom || "") || undefined,
  };
}
