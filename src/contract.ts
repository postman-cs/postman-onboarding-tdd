import { parse } from 'yaml';

type JsonRecord = Record<string, unknown>;

export interface ContractOperation {
  method: string;
  operationId?: string;
  path: string;
  responses: Record<string, ContractResponse>;
}

export interface ContractResponse {
  content: Record<string, { schema?: unknown }>;
  description?: string;
}

export interface ContractIndex {
  operations: ContractOperation[];
  openapiVersion: '3.0' | '3.1';
  warnings: string[];
}

export interface ContractInstrumentationResult {
  collection: JsonRecord;
  warnings: string[];
}

const HTTP_METHODS = new Set(['get', 'put', 'post', 'delete', 'options', 'head', 'patch', 'trace']);

function asRecord(value: unknown): JsonRecord | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as JsonRecord
    : null;
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

export function parseOpenApiDocument(content: string): JsonRecord {
  const head = content.trimStart();
  const parsed = head.startsWith('{') ? JSON.parse(content) : parse(content);
  const root = asRecord(parsed);
  if (!root) {
    throw new Error('OpenAPI document must be an object');
  }
  return root;
}

export function detectOpenApiVersion(root: JsonRecord): '3.0' | '3.1' {
  const raw = String(root.openapi || '').trim();
  if (/^3\.1(?:\.\d+)?$/.test(raw)) return '3.1';
  if (/^3\.0(?:\.\d+)?$/.test(raw)) return '3.0';
  throw new Error(`Dynamic TDD contracts require OpenAPI 3.0 or 3.1, got: ${raw || '<missing>'}`);
}

export function buildContractIndex(root: JsonRecord): ContractIndex {
  const warnings: string[] = [];
  const paths = asRecord(root.paths);
  if (!paths) {
    throw new Error('OpenAPI document must define paths');
  }
  const operations: ContractOperation[] = [];
  for (const [path, pathItemRaw] of Object.entries(paths)) {
    const pathItem = asRecord(pathItemRaw);
    if (!pathItem) continue;
    for (const [methodRaw, operationRaw] of Object.entries(pathItem)) {
      const method = methodRaw.toLowerCase();
      if (!HTTP_METHODS.has(method)) continue;
      const operation = resolveRef(root, operationRaw);
      if (!operation) continue;
      operations.push({
        method: method.toUpperCase(),
        operationId: typeof operation.operationId === 'string' ? operation.operationId : undefined,
        path,
        responses: collectResponses(root, operation)
      });
    }
  }
  if (operations.length === 0) {
    warnings.push('CONTRACT_NO_OPERATIONS: OpenAPI document contains no operations');
  }
  return {
    openapiVersion: detectOpenApiVersion(root),
    operations,
    warnings
  };
}

function collectResponses(root: JsonRecord, operation: JsonRecord): Record<string, ContractResponse> {
  const responsesRoot = asRecord(operation.responses) || {};
  const responses: Record<string, ContractResponse> = {};
  for (const [status, responseRaw] of Object.entries(responsesRoot)) {
    const response = resolveRef(root, responseRaw) || {};
    const contentRoot = asRecord(response.content) || {};
    const content: Record<string, { schema?: unknown }> = {};
    for (const [mediaType, mediaRaw] of Object.entries(contentRoot)) {
      const media = asRecord(mediaRaw) || {};
      const schema = media.schema === undefined ? undefined : dereferenceSchema(root, media.schema);
      content[mediaType] = schema === undefined ? {} : { schema };
    }
    responses[normalizeResponseKey(status)] = {
      content,
      description: typeof response.description === 'string' ? response.description : undefined
    };
  }
  return responses;
}

function resolvePointer(root: JsonRecord, ref: string): unknown {
  const path = ref.slice(2).split('/').map((part) => part.replace(/~1/g, '/').replace(/~0/g, '~'));
  let current: unknown = root;
  for (const part of path) {
    const record = asRecord(current);
    if (!record) return undefined;
    current = record[part];
  }
  return current;
}

function resolveRef(root: JsonRecord, value: unknown): JsonRecord | null {
  const record = asRecord(value);
  if (!record) return null;
  const ref = typeof record.$ref === 'string' ? record.$ref : '';
  if (!ref) return record;
  if (!ref.startsWith('#/')) {
    throw new Error(`External $ref remained in OpenAPI document: ${ref}`);
  }
  const resolved = asRecord(resolvePointer(root, ref));
  if (!resolved) {
    throw new Error(`Unresolved OpenAPI $ref: ${ref}`);
  }
  return resolved;
}

function dereferenceSchema(root: JsonRecord, schema: unknown, seen = new Set<string>()): unknown {
  if (Array.isArray(schema)) {
    return schema.map((entry) => dereferenceSchema(root, entry, seen));
  }
  const record = asRecord(schema);
  if (!record) return schema;
  const ref = typeof record.$ref === 'string' ? record.$ref : '';
  if (ref) {
    if (!ref.startsWith('#/')) {
      return { unsupported: `external ref ${ref}` };
    }
    if (seen.has(ref)) {
      return {};
    }
    seen.add(ref);
    return dereferenceSchema(root, resolvePointer(root, ref), seen);
  }
  const copy: JsonRecord = {};
  for (const [key, value] of Object.entries(record)) {
    copy[key] = dereferenceSchema(root, value, new Set(seen));
  }
  return copy;
}

function normalizeResponseKey(status: string): string {
  return /^[1-5]xx$/i.test(status) ? status.toUpperCase() : status;
}

export function instrumentContractCollection(
  collection: JsonRecord,
  index: ContractIndex
): ContractInstrumentationResult {
  const warnings = [...index.warnings];
  const clone = sanitizeCollectionForUpdate(collection) as JsonRecord;
  const visit = (item: JsonRecord): void => {
    if (item.request) {
      const match = matchOperation(index, item.request);
      if (match.operation) {
        const events = asArray(item.event).filter((event) => {
          const record = asRecord(event);
          return record?.listen !== 'test';
        });
        item.event = [
          ...events,
          {
            listen: 'test',
            script: {
              type: 'text/javascript',
              exec: createContractScript(match.operation)
            }
          }
        ];
      } else {
        warnings.push(`CONTRACT_REQUEST_NOT_MATCHED: ${match.method || '<method>'} ${match.path}`);
      }
    }
    for (const child of asArray(item.item).map((entry) => asRecord(entry)).filter(Boolean)) {
      visit(child!);
    }
  };

  for (const item of asArray(clone.item).map((entry) => asRecord(entry)).filter(Boolean)) {
    visit(item!);
  }
  return { collection: clone, warnings };
}

export function sanitizeCollectionForUpdate(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((entry) => sanitizeCollectionForUpdate(entry));
  }
  const record = asRecord(value);
  if (!record) return value;
  const clone: JsonRecord = {};
  for (const [key, entry] of Object.entries(record)) {
    if (['id', 'uid', '_postman_id'].includes(key)) continue;
    if (key === 'response') continue;
    clone[key] = sanitizeCollectionForUpdate(entry);
  }
  return clone;
}

function createContractScript(operation: ContractOperation): string[] {
  const contract = {
    method: operation.method,
    operationId: operation.operationId,
    path: operation.path,
    responses: operation.responses
  };
  return [
    '// [Postman TDD] Auto-generated OpenAPI contract assertions',
    `const contract = JSON.parse(${JSON.stringify(JSON.stringify(contract))});`,
    'function responseText() { return pm.response.text() || ""; }',
    'function isBodyless() { return pm.response.code === 204 || pm.response.code === 205 || pm.response.code === 304 || contract.method === "HEAD"; }',
    'function mediaBase(value) { return String(value || "").toLowerCase().split(";")[0].trim(); }',
    'function selectResponseContract() {',
    '  const status = String(pm.response.code);',
    '  if (contract.responses[status]) return { key: status, value: contract.responses[status] };',
    '  const range = String(Math.floor(pm.response.code / 100)) + "XX";',
    '  if (contract.responses[range]) return { key: range, value: contract.responses[range] };',
    '  if (contract.responses.default) return { key: "default", value: contract.responses.default };',
    '  return null;',
    '}',
    'function expectedMedia(responseContract) { return Object.keys(responseContract.content || {}); }',
    'function selectSchema(responseContract) {',
    '  const content = responseContract.content || {};',
    '  const actual = mediaBase(pm.response.headers.get("Content-Type") || "");',
    '  const keys = Object.keys(content);',
    '  if (keys.length === 0) return undefined;',
    '  const exact = keys.find((key) => mediaBase(key) === actual);',
    '  if (exact) return content[exact].schema;',
    '  const json = keys.find((key) => mediaBase(key) === "application/json" && /json$/.test(actual));',
    '  return json ? content[json].schema : content[keys[0]].schema;',
    '}',
    'function typeOf(value) { if (Array.isArray(value)) return "array"; if (value === null) return "null"; if (Number.isInteger(value)) return "integer"; return typeof value; }',
    'function schemaTypes(schema) { const type = schema && schema.type; return Array.isArray(type) ? type : type ? [type] : []; }',
    'function validateSchema(value, schema, path, errors) {',
    '  if (!schema || typeof schema !== "object") return;',
    '  if (schema.unsupported) { errors.push(path + " uses unsupported schema: " + schema.unsupported); return; }',
    '  if (schema.allOf) schema.allOf.forEach((entry) => validateSchema(value, entry, path, errors));',
    '  const types = schemaTypes(schema);',
    '  if (types.length > 0) {',
    '    const actual = typeOf(value);',
    '    const ok = types.some((type) => type === actual || (type === "number" && actual === "integer"));',
    '    if (!ok) { errors.push(path + " expected " + types.join("|") + " but received " + actual); return; }',
    '  }',
    '  if (schema.enum && !schema.enum.some((entry) => JSON.stringify(entry) === JSON.stringify(value))) errors.push(path + " expected enum value " + JSON.stringify(schema.enum));',
    '  if (schema.const !== undefined && JSON.stringify(schema.const) !== JSON.stringify(value)) errors.push(path + " expected const " + JSON.stringify(schema.const));',
    '  if (schema.type === "object" || schema.properties) {',
    '    const required = Array.isArray(schema.required) ? schema.required : [];',
    '    required.forEach((key) => { if (!value || typeof value !== "object" || !(key in value)) errors.push(path + "." + key + " is required"); });',
    '    Object.entries(schema.properties || {}).forEach(([key, child]) => { if (value && typeof value === "object" && key in value) validateSchema(value[key], child, path + "." + key, errors); });',
    '  }',
    '  if (schema.type === "array" && schema.items && Array.isArray(value)) value.forEach((entry, index) => validateSchema(entry, schema.items, path + "[" + index + "]", errors));',
    '}',
    'const selected = selectResponseContract();',
    'pm.test("OpenAPI operation mapping exists", function () { pm.expect(contract.path).to.be.a("string").and.not.empty; });',
    'pm.test("Status code is defined by OpenAPI", function () { pm.expect(selected, "No OpenAPI response defined for " + contract.method + " " + contract.path + " status " + pm.response.code).to.exist; });',
    'pm.test("Response body matches OpenAPI body contract", function () {',
    '  if (!selected) return;',
    '  if (isBodyless()) { pm.expect(responseText().trim().length).to.equal(0); return; }',
    '  const media = expectedMedia(selected.value);',
    '  if (media.length === 0) pm.expect(responseText().trim().length, "OpenAPI response defines no body but response body was not empty").to.equal(0);',
    '  else pm.expect(responseText().trim().length, "OpenAPI response defines a body but response body was empty").to.be.above(0);',
    '});',
    'pm.test("Content-Type matches OpenAPI response content", function () {',
    '  if (!selected || isBodyless()) return;',
    '  const media = expectedMedia(selected.value);',
    '  if (media.length === 0) return;',
    '  const actual = mediaBase(pm.response.headers.get("Content-Type") || "");',
    '  pm.expect(actual, "Content-Type must match one of " + media.join(", ")).to.not.equal("");',
    '  const matches = media.some((entry) => mediaBase(entry) === actual || (mediaBase(entry) === "application/json" && /json$/.test(actual)));',
    '  pm.expect(matches, "Content-Type " + actual + " did not match OpenAPI content " + media.join(", ")).to.equal(true);',
    '});',
    'pm.test("Response body matches OpenAPI schema", function () {',
    '  if (!selected || isBodyless()) return;',
    '  const schema = selectSchema(selected.value);',
    '  if (!schema) return;',
    '  const body = responseText().trim();',
    '  if (!body) return;',
    '  let parsed;',
    '  try { parsed = JSON.parse(body); } catch (error) { pm.expect.fail("Response body was not valid JSON: " + error.message); }',
    '  const errors = [];',
    '  validateSchema(parsed, schema, "$", errors);',
    '  if (errors.length > 0) pm.expect.fail(errors.slice(0, 10).join("; "));',
    '});'
  ];
}

function matchOperation(index: ContractIndex, request: unknown): { method: string; operation?: ContractOperation; path: string } {
  const record = asRecord(request);
  const method = String(record?.method || '').toUpperCase();
  const path = requestPath(request);
  const candidates = index.operations
    .filter((operation) => operation.method === method)
    .map((operation) => ({ operation, score: pathScore(operation.path, path) }))
    .filter((entry) => entry.score >= 0)
    .sort((a, b) => b.score - a.score || a.operation.path.localeCompare(b.operation.path));
  return { method, operation: candidates[0]?.operation, path };
}

function requestPath(request: unknown): string {
  const record = asRecord(request);
  const url = record?.url ?? request;
  if (typeof url === 'string') return pathFromRaw(url);
  const urlRecord = asRecord(url);
  if (!urlRecord) return '/';
  if (typeof urlRecord.raw === 'string') return pathFromRaw(urlRecord.raw);
  if (Array.isArray(urlRecord.path)) {
    return normalizePath(`/${urlRecord.path.map(stringifyPathSegment).filter(Boolean).join('/')}`);
  }
  if (typeof urlRecord.path === 'string') return normalizePath(urlRecord.path);
  return '/';
}

function stringifyPathSegment(segment: unknown): string {
  if (typeof segment === 'string') return segment;
  const record = asRecord(segment);
  return String(record?.value || record?.key || record?.name || segment || '');
}

function pathFromRaw(raw: string): string {
  let value = String(raw || '').trim();
  value = value.replace(/^\{\{[^}]+}}/, '');
  try {
    return normalizePath(new URL(value).pathname);
  } catch {
    value = value.replace(/^[a-z][a-z0-9+.-]*:\/\/[^/]+/i, '');
    return normalizePath(value || '/');
  }
}

function normalizePath(path: string): string {
  const raw = String(path || '').split(/[?#]/, 1)[0] || '/';
  const withSlash = raw.startsWith('/') ? raw : `/${raw}`;
  const collapsed = withSlash.replace(/\/+/g, '/');
  return collapsed.length > 1 ? collapsed.replace(/\/+$/g, '') : collapsed;
}

function pathScore(candidate: string, request: string): number {
  const candidateParts = normalizePath(candidate).split('/').filter(Boolean);
  const requestParts = normalizePath(request).split('/').filter(Boolean);
  if (candidateParts.length !== requestParts.length) return -1;
  let score = 0;
  for (let index = 0; index < candidateParts.length; index += 1) {
    const candidatePart = candidateParts[index] || '';
    const requestPart = requestParts[index] || '';
    if (/^\{[^}]+}$/.test(candidatePart) || /^:[^/]+$/.test(candidatePart) || /^\{\{[^}]+}}$/.test(candidatePart)) {
      score += 1;
      continue;
    }
    if (candidatePart !== requestPart) return -1;
    score += 10;
  }
  return score;
}
