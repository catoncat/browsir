import { parse } from "@babel/parser";
import type {
  AgentPluginManifest,
  AgentPluginPermissions,
} from "../plugin-runtime";
import {
  buildPluginVirtualSourcePaths,
  invokePluginSandboxRunner,
  PLUGIN_SANDBOX_DEFAULT_SESSION_ID,
  writeVirtualTextFile,
} from "./plugin-sandbox";
import {
  clonePersistableRecord,
  type PersistedPluginRecord,
  upsertPersistedPluginRecord,
} from "./plugin-persistence";
import { nowIso } from "../types";

function toRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object"
    ? (value as Record<string, unknown>)
    : {};
}

function toStringList(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const out: string[] = [];
  const seen = new Set<string>();
  for (const item of value) {
    const text = String(item || "").trim();
    if (!text || seen.has(text)) continue;
    seen.add(text);
    out.push(text);
  }
  return out.length > 0 ? out : [];
}

function toSafeVirtualSegment(input: unknown): string {
  const text = String(input || "")
    .trim()
    .replace(/[^a-zA-Z0-9._-]/g, "_");
  return text || "plugin";
}

function buildPluginScopedVirtualSourcePaths(
  rootBase: string,
  pluginId: string,
): {
  root: string;
  packagePath: string;
  indexPath: string;
  uiPath: string;
} {
  const segment = toSafeVirtualSegment(pluginId);
  const normalizedRootBase = String(rootBase || "mem://plugins").trim().replace(
    /\/+$/g,
    "",
  );
  const root = `${normalizedRootBase}/${segment}`;
  return {
    root,
    packagePath: `${root}/plugin.json`,
    indexPath: `${root}/index.js`,
    uiPath: `${root}/ui.js`,
  };
}

function buildPluginValidationVirtualSourcePaths(pluginId: string): {
  root: string;
  packagePath: string;
  indexPath: string;
  uiPath: string;
} {
  return buildPluginScopedVirtualSourcePaths(
    "mem://__bbl/plugin-validate",
    pluginId,
  );
}

function isSerializableObjectRecord(
  value: unknown,
): value is Record<PropertyKey, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  return Object.prototype.toString.call(value) === "[object Object]";
}

interface PersistableAstNode {
  type: string;
  [key: string]: unknown;
}

interface PersistableAstScope {
  kind: "block" | "function";
  bindings: Set<string>;
}

type PersistableFunctionSourceMode = "function" | "accessor";

const PERSISTABLE_FUNCTION_GLOBAL_IDENTIFIERS = new Set<string>([
  "undefined",
  "Infinity",
  "NaN",
  "globalThis",
  "console",
  "chrome",
  "fetch",
  "Request",
  "Response",
  "Headers",
  "URL",
  "URLSearchParams",
  "AbortController",
  "AbortSignal",
  "TextEncoder",
  "TextDecoder",
  "Blob",
  "File",
  "FormData",
  "ReadableStream",
  "WritableStream",
  "TransformStream",
  "structuredClone",
  "queueMicrotask",
  "setTimeout",
  "clearTimeout",
  "setInterval",
  "clearInterval",
  "atob",
  "btoa",
  "crypto",
  "performance",
  "Object",
  "Array",
  "String",
  "Number",
  "Boolean",
  "BigInt",
  "Symbol",
  "Math",
  "JSON",
  "Date",
  "RegExp",
  "Map",
  "Set",
  "WeakMap",
  "WeakSet",
  "Promise",
  "Reflect",
  "Proxy",
  "ArrayBuffer",
  "SharedArrayBuffer",
  "DataView",
  "Int8Array",
  "Uint8Array",
  "Uint8ClampedArray",
  "Int16Array",
  "Uint16Array",
  "Int32Array",
  "Uint32Array",
  "Float32Array",
  "Float64Array",
  "BigInt64Array",
  "BigUint64Array",
  "parseInt",
  "parseFloat",
  "isNaN",
  "isFinite",
  "encodeURI",
  "decodeURI",
  "encodeURIComponent",
  "decodeURIComponent",
  "Error",
  "EvalError",
  "RangeError",
  "ReferenceError",
  "SyntaxError",
  "TypeError",
  "URIError",
  "AggregateError",
  "Intl",
]);

const WELL_KNOWN_SYMBOL_SOURCES = [
  ["Symbol.asyncIterator", Symbol.asyncIterator],
  ["Symbol.hasInstance", Symbol.hasInstance],
  ["Symbol.isConcatSpreadable", Symbol.isConcatSpreadable],
  ["Symbol.iterator", Symbol.iterator],
  ["Symbol.match", Symbol.match],
  ["Symbol.matchAll", Symbol.matchAll],
  ["Symbol.replace", Symbol.replace],
  ["Symbol.search", Symbol.search],
  ["Symbol.species", Symbol.species],
  ["Symbol.split", Symbol.split],
  ["Symbol.toPrimitive", Symbol.toPrimitive],
  ["Symbol.toStringTag", Symbol.toStringTag],
  ["Symbol.unscopables", Symbol.unscopables],
] as const;

const WELL_KNOWN_SYMBOL_SOURCE_BY_VALUE = new Map<symbol, string>(
  WELL_KNOWN_SYMBOL_SOURCES.map(([source, symbolValue]) => [
    symbolValue,
    source,
  ]),
);

function isPersistableAstNode(value: unknown): value is PersistableAstNode {
  return (
    !!value &&
    typeof value === "object" &&
    typeof (value as Record<string, unknown>).type === "string"
  );
}

function toPersistableAstNodeList(value: unknown): PersistableAstNode[] {
  if (!Array.isArray(value)) return [];
  return value.filter(isPersistableAstNode);
}

function isFunctionLikePersistableAstNode(
  node: PersistableAstNode,
): boolean {
  return (
    node.type === "FunctionExpression" ||
    node.type === "FunctionDeclaration" ||
    node.type === "ArrowFunctionExpression" ||
    node.type === "ObjectMethod" ||
    node.type === "ClassMethod"
  );
}

function createPersistableAstScope(
  kind: PersistableAstScope["kind"],
): PersistableAstScope {
  return {
    kind,
    bindings: new Set<string>(),
  };
}

function addPersistableBindingName(
  target: Set<string>,
  value: unknown,
): void {
  const name = String(value || "").trim();
  if (!name) return;
  target.add(name);
}

function collectPersistablePatternBindings(
  node: unknown,
  target: Set<string>,
): void {
  if (!isPersistableAstNode(node)) return;
  if (node.type === "Identifier") {
    addPersistableBindingName(target, node.name);
    return;
  }
  if (node.type === "AssignmentPattern") {
    collectPersistablePatternBindings(node.left, target);
    return;
  }
  if (node.type === "RestElement") {
    collectPersistablePatternBindings(node.argument, target);
    return;
  }
  if (node.type === "ArrayPattern") {
    for (const item of Array.isArray(node.elements) ? node.elements : []) {
      collectPersistablePatternBindings(item, target);
    }
    return;
  }
  if (node.type === "ObjectPattern") {
    for (const property of Array.isArray(node.properties) ? node.properties : []) {
      if (!isPersistableAstNode(property)) continue;
      if (property.type === "RestElement") {
        collectPersistablePatternBindings(property.argument, target);
        continue;
      }
      if (property.type !== "ObjectProperty") continue;
      collectPersistablePatternBindings(property.value, target);
    }
  }
}

function nearestPersistableFunctionScope(
  scopes: PersistableAstScope[],
): PersistableAstScope | null {
  for (let i = scopes.length - 1; i >= 0; i -= 1) {
    if (scopes[i]?.kind === "function") return scopes[i];
  }
  return scopes.length > 0 ? scopes[scopes.length - 1] : null;
}

function isPersistableBindingKnown(
  name: string,
  scopes: PersistableAstScope[],
): boolean {
  for (let i = scopes.length - 1; i >= 0; i -= 1) {
    if (scopes[i]?.bindings.has(name)) return true;
  }
  return false;
}

function predeclarePersistableStatementBindings(
  statement: PersistableAstNode,
  blockScope: PersistableAstScope,
  functionScope: PersistableAstScope | null,
): void {
  if (statement.type === "FunctionDeclaration") {
    if (isPersistableAstNode(statement.id) && statement.id.type === "Identifier") {
      addPersistableBindingName(blockScope.bindings, statement.id.name);
    }
    return;
  }
  if (statement.type === "ClassDeclaration") {
    if (isPersistableAstNode(statement.id) && statement.id.type === "Identifier") {
      addPersistableBindingName(blockScope.bindings, statement.id.name);
    }
    return;
  }
  if (statement.type === "VariableDeclaration") {
    const targetScope =
      String(statement.kind || "") === "var"
        ? (functionScope ?? blockScope)
        : blockScope;
    for (const declarator of toPersistableAstNodeList(statement.declarations)) {
      collectPersistablePatternBindings(declarator.id, targetScope.bindings);
    }
    return;
  }
  if (statement.type === "ForStatement") {
    if (
      isPersistableAstNode(statement.init) &&
      statement.init.type === "VariableDeclaration"
    ) {
      predeclarePersistableStatementBindings(
        statement.init,
        blockScope,
        functionScope,
      );
    }
    return;
  }
  if (
    statement.type === "ForInStatement" ||
    statement.type === "ForOfStatement"
  ) {
    if (
      isPersistableAstNode(statement.left) &&
      statement.left.type === "VariableDeclaration"
    ) {
      predeclarePersistableStatementBindings(
        statement.left,
        blockScope,
        functionScope,
      );
    }
    return;
  }
  if (statement.type === "ExportNamedDeclaration") {
    if (isPersistableAstNode(statement.declaration)) {
      predeclarePersistableStatementBindings(
        statement.declaration,
        blockScope,
        functionScope,
      );
    }
  }
}

function walkPersistableAstChildren(
  node: PersistableAstNode,
  scopes: PersistableAstScope[],
  freeIdentifiers: Set<string>,
  skipKeys: string[] = [],
): void {
  const skip = new Set<string>([
    "type",
    "start",
    "end",
    "loc",
    "extra",
    "leadingComments",
    "innerComments",
    "trailingComments",
    ...skipKeys,
  ]);
  for (const [key, value] of Object.entries(node)) {
    if (skip.has(key)) continue;
    if (isPersistableAstNode(value)) {
      walkPersistableAstNode(value, scopes, freeIdentifiers, node, key);
      continue;
    }
    if (!Array.isArray(value)) continue;
    for (const item of value) {
      if (!isPersistableAstNode(item)) continue;
      walkPersistableAstNode(item, scopes, freeIdentifiers, node, key);
    }
  }
}

function isPersistableIdentifierReference(
  parent: PersistableAstNode | null,
  parentKey: string | null,
): boolean {
  if (!parent) return true;
  if (
    parent.type === "MemberExpression" ||
    parent.type === "OptionalMemberExpression"
  ) {
    return !(parentKey === "property" && parent.computed !== true);
  }
  if (parent.type === "ObjectProperty") {
    return !(parentKey === "key" && parent.computed !== true);
  }
  if (
    parent.type === "ObjectMethod" ||
    parent.type === "ClassMethod" ||
    parent.type === "ClassProperty" ||
    parent.type === "ClassPrivateProperty"
  ) {
    return !(parentKey === "key" && parent.computed !== true);
  }
  if (
    parent.type === "LabeledStatement" ||
    parent.type === "BreakStatement" ||
    parent.type === "ContinueStatement" ||
    parent.type === "MetaProperty"
  ) {
    return false;
  }
  return true;
}

function walkPersistableBlockStatements(
  statements: PersistableAstNode[],
  scopes: PersistableAstScope[],
  freeIdentifiers: Set<string>,
): void {
  const blockScope = createPersistableAstScope("block");
  const nextScopes = [...scopes, blockScope];
  const functionScope = nearestPersistableFunctionScope(nextScopes);
  for (const statement of statements) {
    predeclarePersistableStatementBindings(statement, blockScope, functionScope);
  }
  for (const statement of statements) {
    walkPersistableAstNode(statement, nextScopes, freeIdentifiers, null, null);
  }
}

function walkPersistableFunctionNode(
  node: PersistableAstNode,
  scopes: PersistableAstScope[],
  freeIdentifiers: Set<string>,
): void {
  const functionScope = createPersistableAstScope("function");
  if (isPersistableAstNode(node.id) && node.id.type === "Identifier") {
    addPersistableBindingName(functionScope.bindings, node.id.name);
  }
  for (const param of Array.isArray(node.params) ? node.params : []) {
    collectPersistablePatternBindings(param, functionScope.bindings);
  }
  if (node.type !== "ArrowFunctionExpression") {
    functionScope.bindings.add("arguments");
  }
  const nextScopes = [...scopes, functionScope];
  if (isPersistableAstNode(node.body) && node.body.type === "BlockStatement") {
    walkPersistableBlockStatements(
      toPersistableAstNodeList(node.body.body),
      nextScopes,
      freeIdentifiers,
    );
    return;
  }
  if (isPersistableAstNode(node.body)) {
    walkPersistableAstNode(node.body, nextScopes, freeIdentifiers, node, "body");
  }
}

function walkPersistableAstNode(
  node: PersistableAstNode,
  scopes: PersistableAstScope[],
  freeIdentifiers: Set<string>,
  parent: PersistableAstNode | null,
  parentKey: string | null,
): void {
  if (node.type === "Identifier") {
    if (!isPersistableIdentifierReference(parent, parentKey)) return;
    const name = String(node.name || "").trim();
    if (!name) return;
    if (PERSISTABLE_FUNCTION_GLOBAL_IDENTIFIERS.has(name)) return;
    if (isPersistableBindingKnown(name, scopes)) return;
    freeIdentifiers.add(name);
    return;
  }

  if (
    node.type === "FunctionDeclaration" ||
    node.type === "FunctionExpression" ||
    node.type === "ArrowFunctionExpression" ||
    node.type === "ObjectMethod" ||
    node.type === "ClassMethod"
  ) {
    walkPersistableFunctionNode(node, scopes, freeIdentifiers);
    return;
  }

  if (node.type === "BlockStatement") {
    walkPersistableBlockStatements(
      toPersistableAstNodeList(node.body),
      scopes,
      freeIdentifiers,
    );
    return;
  }

  if (node.type === "Program") {
    walkPersistableBlockStatements(
      toPersistableAstNodeList(node.body),
      scopes,
      freeIdentifiers,
    );
    return;
  }

  if (node.type === "SwitchStatement") {
    if (isPersistableAstNode(node.discriminant)) {
      walkPersistableAstNode(
        node.discriminant,
        scopes,
        freeIdentifiers,
        node,
        "discriminant",
      );
    }
    const switchScope = createPersistableAstScope("block");
    const nextScopes = [...scopes, switchScope];
    const functionScope = nearestPersistableFunctionScope(nextScopes);
    const cases = toPersistableAstNodeList(node.cases);
    for (const caseNode of cases) {
      for (const statement of toPersistableAstNodeList(caseNode.consequent)) {
        predeclarePersistableStatementBindings(
          statement,
          switchScope,
          functionScope,
        );
      }
    }
    for (const caseNode of cases) {
      if (isPersistableAstNode(caseNode.test)) {
        walkPersistableAstNode(
          caseNode.test,
          nextScopes,
          freeIdentifiers,
          caseNode,
          "test",
        );
      }
      for (const statement of toPersistableAstNodeList(caseNode.consequent)) {
        walkPersistableAstNode(
          statement,
          nextScopes,
          freeIdentifiers,
          caseNode,
          "consequent",
        );
      }
    }
    return;
  }

  if (node.type === "VariableDeclaration") {
    for (const declarator of toPersistableAstNodeList(node.declarations)) {
      if (isPersistableAstNode(declarator.init)) {
        walkPersistableAstNode(
          declarator.init,
          scopes,
          freeIdentifiers,
          declarator,
          "init",
        );
      }
    }
    return;
  }

  if (node.type === "ForStatement") {
    if (isPersistableAstNode(node.init)) {
      walkPersistableAstNode(node.init, scopes, freeIdentifiers, node, "init");
    }
    if (isPersistableAstNode(node.test)) {
      walkPersistableAstNode(node.test, scopes, freeIdentifiers, node, "test");
    }
    if (isPersistableAstNode(node.update)) {
      walkPersistableAstNode(
        node.update,
        scopes,
        freeIdentifiers,
        node,
        "update",
      );
    }
    if (isPersistableAstNode(node.body)) {
      walkPersistableAstNode(node.body, scopes, freeIdentifiers, node, "body");
    }
    return;
  }

  if (node.type === "ForInStatement" || node.type === "ForOfStatement") {
    if (
      isPersistableAstNode(node.left) &&
      node.left.type !== "VariableDeclaration"
    ) {
      walkPersistableAstNode(node.left, scopes, freeIdentifiers, node, "left");
    }
    if (isPersistableAstNode(node.right)) {
      walkPersistableAstNode(node.right, scopes, freeIdentifiers, node, "right");
    }
    if (isPersistableAstNode(node.body)) {
      walkPersistableAstNode(node.body, scopes, freeIdentifiers, node, "body");
    }
    return;
  }

  if (node.type === "CatchClause") {
    const catchScope = createPersistableAstScope("block");
    collectPersistablePatternBindings(node.param, catchScope.bindings);
    const nextScopes = [...scopes, catchScope];
    if (isPersistableAstNode(node.body)) {
      walkPersistableAstNode(node.body, nextScopes, freeIdentifiers, node, "body");
    }
    return;
  }

  if (node.type === "ObjectExpression") {
    for (const property of Array.isArray(node.properties) ? node.properties : []) {
      if (!isPersistableAstNode(property)) continue;
      walkPersistableAstNode(
        property,
        scopes,
        freeIdentifiers,
        node,
        "properties",
      );
    }
    return;
  }

  if (node.type === "ObjectProperty") {
    if (node.computed === true && isPersistableAstNode(node.key)) {
      walkPersistableAstNode(node.key, scopes, freeIdentifiers, node, "key");
    }
    if (isPersistableAstNode(node.value)) {
      walkPersistableAstNode(node.value, scopes, freeIdentifiers, node, "value");
    }
    return;
  }

  if (
    node.type === "MemberExpression" ||
    node.type === "OptionalMemberExpression"
  ) {
    if (isPersistableAstNode(node.object)) {
      walkPersistableAstNode(node.object, scopes, freeIdentifiers, node, "object");
    }
    if (node.computed === true && isPersistableAstNode(node.property)) {
      walkPersistableAstNode(
        node.property,
        scopes,
        freeIdentifiers,
        node,
        "property",
      );
    }
    return;
  }

  if (node.type === "ClassDeclaration" || node.type === "ClassExpression") {
    const classScope = createPersistableAstScope("block");
    if (isPersistableAstNode(node.id) && node.id.type === "Identifier") {
      addPersistableBindingName(classScope.bindings, node.id.name);
    }
    const nextScopes = [...scopes, classScope];
    if (isPersistableAstNode(node.superClass)) {
      walkPersistableAstNode(
        node.superClass,
        nextScopes,
        freeIdentifiers,
        node,
        "superClass",
      );
    }
    if (isPersistableAstNode(node.body)) {
      walkPersistableAstNode(node.body, nextScopes, freeIdentifiers, node, "body");
    }
    return;
  }

  if (node.type === "ClassBody") {
    for (const item of toPersistableAstNodeList(node.body)) {
      walkPersistableAstNode(item, scopes, freeIdentifiers, node, "body");
    }
    return;
  }

  if (node.type === "MetaProperty" || node.type === "PrivateName") {
    return;
  }

  walkPersistableAstChildren(node, scopes, freeIdentifiers);
}

function normalizeFunctionSourceForAnalysis(source: string): string {
  const text = String(source || "").trim();
  if (
    !text ||
    /^(async\s+)?function\b/.test(text) ||
    /^class\b/.test(text) ||
    text.includes("=>")
  ) {
    return text;
  }
  if (/^async\s*\*\s*[A-Za-z_$][\w$]*\s*\(/.test(text)) {
    return `async function* ${text
      .replace(/^async\s*\*\s*/, "")
      .trimStart()}`;
  }
  if (/^\*\s*[A-Za-z_$][\w$]*\s*\(/.test(text)) {
    return `function* ${text.replace(/^\*\s*/, "").trimStart()}`;
  }
  if (/^async\s+[A-Za-z_$][\w$]*\s*\(/.test(text)) {
    return `async function ${text.slice("async ".length)}`;
  }
  if (/^[A-Za-z_$][\w$]*\s*\(/.test(text)) {
    return `function ${text}`;
  }
  return text;
}

function parsePersistableFunctionSource(
  source: string,
  path: string,
  mode: PersistableFunctionSourceMode,
): PersistableAstNode {
  const normalizedSource =
    mode === "accessor" ? source : normalizeFunctionSourceForAnalysis(source);
  const wrappedSource =
    mode === "accessor"
      ? `({ ${normalizedSource} })`
      : `(${normalizedSource})`;
  let program: PersistableAstNode;
  try {
    program = parse(wrappedSource, {
      sourceType: "script",
      plugins: [
        "asyncGenerators",
        "bigInt",
        "classProperties",
        "classPrivateProperties",
        "classPrivateMethods",
        "classStaticBlock",
        "importMeta",
        "nullishCoalescingOperator",
        "objectRestSpread",
        "optionalCatchBinding",
        "optionalChaining",
      ],
    }).program as unknown as PersistableAstNode;
  } catch (error) {
    throw new Error(
      `${path} 函数源码解析失败: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
  const expressionStatement = toPersistableAstNodeList(program.body)[0];
  if (!expressionStatement || expressionStatement.type !== "ExpressionStatement") {
    throw new Error(`${path} 函数源码无法解析为表达式`);
  }
  const expression = expressionStatement.expression;
  if (mode === "accessor") {
    if (!isPersistableAstNode(expression) || expression.type !== "ObjectExpression") {
      throw new Error(`${path} accessor 源码无法解析`);
    }
    const property = toPersistableAstNodeList(expression.properties)[0];
    if (!property || property.type !== "ObjectMethod") {
      throw new Error(`${path} accessor 源码无法解析为方法`);
    }
    return property;
  }
  if (
    !isPersistableAstNode(expression) ||
    !isFunctionLikePersistableAstNode(expression)
  ) {
    throw new Error(`${path} 函数源码无法解析为函数`);
  }
  return expression;
}

function assertPersistableFunctionSourceHasNoFreeIdentifiers(
  source: string,
  path: string,
  mode: PersistableFunctionSourceMode,
): void {
  const functionNode = parsePersistableFunctionSource(source, path, mode);
  const freeIdentifiers = new Set<string>();
  walkPersistableFunctionNode(functionNode, [], freeIdentifiers);
  if (freeIdentifiers.size <= 0) return;
  throw new Error(
    `${path} 引用了无法持久化的外部变量: ${[...freeIdentifiers]
      .sort((a, b) => a.localeCompare(b))
      .join(", ")}`,
  );
}

function describePluginModuleValue(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  if (value instanceof Map) return "Map";
  if (value instanceof Set) return "Set";
  if (value instanceof URL) return "URL";
  if (value instanceof ArrayBuffer) return "ArrayBuffer";
  if (ArrayBuffer.isView(value)) {
    return value.constructor?.name || "TypedArray";
  }
  if (value instanceof Date) return "Date";
  if (value instanceof RegExp) return "RegExp";
  if (typeof value === "function") return "function";
  if (typeof value === "object") {
    return value?.constructor?.name || "object";
  }
  return typeof value;
}

function normalizeFunctionModuleSource(
  value: (...args: any[]) => unknown,
  path: string,
): string {
  const source = Function.prototype.toString.call(value).trim();
  if (!source) {
    throw new Error(`${path} 函数源码为空`);
  }
  assertPersistableFunctionSourceHasNoFreeIdentifiers(source, path, "function");
  if (/^(async\s+)?function\b/.test(source)) {
    return `(${source})`;
  }
  if (/^(get|set)\s+[A-Za-z_$][\w$]*\s*\(/.test(source)) {
    throw new Error(`${path} 暂不支持 getter/setter 序列化`);
  }
  if (source.includes("=>")) {
    return `(${source})`;
  }
  if (/^(async\s+)?function\b/.test(source) || /^class\b/.test(source)) {
    return `(${source})`;
  }
  if (/^async\s+[A-Za-z_$][\w$]*\s*\(/.test(source)) {
    return `(async function ${source.slice("async ".length)})`;
  }
  if (/^[A-Za-z_$][\w$]*\s*\(/.test(source)) {
    return `(function ${source})`;
  }
  return `(${source})`;
}

function serializeAccessorFunctionToModuleSource(
  value: (...args: any[]) => unknown,
  kind: "get" | "set",
  path: string,
): string {
  const source = Function.prototype.toString.call(value).trim();
  if (!source) {
    throw new Error(`${path} ${kind}ter 源码为空`);
  }
  assertPersistableFunctionSourceHasNoFreeIdentifiers(source, path, "accessor");
  if (source.startsWith(`${kind} `)) {
    return `(() => {
  const accessorHolder = { ${source} };
  return Object.getOwnPropertyDescriptor(
    accessorHolder,
    Object.keys(accessorHolder)[0],
  )?.${kind};
})()`;
  }
  return normalizeFunctionModuleSource(value, path);
}

function describeSerializablePropertyKey(key: PropertyKey): string {
  if (typeof key === "symbol") {
    const wellKnown = WELL_KNOWN_SYMBOL_SOURCE_BY_VALUE.get(key);
    if (wellKnown) return wellKnown;
    const globalKey = Symbol.keyFor(key);
    if (globalKey) return `Symbol.for(${JSON.stringify(globalKey)})`;
    return `Symbol(${JSON.stringify(key.description || "")})`;
  }
  return JSON.stringify(String(key));
}

function serializeSymbolToModuleSource(value: symbol, path: string): string {
  const wellKnown = WELL_KNOWN_SYMBOL_SOURCE_BY_VALUE.get(value);
  if (wellKnown) return wellKnown;
  const globalKey = Symbol.keyFor(value);
  if (globalKey) return `Symbol.for(${JSON.stringify(globalKey)})`;
  throw new Error(
    `${path} 含不支持的 Symbol 值: ${describeSerializablePropertyKey(value)}。仅支持 Symbol.for() 或 well-known symbol`,
  );
}

function serializePropertyKeyToModuleSource(
  key: PropertyKey,
  path: string,
): string {
  if (typeof key === "symbol") {
    return serializeSymbolToModuleSource(key, path);
  }
  return JSON.stringify(String(key));
}

function serializePropertyDescriptorToModuleSource(
  descriptor: PropertyDescriptor,
  path: string,
  seen: WeakSet<object>,
): string {
  const parts = [
    `enumerable: ${descriptor.enumerable === true ? "true" : "false"}`,
    `configurable: ${descriptor.configurable === true ? "true" : "false"}`,
  ];
  if ("value" in descriptor || descriptor.writable !== undefined) {
    parts.push(`writable: ${descriptor.writable === true ? "true" : "false"}`);
    parts.push(
      `value: ${serializeValueToModuleSource(descriptor.value, path, seen)}`,
    );
    return `{ ${parts.join(", ")} }`;
  }
  if (typeof descriptor.get === "function") {
    parts.push(
      `get: ${serializeAccessorFunctionToModuleSource(
        descriptor.get,
        "get",
        `${path}.get`,
      )}`,
    );
  }
  if (typeof descriptor.set === "function") {
    parts.push(
      `set: ${serializeAccessorFunctionToModuleSource(
        descriptor.set,
        "set",
        `${path}.set`,
      )}`,
    );
  }
  return `{ ${parts.join(", ")} }`;
}

function serializeObjectPrototypeToModuleSource(
  value: unknown,
  path: string,
  seen: WeakSet<object>,
): string {
  if (value === null) return "null";
  if (value === Object.prototype) return "Object.prototype";
  if (value === Function.prototype) return "Function.prototype";
  if (value === Array.prototype) return "Array.prototype";
  if (value === Map.prototype) return "Map.prototype";
  if (value === Set.prototype) return "Set.prototype";
  if (value === Date.prototype) return "Date.prototype";
  if (value === RegExp.prototype) return "RegExp.prototype";
  if (value === URL.prototype) return "URL.prototype";
  if (!isSerializableObjectRecord(value)) {
    throw new Error(
      `${path} 含不支持的原型类型: ${describePluginModuleValue(value)}`,
    );
  }
  return serializeObjectRecordToModuleSource(value, path, seen, {
    omitConstructorProperty: true,
  });
}

function serializeObjectRecordToModuleSource(
  value: Record<PropertyKey, unknown>,
  path: string,
  seen: WeakSet<object>,
  options: {
    omitConstructorProperty?: boolean;
  } = {},
): string {
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const ownKeys = Reflect.ownKeys(descriptors);
  const prototypeSource = serializeObjectPrototypeToModuleSource(
    Object.getPrototypeOf(value),
    `${path}.__proto__`,
    seen,
  );
  const lines = [
    "(() => {",
    `  const obj = Object.create(${prototypeSource});`,
  ];
  for (const key of ownKeys) {
    if (options.omitConstructorProperty === true && key === "constructor") {
      continue;
    }
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor) continue;
    const keyLabel = describeSerializablePropertyKey(key);
    lines.push(
      `  Object.defineProperty(obj, ${serializePropertyKeyToModuleSource(
        key,
        `${path}.${keyLabel}`,
      )}, ${serializePropertyDescriptorToModuleSource(
        descriptor,
        `${path}.${keyLabel}`,
        seen,
      )});`,
    );
  }
  lines.push("  return obj;", "})()");
  return lines.join("\n");
}

function serializeValueToModuleSource(
  value: unknown,
  path: string,
  seen = new WeakSet<object>(),
): string {
  if (value === null) return "null";
  if (value === undefined) return "undefined";
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number") {
    if (Number.isNaN(value)) return "Number.NaN";
    if (value === Number.POSITIVE_INFINITY) return "Number.POSITIVE_INFINITY";
    if (value === Number.NEGATIVE_INFINITY) return "Number.NEGATIVE_INFINITY";
    return String(value);
  }
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "bigint") return `${value}n`;
  if (typeof value === "symbol") {
    return serializeSymbolToModuleSource(value, path);
  }
  if (typeof value === "function") {
    return normalizeFunctionModuleSource(
      value as (...args: any[]) => unknown,
      path,
    );
  }
  if (Array.isArray(value)) {
    return `[${value
      .map((item, index) =>
        serializeValueToModuleSource(item, `${path}[${index}]`, seen),
      )
      .join(", ")}]`;
  }
  if (value instanceof Map) {
    return `new Map([${[...value.entries()]
      .map(
        ([entryKey, entryValue], index) =>
          `[${serializeValueToModuleSource(
            entryKey,
            `${path}.keys()[${index}]`,
            seen,
          )}, ${serializeValueToModuleSource(
            entryValue,
            `${path}.values()[${index}]`,
            seen,
          )}]`,
      )
      .join(", ")}])`;
  }
  if (value instanceof Set) {
    return `new Set([${[...value.values()]
      .map((entryValue, index) =>
        serializeValueToModuleSource(
          entryValue,
          `${path}.values()[${index}]`,
          seen,
        ),
      )
      .join(", ")}])`;
  }
  if (value instanceof URL) {
    return `new URL(${JSON.stringify(value.toString())})`;
  }
  if (value instanceof ArrayBuffer) {
    return `Uint8Array.from(${serializeValueToModuleSource(
      [...new Uint8Array(value)],
      `${path}.bytes`,
      seen,
    )}).buffer`;
  }
  if (ArrayBuffer.isView(value)) {
    if (value instanceof DataView) {
      return `new DataView(Uint8Array.from(${serializeValueToModuleSource(
        [
          ...new Uint8Array(
            value.buffer.slice(
              value.byteOffset,
              value.byteOffset + value.byteLength,
            ),
          ),
        ],
        `${path}.bytes`,
        seen,
      )}).buffer)`;
    }
    const ctorName = value.constructor?.name || "";
    if (!ctorName) {
      throw new Error(`${path} 含不支持的 TypedArray 构造器`);
    }
    return `new ${ctorName}(${serializeValueToModuleSource(
      Array.from(value as unknown as ArrayLike<unknown>),
      `${path}.items`,
      seen,
    )})`;
  }
  if (value instanceof Date) {
    return `new Date(${JSON.stringify(value.toISOString())})`;
  }
  if (value instanceof RegExp) {
    return value.toString();
  }
  if (!isSerializableObjectRecord(value)) {
    throw new Error(
      `${path} 含不支持的值类型: ${describePluginModuleValue(value)}`,
    );
  }
  if (seen.has(value)) {
    throw new Error(`${path} 存在循环引用，无法持久化`);
  }
  seen.add(value);
  try {
    return serializeObjectRecordToModuleSource(value, path, seen);
  } finally {
    seen.delete(value);
  }
}

async function validateMaterializedPluginModule(input: {
  modulePath: string;
  exportName: string;
  sessionId: string;
}): Promise<void> {
  await invokePluginSandboxRunner({
    sessionId: input.sessionId,
    modulePath: input.modulePath,
    exportName: input.exportName,
    op: "describe",
  });
}

export async function materializeExtensionFactoryPluginSource(
  source: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const manifest = normalizePluginManifest(source.manifest);
  const setup = source.setup;
  if (typeof setup !== "function") {
    throw new Error("plugin.setup 必须是函数");
  }
  const paths = buildPluginVirtualSourcePaths(manifest.id);
  const moduleSessionId =
    String(
      source.moduleSessionId ||
        source.sessionId ||
        PLUGIN_SANDBOX_DEFAULT_SESSION_ID,
    ).trim() || PLUGIN_SANDBOX_DEFAULT_SESSION_ID;
  const moduleSource = `module.exports = ${serializeValueToModuleSource(
    setup,
    "setup",
  )};`;
  await writeVirtualTextFile(paths.indexPath, moduleSource, moduleSessionId);
  const next: Record<string, unknown> = {
    manifest,
    modulePath: paths.indexPath,
    exportName: "default",
    moduleSessionId,
  };
  const copyFields = [
    "uiModuleUrl",
    "uiModulePath",
    "uiModule",
    "uiExportName",
    "uiModuleSessionId",
    "sessionId",
  ] as const;
  for (const key of copyFields) {
    if (!Object.prototype.hasOwnProperty.call(source, key)) continue;
    const value = source[key];
    if (value === undefined) continue;
    next[key] = value;
  }
  await writeVirtualTextFile(
    paths.packagePath,
    JSON.stringify(next, null, 2),
    moduleSessionId,
  );
  await validateMaterializedPluginModule({
    modulePath: paths.indexPath,
    exportName: "default",
    sessionId: moduleSessionId,
  });
  return next;
}

export async function materializeInlinePluginSources(
  source: Record<string, unknown>,
  sessionId: string,
  options: { transient?: boolean } = {},
): Promise<Record<string, unknown>> {
  const manifest = toRecord(source.manifest);
  const pluginId = String(manifest.id || "").trim();
  if (!pluginId) return source;

  const indexJs = String(source.indexJs || "").trim();
  const uiJs = String(source.uiJs || "").trim();
  if (!indexJs && !uiJs) return source;

  const paths = options.transient
    ? buildPluginValidationVirtualSourcePaths(pluginId)
    : buildPluginVirtualSourcePaths(pluginId);
  const next: Record<string, unknown> = {
    ...source,
  };
  const existingModulePath = String(
    source.modulePath || source.moduleUrl || source.module || "",
  ).trim();

  if (indexJs) {
    const modulePath = existingModulePath || paths.indexPath;
    await writeVirtualTextFile(modulePath, indexJs, sessionId);
    next.modulePath = modulePath;
    next.moduleSessionId = sessionId;
  }

  if (uiJs) {
    const uiModulePath =
      String(
        source.uiModulePath || source.uiModuleUrl || source.uiModule || "",
      ).trim() || paths.uiPath;
    await writeVirtualTextFile(uiModulePath, uiJs, sessionId);
    next.uiModulePath = uiModulePath;
    next.uiModuleSessionId = sessionId;
  }

  await writeVirtualTextFile(
    paths.packagePath,
    JSON.stringify(next, null, 2),
    sessionId,
  );
  return next;
}

function normalizePluginPermissions(input: unknown): AgentPluginPermissions {
  const row = toRecord(input);
  const hooks = toStringList(row.hooks);
  const modesRaw = toStringList(row.modes);
  const capabilities = toStringList(row.capabilities);
  const tools = toStringList(row.tools);
  const llmProviders = toStringList(row.llmProviders);
  const runtimeMessages = toStringList(row.runtimeMessages);
  const brainEvents = toStringList(row.brainEvents);
  const modes =
    Array.isArray(modesRaw) && modesRaw.length > 0
      ? (modesRaw.filter(
          (item) => item === "script" || item === "cdp" || item === "bridge",
        ) as Array<"script" | "cdp" | "bridge">)
      : undefined;
  return {
    ...(hooks ? { hooks } : {}),
    ...(modes ? { modes } : {}),
    ...(capabilities ? { capabilities } : {}),
    ...(tools ? { tools } : {}),
    ...(llmProviders ? { llmProviders } : {}),
    ...(runtimeMessages ? { runtimeMessages } : {}),
    ...(brainEvents ? { brainEvents } : {}),
    ...(row.replaceProviders === true ? { replaceProviders: true } : {}),
    ...(row.replaceToolContracts === true
      ? { replaceToolContracts: true }
      : {}),
    ...(row.replaceLlmProviders === true ? { replaceLlmProviders: true } : {}),
  };
}

export function normalizePluginManifest(input: unknown): AgentPluginManifest {
  const row = toRecord(input);
  const id = String(row.id || "").trim();
  if (!id) throw new Error("plugin.manifest.id 不能为空");
  const name = String(row.name || "").trim() || id;
  const version = String(row.version || "").trim() || "0.0.0";
  const timeoutRaw = Number(row.timeoutMs);
  const timeoutMs = Number.isFinite(timeoutRaw)
    ? Math.max(50, Math.min(10_000, Math.floor(timeoutRaw)))
    : undefined;
  const permissions = normalizePluginPermissions(row.permissions);
  return {
    id,
    name,
    version,
    ...(timeoutMs ? { timeoutMs } : {}),
    ...(Object.keys(permissions).length > 0 ? { permissions } : {}),
  };
}

function buildPersistedExtensionSource(
  input: Record<string, unknown>,
): Record<string, unknown> | null {
  const source: Record<string, unknown> = {};
  const manifest = clonePersistableRecord(toRecord(input.manifest));
  if (!manifest || Object.keys(manifest).length === 0) {
    return null;
  }
  source.manifest = manifest;
  const copyFields = [
    "moduleUrl",
    "modulePath",
    "module",
    "exportName",
    "moduleSessionId",
    "sessionId",
    "uiModuleUrl",
    "uiModulePath",
    "uiModule",
    "uiExportName",
    "uiModuleSessionId",
  ] as const;
  for (const key of copyFields) {
    if (!Object.prototype.hasOwnProperty.call(input, key)) continue;
    const value = input[key];
    if (value === undefined) continue;
    source[key] = value;
  }
  return source;
}

export async function persistExtensionPluginRegistration(
  source: Record<string, unknown>,
  enabled: boolean,
): Promise<PersistedPluginRecord | null> {
  const persistable = buildPersistedExtensionSource(source);
  const manifest = toRecord(persistable?.manifest);
  const pluginId = String(manifest.id || "").trim();
  if (!persistable || !pluginId) return null;
  return upsertPersistedPluginRecord({
    pluginId,
    kind: "extension",
    enabled,
    createdAt: nowIso(),
    updatedAt: nowIso(),
    source: persistable,
  });
}

export function hasPluginExtensionEntry(
  source: Record<string, unknown>,
): boolean {
  return (
    typeof source.setup === "function" ||
    String(source.moduleUrl || "").trim().length > 0 ||
    String(source.modulePath || "").trim().length > 0 ||
    String(source.module || "").trim().length > 0
  );
}
