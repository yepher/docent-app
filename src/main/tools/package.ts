import { createHash } from "node:crypto";
import type {
  InputSchema,
  Json,
  ToolCatalog,
  ToolPackage,
} from "../../shared/tools";

export const MAX_PACKAGE_BYTES = 512 * 1024;
const ID = /^[a-z][a-z0-9-]{1,63}$/;
const VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const bad = (message: string): never => {
  throw new Error(message);
};
function object(value: unknown): asserts value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    bad("Expected an object.");
}
function text(
  value: unknown,
  name: string,
  limit: number,
): asserts value is string {
  if (typeof value !== "string" || !value.trim() || value.length > limit)
    bad(`Invalid ${name} (maximum ${limit} characters).`);
}
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object")
    return `{${Object.keys(value)
      .sort()
      .map(
        (key) =>
          `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`,
      )
      .join(",")}}`;
  return JSON.stringify(value);
}
export const packageHash = (pkg: ToolPackage) =>
  createHash("sha256").update(canonical(pkg)).digest("hex");
export const byteHash = (bytes: Uint8Array | string) =>
  createHash("sha256").update(bytes).digest("hex");

function schema(value: unknown, depth = 0): asserts value is InputSchema {
  object(value);
  if (depth > 5) bad("Input schemas can be at most 5 levels deep.");
  const known = [
    "type",
    "description",
    "format",
    "properties",
    "required",
    "additionalProperties",
    "items",
    "enum",
    "minimum",
    "maximum",
    "maxLength",
    "maxItems",
  ];
  if (Object.keys(value).some((key) => !known.includes(key)))
    bad("Unsupported input schema field. See the tool package specification.");
  if (
    !["object", "array", "string", "number", "integer", "boolean"].includes(
      String(value.type),
    )
  )
    bad("Unsupported input type.");
  if (value.description !== undefined)
    text(value.description, "parameter description", 500);
  if (
    value.format !== undefined &&
    (value.format !== "document-id" || value.type !== "integer")
  )
    bad("Only integer document-id fields support a format.");
  for (const key of ["minimum", "maximum", "maxLength", "maxItems"]) {
    if (
      value[key] !== undefined &&
      (typeof value[key] !== "number" || !Number.isFinite(value[key]))
    )
      bad(`Invalid ${key}.`);
  }
  if (value.type === "object") {
    object(value.properties ?? {});
    const properties = (value.properties ?? {}) as Record<string, unknown>;
    if (Object.keys(properties).length > 20)
      bad("At most 20 input fields are supported.");
    for (const [key, child] of Object.entries(properties)) {
      if (
        !/^[a-zA-Z][a-zA-Z0-9_]{0,63}$/.test(key) ||
        ["constructor", "prototype", "__proto__"].includes(key)
      )
        bad("Invalid input field name.");
      schema(child, depth + 1);
    }
    if (
      value.additionalProperties !== undefined &&
      value.additionalProperties !== false
    )
      bad("Additional input properties are not supported.");
    if (
      value.required !== undefined &&
      (!Array.isArray(value.required) ||
        value.required.some(
          (key) => typeof key !== "string" || !Object.hasOwn(properties, key),
        ))
    )
      bad("Invalid required input fields.");
  }
  if (value.type === "array") schema(value.items, depth + 1);
  if (
    value.enum !== undefined &&
    (!Array.isArray(value.enum) || !value.enum.length || value.enum.length > 30)
  )
    bad("Invalid input enumeration.");
}

export function validateInput(
  value: unknown,
  spec: InputSchema,
  path = "input",
): asserts value is Record<string, Json> {
  if (spec.enum && !spec.enum.some((v) => canonical(v) === canonical(value)))
    bad(`${path} must be one of the listed choices.`);
  switch (spec.type) {
    case "object": {
      object(value);
      const properties = spec.properties ?? {};
      for (const key of spec.required ?? [])
        if (!Object.hasOwn(value, key)) bad(`${path}.${key} is required.`);
      for (const [key, item] of Object.entries(value)) {
        if (!Object.hasOwn(properties, key))
          bad(`Unknown input: ${path}.${key}.`);
        validateInput(item, properties[key]!, `${path}.${key}`);
      }
      break;
    }
    case "array":
      if (
        !Array.isArray(value) ||
        value.length > Math.min(spec.maxItems ?? 100, 1000)
      )
        bad(`${path} is not a valid bounded array.`);
      (value as unknown[]).forEach((v, i) =>
        validateInput(v, spec.items!, `${path}[${i}]`),
      );
      break;
    case "string":
      if (
        typeof value !== "string" ||
        value.length > Math.min(spec.maxLength ?? 4000, 20000)
      )
        bad(`${path} is not a valid string.`);
      break;
    case "boolean":
      if (typeof value !== "boolean") bad(`${path} must be true or false.`);
      break;
    case "number":
    case "integer":
      if (
        typeof value !== "number" ||
        !Number.isFinite(value) ||
        (spec.type === "integer" && !Number.isInteger(value)) ||
        value < (spec.minimum ?? -Infinity) ||
        value > (spec.maximum ?? Infinity)
      )
        bad(`${path} is not a valid ${spec.type}.`);
  }
}

export function validatePackage(value: unknown): ToolPackage {
  if (Buffer.byteLength(JSON.stringify(value) ?? "") > MAX_PACKAGE_BYTES)
    bad("Tool package exceeds 512 KB.");
  // Clone through JSON: package code stays data, and no caller objects cross the boundary.
  const pkg = JSON.parse(JSON.stringify(value)) as ToolPackage;
  object(pkg);
  if (pkg.format !== "docent-tool" || pkg.formatVersion !== 1)
    bad("Unsupported tool package format.");
  object(pkg.manifest);
  const m = pkg.manifest;
  if (!ID.test(m.id))
    bad("Tool ID must use lowercase letters, digits, and hyphens.");
  if (!VERSION.test(m.version)) bad("Tool version must be major.minor.patch.");
  text(m.name, "tool name", 80);
  text(m.description, "description", 1000);
  text(m.author, "author", 100);
  text(m.license, "license", 100);
  if (m.apiVersion !== 1)
    bad("This tool requires an unsupported Docent tool API version.");
  if (JSON.stringify(m.permissions) !== '["documents:read"]')
    bad("Only the documents:read permission is supported.");
  schema(m.inputSchema);
  if (m.inputSchema.type !== "object")
    bad("The root input schema must be an object.");
  text(pkg.code, "JavaScript code", 128 * 1024);
  if (
    !Array.isArray(m.examples) ||
    !m.examples.length ||
    m.examples.length > 10
  )
    bad("Provide 1–10 examples.");
  for (const example of m.examples) {
    text(example.name, "example name", 100);
    validateInput(example.input, m.inputSchema);
  }
  if (!Array.isArray(pkg.tests) || !pkg.tests.length || pkg.tests.length > 10)
    bad("Provide 1–10 tests with synthetic documents.");
  for (const test of pkg.tests) {
    text(test.name, "test name", 100);
    validateInput(test.input, m.inputSchema);
    if (!Array.isArray(test.documents) || test.documents.length > 10)
      bad("Each test supports at most 10 synthetic documents.");
    for (const doc of test.documents) {
      text(doc.title, "fixture title", 200);
      text(doc.text, "fixture text", 20000);
    }
    if (test.expectedData === undefined)
      bad("Each test requires expectedData.");
  }
  return pkg;
}

export function validateCatalog(value: unknown): ToolCatalog {
  object(value);
  if (value.format !== "docent-tool-collection" || value.formatVersion !== 1)
    bad("This repository does not contain a supported Docent tool collection.");
  text(value.name, "collection name", 100);
  if (!Array.isArray(value.tools) || value.tools.length > 100)
    bad("A collection supports up to 100 tools.");
  const seen = new Set<string>();
  for (const t of value.tools as unknown[]) {
    object(t);
    if (typeof t.id !== "string" || !ID.test(t.id) || seen.has(t.id))
      bad("Invalid or duplicate catalog tool ID.");
    seen.add(t.id as string);
    text(t.name, "tool name", 80);
    text(t.description, "description", 1000);
    if (typeof t.version !== "string" || !VERSION.test(t.version))
      bad("Invalid catalog version.");
    if (typeof t.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(t.sha256))
      bad("Each tool needs a SHA-256 file digest.");
    if (
      typeof t.file !== "string" ||
      t.file.length > 200 ||
      !/^[a-zA-Z0-9_./-]+\.docent-tool\.json$/.test(t.file) ||
      t.file.startsWith("/") ||
      t.file.split("/").some((p) => !p || p === "." || p === "..")
    )
      bad("Invalid package path in catalog.");
  }
  return value as unknown as ToolCatalog;
}
