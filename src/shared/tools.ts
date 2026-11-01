import type { Citation } from "./types";

export type Json =
  | null
  | boolean
  | number
  | string
  | Json[]
  | { [key: string]: Json };
/** Deliberately small, documented subset of JSON Schema. */
export interface InputSchema {
  type: "object" | "array" | "string" | "number" | "integer" | "boolean";
  description?: string;
  format?: "document-id";
  properties?: Record<string, InputSchema>;
  required?: string[];
  additionalProperties?: false;
  items?: InputSchema;
  enum?: Json[];
  minimum?: number;
  maximum?: number;
  maxLength?: number;
  maxItems?: number;
}
export interface ToolManifest {
  id: string;
  name: string;
  version: string;
  description: string;
  author: string;
  license: string;
  apiVersion: 1;
  permissions: ["documents:read"];
  inputSchema: InputSchema;
  examples: { name: string; input: Record<string, Json> }[];
}
export interface ToolFixture {
  title: string;
  text: string;
}
export interface ToolPackage {
  format: "docent-tool";
  formatVersion: 1;
  manifest: ToolManifest;
  /** Defines a synchronous function run(input, library). No imports or installation hooks. */
  code: string;
  tests: {
    name: string;
    input: Record<string, Json>;
    documents: ToolFixture[];
    expectedData: Json;
  }[];
}
export interface ToolOrigin {
  kind: "bundled" | "github" | "local";
  repository?: string;
  commit?: string;
  release?: string;
}
export interface InstalledTool {
  key: string;
  hash: string;
  enabled: boolean;
  package: ToolPackage;
  origin: ToolOrigin;
  installedAt: number;
  versions: { hash: string; version: string; installedAt: number }[];
}
export interface ToolCatalog {
  format: "docent-tool-collection";
  formatVersion: 1;
  name: string;
  tools: {
    id: string;
    name: string;
    description: string;
    version: string;
    file: string;
    sha256: string;
  }[];
}
export interface ToolRepository {
  id: string;
  url: string;
  commit: string;
  release?: string;
  checkedAt: number;
  catalog: ToolCatalog;
}
export interface PreparedTool {
  token: string;
  hash: string;
  package: ToolPackage;
  origin: ToolOrigin;
}
export interface ToolCoverage {
  documentsInScope: number;
  documentsListed: number;
  documentsRead: number;
  passagesRead: number;
  passagesInScope: number;
  unavailableDocuments: number;
  staleDocuments: number;
  complete: boolean;
}
export interface ToolRunRecord {
  id: string;
  toolKey: string;
  name: string;
  version: string;
  hash: string;
  input: Record<string, Json>;
  setIds: number[];
  documentIds: number[];
  scopeFingerprint: string;
  startedAt: number;
  durationMs: number;
  status: "succeeded" | "failed";
  error?: string;
  coverage: ToolCoverage;
}
export interface ToolRunResult {
  record: ToolRunRecord;
  data: Json;
  citations: Citation[];
}
export interface ToolScope {
  setIds: number[];
  documentIds: number[];
}
export interface ToolTestResult {
  name: string;
  passed: boolean;
  error?: string;
}
export interface ToolsApi {
  list(): Promise<InstalledTool[]>;
  repositories(): Promise<ToolRepository[]>;
  addRepository(url: string): Promise<ToolRepository>;
  checkRepository(id: string): Promise<ToolRepository>;
  removeRepository(id: string): Promise<void>;
  prepareRepository(id: string, toolId: string): Promise<PreparedTool>;
  importPackage(): Promise<PreparedTool | null>;
  prepareLocal(pkg: ToolPackage): Promise<PreparedTool>;
  install(token: string): Promise<void>;
  enable(key: string, enabled: boolean): Promise<void>;
  rollback(key: string, hash: string): Promise<void>;
  remove(key: string): Promise<void>;
  exportPackage(key: string): Promise<boolean>;
  testPackage(pkg: ToolPackage): Promise<ToolTestResult[]>;
  run(request: {
    id: string;
    key: string;
    input: Record<string, Json>;
    scope: ToolScope;
  }): Promise<ToolRunResult>;
  cancel(id: string): Promise<void>;
  runs(): Promise<ToolRunResult[]>;
}
