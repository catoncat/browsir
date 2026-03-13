import { parse } from "@babel/parser";

interface PersistableAstNode {
  type: string;
  [key: string]: unknown;
}

interface PersistableAstScope {
  kind: "block" | "function";
  bindings: Set<string>;
}

export type PersistableFunctionSourceMode = "function" | "accessor";

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

function isFunctionLikePersistableAstNode(node: PersistableAstNode): boolean {
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
  return { kind, bindings: new Set<string>() };
}

function addPersistableBindingName(target: Set<string>, value: unknown): void {
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
    for (const property of Array.isArray(node.properties)
      ? node.properties
      : []) {
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
    if (
      isPersistableAstNode(statement.id) &&
      statement.id.type === "Identifier"
    ) {
      addPersistableBindingName(blockScope.bindings, statement.id.name);
    }
    return;
  }
  if (statement.type === "ClassDeclaration") {
    if (
      isPersistableAstNode(statement.id) &&
      statement.id.type === "Identifier"
    ) {
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
    predeclarePersistableStatementBindings(
      statement,
      blockScope,
      functionScope,
    );
  }
  for (const statement of statements) {
    walkPersistableAstNode(
      statement,
      nextScopes,
      freeIdentifiers,
      null,
      null,
    );
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
    walkPersistableAstNode(
      node.body,
      nextScopes,
      freeIdentifiers,
      node,
      "body",
    );
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
      for (const statement of toPersistableAstNodeList(
        caseNode.consequent,
      )) {
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
      for (const statement of toPersistableAstNodeList(
        caseNode.consequent,
      )) {
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
      walkPersistableAstNode(
        node.init,
        scopes,
        freeIdentifiers,
        node,
        "init",
      );
    }
    if (isPersistableAstNode(node.test)) {
      walkPersistableAstNode(
        node.test,
        scopes,
        freeIdentifiers,
        node,
        "test",
      );
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
      walkPersistableAstNode(
        node.body,
        scopes,
        freeIdentifiers,
        node,
        "body",
      );
    }
    return;
  }
  if (node.type === "ForInStatement" || node.type === "ForOfStatement") {
    if (
      isPersistableAstNode(node.left) &&
      node.left.type !== "VariableDeclaration"
    ) {
      walkPersistableAstNode(
        node.left,
        scopes,
        freeIdentifiers,
        node,
        "left",
      );
    }
    if (isPersistableAstNode(node.right)) {
      walkPersistableAstNode(
        node.right,
        scopes,
        freeIdentifiers,
        node,
        "right",
      );
    }
    if (isPersistableAstNode(node.body)) {
      walkPersistableAstNode(
        node.body,
        scopes,
        freeIdentifiers,
        node,
        "body",
      );
    }
    return;
  }
  if (node.type === "CatchClause") {
    const catchScope = createPersistableAstScope("block");
    collectPersistablePatternBindings(node.param, catchScope.bindings);
    const nextScopes = [...scopes, catchScope];
    if (isPersistableAstNode(node.body)) {
      walkPersistableAstNode(
        node.body,
        nextScopes,
        freeIdentifiers,
        node,
        "body",
      );
    }
    return;
  }
  if (node.type === "ObjectExpression") {
    for (const property of Array.isArray(node.properties)
      ? node.properties
      : []) {
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
      walkPersistableAstNode(
        node.key,
        scopes,
        freeIdentifiers,
        node,
        "key",
      );
    }
    if (isPersistableAstNode(node.value)) {
      walkPersistableAstNode(
        node.value,
        scopes,
        freeIdentifiers,
        node,
        "value",
      );
    }
    return;
  }
  if (
    node.type === "MemberExpression" ||
    node.type === "OptionalMemberExpression"
  ) {
    if (isPersistableAstNode(node.object)) {
      walkPersistableAstNode(
        node.object,
        scopes,
        freeIdentifiers,
        node,
        "object",
      );
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
      walkPersistableAstNode(
        node.body,
        nextScopes,
        freeIdentifiers,
        node,
        "body",
      );
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
    return `async function* ${text.replace(/^async\s*\*\s*/, "").trimStart()}`;
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
  if (
    !expressionStatement ||
    expressionStatement.type !== "ExpressionStatement"
  ) {
    throw new Error(`${path} 函数源码无法解析为表达式`);
  }
  const expression = expressionStatement.expression;
  if (mode === "accessor") {
    if (
      !isPersistableAstNode(expression) ||
      expression.type !== "ObjectExpression"
    ) {
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

export function assertPersistableFunctionSourceHasNoFreeIdentifiers(
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
