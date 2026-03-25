import { describe, expect, it } from "vitest";
import {
  appendRunTimelineText,
  cloneRunTimelineItems,
  upsertRunTimelineToolItem,
} from "../run-timeline";

describe("run timeline helpers", () => {
  it("appends texts and tool steps in true insertion order", () => {
    let items = appendRunTimelineText([], "我先看页面。");
    items = upsertRunTimelineToolItem(items, {
      step: 1,
      action: "search_elements",
      detail: "参数：query=input",
      status: "done",
      logs: [],
    });
    items = appendRunTimelineText(items, "我再确认输入框。");
    items = upsertRunTimelineToolItem(items, {
      step: 2,
      action: "capture_screenshot",
      detail: "模式：interactive",
      status: "running",
      logs: [],
    });

    expect(items.map((item) => item.kind)).toEqual(["text", "tool", "text", "tool"]);
    expect(items[0]).toMatchObject({ kind: "text", text: "我先看页面。" });
    expect(items[1]).toMatchObject({ kind: "tool", step: 1, action: "search_elements" });
    expect(items[2]).toMatchObject({ kind: "text", text: "我再确认输入框。" });
    expect(items[3]).toMatchObject({ kind: "tool", step: 2, action: "capture_screenshot" });
  });

  it("updates an existing tool step in place instead of appending duplicates", () => {
    let items = appendRunTimelineText([], "我先看页面。");
    items = upsertRunTimelineToolItem(items, {
      step: 1,
      action: "search_elements",
      detail: "参数：query=input",
      status: "running",
      logs: [],
    });
    items = upsertRunTimelineToolItem(items, {
      step: 1,
      action: "search_elements",
      detail: "参数：query=input",
      status: "done",
      logs: ["找到 3 个结果"],
    });

    expect(items.map((item) => item.kind)).toEqual(["text", "tool"]);
    expect(items[1]).toMatchObject({
      kind: "tool",
      step: 1,
      status: "done",
      logs: ["找到 3 个结果"],
    });
  });

  it("clones nested tool logs when capturing completed timeline", () => {
    const source = upsertRunTimelineToolItem([], {
      step: 2,
      action: "click",
      detail: "目标：发送按钮",
      status: "done",
      logs: ["clicked"],
    });
    const cloned = cloneRunTimelineItems(source);

    expect(cloned).toEqual(source);
    if (cloned[0]?.kind !== "tool" || source[0]?.kind !== "tool") return;
    expect(cloned[0].logs).not.toBe(source[0].logs);
  });
});
