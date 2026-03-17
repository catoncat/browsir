// @vitest-environment happy-dom
import "./test-setup";

import { describe, expect, it } from "vitest";
import {
  collectDomSnapshot,
  type SerializedDomSnapshot,
  type DomSnapshotNode,
} from "../../../content/dom-snapshot-collector";

/** Get all nodes from the flat map (typed). */
function allNodes(snap: SerializedDomSnapshot): DomSnapshotNode[] {
  return Object.values(snap.idToNode) as DomSnapshotNode[];
}

/** Tiny helper: parse the happy-dom document created by the test runner. */
function makeDoc(html: string): Document {
  const doc = new DOMParser().parseFromString(
    `<html><body>${html}</body></html>`,
    "text/html",
  );
  return doc;
}

describe("dom-snapshot-collector", () => {
  describe("collectDomSnapshot", () => {
    it("returns a valid root node with metadata", () => {
      const doc = makeDoc('<button id="b1">Click me</button>');
      const snap = collectDomSnapshot(doc);
      expect(snap.root.role).toBe("RootWebArea");
      expect(snap.totalNodes).toBeGreaterThanOrEqual(1);
      expect(snap.metadata.collectedAt).toBeTruthy();
      expect(snap.timestamp).toBeGreaterThan(0);
    });

    it("assigns data-brain-uid to elements", () => {
      const doc = makeDoc('<input type="text" placeholder="name">');
      collectDomSnapshot(doc);
      const input = doc.querySelector("input")!;
      expect(input.getAttribute("data-brain-uid")).toBeTruthy();
    });

    it("preserves existing data-brain-uid", () => {
      const doc = makeDoc('<button data-brain-uid="existing_42">Go</button>');
      const snap = collectDomSnapshot(doc);
      const btn = doc.querySelector("button")!;
      expect(btn.getAttribute("data-brain-uid")).toBe("existing_42");
      // The uid should appear in the flat map
      expect(snap.idToNode["existing_42"]).toBeDefined();
      expect(snap.idToNode["existing_42"].role).toBe("button");
    });

    it("captures interactive elements", () => {
      const doc = makeDoc(`
        <a href="https://example.com">Link</a>
        <button>Btn</button>
        <input type="checkbox">
        <select><option>Opt1</option></select>
      `);
      const snap = collectDomSnapshot(doc);
      const roles = allNodes(snap).map((n) => n.role);
      expect(roles).toContain("link");
      expect(roles).toContain("button");
      expect(roles).toContain("checkbox");
      expect(roles).toContain("combobox");
    });

    it("resolves input type to role correctly", () => {
      const doc = makeDoc(`
        <input type="text" placeholder="Text">
        <input type="email" placeholder="Email">
        <input type="search" placeholder="Search">
        <input type="number" placeholder="Num">
        <input type="range" min="0" max="10">
        <input type="radio" name="r">
      `);
      const snap = collectDomSnapshot(doc);
      const roles = allNodes(snap).map((n) => n.role);
      expect(roles).toContain("textbox");
      expect(roles).toContain("searchbox");
      expect(roles).toContain("spinbutton");
      expect(roles).toContain("slider");
      expect(roles).toContain("radio");
    });

    it("skips script/style/noscript tags", () => {
      const doc = makeDoc(`
        <script>alert("hi")</script>
        <style>.foo{}</style>
        <noscript>no js</noscript>
        <button>OK</button>
      `);
      const snap = collectDomSnapshot(doc);
      const tags = allNodes(snap).map((n) => n.tagName).filter(Boolean);
      expect(tags).not.toContain("script");
      expect(tags).not.toContain("style");
      expect(tags).not.toContain("noscript");
      expect(tags).toContain("button");
    });

    it("captures aria-label as name", () => {
      const doc = makeDoc('<div role="button" aria-label="Close dialog">X</div>');
      const snap = collectDomSnapshot(doc);
      const btn = allNodes(snap).find((n) => n.role === "button");
      expect(btn?.name).toBe("Close dialog");
    });

    it("captures input value", () => {
      const doc = makeDoc('<input type="text" value="hello">');
      const snap = collectDomSnapshot(doc);
      const input = allNodes(snap).find((n) => n.role === "textbox");
      expect(input?.value).toBe("hello");
    });

    it("captures checkbox checked state", () => {
      const doc = makeDoc('<input type="checkbox" checked>');
      const snap = collectDomSnapshot(doc);
      const chk = allNodes(snap).find((n) => n.role === "checkbox");
      expect(chk?.checked).toBe(true);
    });

    it("captures anchor href", () => {
      const doc = makeDoc('<a href="https://example.com">Link</a>');
      const snap = collectDomSnapshot(doc);
      const link = allNodes(snap).find((n) => n.role === "link");
      expect(link?.href).toContain("example.com");
    });

    it("captures disabled state from aria-disabled", () => {
      const doc = makeDoc('<button aria-disabled="true">Disabled</button>');
      const snap = collectDomSnapshot(doc);
      const btn = allNodes(snap).find((n) => n.role === "button");
      expect(btn?.disabled).toBe(true);
    });

    it("captures expanded state", () => {
      const doc = makeDoc('<div role="button" aria-expanded="true">Menu</div>');
      const snap = collectDomSnapshot(doc);
      const btn = allNodes(snap).find((n) => n.role === "button");
      expect(btn?.expanded).toBe(true);
    });

    it("captures text nodes when captureTextNodes is true", () => {
      const doc = makeDoc("<p>Hello world</p>");
      const snap = collectDomSnapshot(doc, { captureTextNodes: true });
      const textNodes = allNodes(snap).filter(
        (n) => n.role === "StaticText",
      );
      expect(textNodes.length).toBeGreaterThanOrEqual(1);
      expect(textNodes.some((n) => n.name?.includes("Hello world"))).toBe(true);
    });

    it("builds flat map that includes all nodes", () => {
      const doc = makeDoc(`
        <button>A</button>
        <input type="text">
        <a href="#">B</a>
      `);
      const snap = collectDomSnapshot(doc);
      const mapSize = Object.keys(snap.idToNode).length;
      expect(mapSize).toBe(snap.totalNodes);
    });

    it("handles empty document gracefully", () => {
      const doc = makeDoc("");
      const snap = collectDomSnapshot(doc);
      expect(snap.root.role).toBe("RootWebArea");
      expect(snap.totalNodes).toBeGreaterThanOrEqual(1); // at least the root
    });

    it("traverses open Shadow DOM and captures elements inside", () => {
      const doc = makeDoc('<div id="host"></div>');
      const host = doc.getElementById("host")!;
      const shadow = host.attachShadow({ mode: "open" });
      shadow.innerHTML = '<button data-brain-uid="shadow_btn_1">Shadow Click</button>';
      const snap = collectDomSnapshot(doc);
      const btn = allNodes(snap).find((n) => n.id === "shadow_btn_1");
      expect(btn).toBeDefined();
      expect(btn?.role).toBe("button");
      expect(btn?.name).toBe("Shadow Click");
    });

    it("traverses nested Shadow DOMs recursively", () => {
      const doc = makeDoc('<div id="outer-host"></div>');
      const outerHost = doc.getElementById("outer-host")!;
      const outerShadow = outerHost.attachShadow({ mode: "open" });
      outerShadow.innerHTML = '<div id="inner-host"></div>';
      const innerHost = outerShadow.getElementById("inner-host")!;
      const innerShadow = innerHost.attachShadow({ mode: "open" });
      innerShadow.innerHTML =
        '<input type="text" data-brain-uid="nested_input" placeholder="deep">';
      const snap = collectDomSnapshot(doc);
      const input = allNodes(snap).find((n) => n.id === "nested_input");
      expect(input).toBeDefined();
      expect(input?.role).toBe("textbox");
      expect(input?.placeholder).toBe("deep");
    });

    it("extracts text from inside Shadow DOM for accessible names", () => {
      const doc = makeDoc('<div id="host2"></div>');
      const host = doc.getElementById("host2")!;
      const shadow = host.attachShadow({ mode: "open" });
      shadow.innerHTML = '<a href="https://example.com" data-brain-uid="shadow_link">Shadow Link</a>';
      const snap = collectDomSnapshot(doc);
      const link = allNodes(snap).find((n) => n.id === "shadow_link");
      expect(link).toBeDefined();
      expect(link?.role).toBe("link");
      expect(link?.name).toBe("Shadow Link");
    });
  });
});
