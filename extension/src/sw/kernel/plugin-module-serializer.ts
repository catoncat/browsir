import {
  assertPersistableFunctionSourceHasNoFreeIdentifiers,
} from "./persistable-ast-analyzer";

export function isSerializableObjectRecord(
  value: unknown,
): value is Record<PropertyKey, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  return Object.prototype.toString.call(value) === "[object Object]";
}

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

export function describePluginModuleValue(value: unknown): string {
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
  options: { omitConstructorProperty?: boolean } = {},
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

export function serializeValueToModuleSource(
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
