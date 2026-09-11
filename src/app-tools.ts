import { artifactV2, operationBinding, receiptV2, scopeV2, isV2Tool } from './free-session.ts';
import { createHash } from 'node:crypto';
import { ManagedIdentityCredential } from '@azure/identity';
import { TaskError } from './task-types.ts';
import type { CallbackRequest, CallbackResponse, OperationBinding, OperationReceipt, OperationResponse, ToolBinding, ToolSnapshot } from './tool-types.ts';

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function keys(value: Record<string, unknown>, allowed: string[]) {
  return Object.keys(value).every(key => allowed.includes(key));
}
function text(value: unknown, max = 128): value is string {
  return typeof value === 'string' && value.length > 0 && Buffer.byteLength(value) <= max;
}
function invalid(code = 'invalid_request'): never { throw new TaskError(400, code); }
export function stable(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(stable).join(',') + ']';
  if (object(value)) return '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + stable(value[key])).join(',') + '}';
  return JSON.stringify(value);
}
function schema(value: unknown, depth = 0, maxItems = 16): asserts value is Record<string, unknown> {
  if (!object(value) || depth > 8) invalid();
  if ('oneOf' in value) {
    if (!keys(value, ['oneOf']) || !Array.isArray(value.oneOf) || value.oneOf.length < 2 || value.oneOf.length > 8) invalid();
    const discriminator = depth === 0 ? 'mode' : 'type';
    const values = new Set<string>();
    for (const branch of value.oneOf) {
      schema(branch, depth + 1, maxItems);
      const tag = object(branch.properties) ? branch.properties[discriminator] : undefined;
      if (branch.type !== 'object' || !object(tag) || !Array.isArray(tag.enum) || tag.enum.length !== 1
        || typeof tag.enum[0] !== 'string' || values.has(tag.enum[0]) || !(branch.required as string[]).includes(discriminator)) invalid();
      values.add(tag.enum[0]);
    }
    return;
  }
  if (value.type === 'object') {
    if (!keys(value, ['type', 'properties', 'required', 'additionalProperties']) || !object(value.properties)
      || value.additionalProperties !== false || !Array.isArray(value.required)
      || value.required.some(key => typeof key !== 'string' || !Object.hasOwn(value.properties as object, key))
      || new Set(value.required).size !== value.required.length || Object.keys(value.properties).length > 64) invalid();
    for (const child of Object.values(value.properties)) schema(child, depth + 1, maxItems);
  } else if (value.type === 'array') {
    if (!keys(value, ['type', 'items', 'minItems', 'maxItems']) || !Number.isSafeInteger(value.maxItems)
      || Number(value.maxItems) < 0 || Number(value.maxItems) > maxItems
      || ('minItems' in value && (!Number.isSafeInteger(value.minItems) || Number(value.minItems) < 0))
      || Number(value.minItems ?? 0) > Number(value.maxItems)) invalid();
    schema(value.items, depth + 1, maxItems);
  } else if (['string', 'integer', 'boolean'].includes(String(value.type))) {
    const allowed = value.type === 'string' ? ['type', 'enum', 'minLength', 'maxLength']
      : value.type === 'integer' ? ['type', 'enum', 'minimum', 'maximum'] : ['type', 'enum'];
    if (!keys(value, allowed)) invalid();
    if ('enum' in value && (!Array.isArray(value.enum) || !value.enum.length || value.enum.length > 256
      || value.enum.some(item => value.type === 'integer' ? !Number.isSafeInteger(item) : typeof item !== value.type))) invalid();
    for (const key of ['minLength', 'maxLength', 'minimum', 'maximum']) {
      if (key in value && (!Number.isSafeInteger(value[key]) || (key.endsWith('Length') && Number(value[key]) < 0))) invalid();
    }
    if (Number(value.minLength ?? 0) > Number(value.maxLength ?? Infinity)
      || Number(value.minimum ?? -Infinity) > Number(value.maximum ?? Infinity)) invalid();
  } else invalid();
}
function matches(s: Record<string, unknown>, value: unknown): boolean {
  if (Array.isArray(s.oneOf)) return s.oneOf.filter(branch => matches(branch, value)).length === 1;
  if (s.type === 'object') {
    if (!object(value)) return false;
    const props = s.properties as Record<string, Record<string, unknown>>;
    return (s.required as string[]).every(key => Object.hasOwn(value, key))
      && Object.keys(value).every(key => Object.hasOwn(props, key) && matches(props[key]!, value[key]));
  }
  if (s.type === 'array') return Array.isArray(value) && value.length >= Number(s.minItems ?? 0)
    && value.length <= Number(s.maxItems) && value.every(item => matches(s.items as Record<string, unknown>, item));
  if (s.type === 'string' && (typeof value !== 'string' || [...value].length < Number(s.minLength ?? 0) || [...value].length > Number(s.maxLength ?? Infinity))) return false;
  if (s.type === 'integer' && (!Number.isSafeInteger(value) || Number(value) < Number(s.minimum ?? -Infinity) || Number(value) > Number(s.maximum ?? Infinity))) return false;
  if (s.type === 'boolean' && typeof value !== 'boolean') return false;
  return !Array.isArray(s.enum) || s.enum.includes(value);
}
const errorCodes = new Set(['invalid_arguments', 'forbidden_scope', 'authorization_required', 'authorization_revoked', 'draft_conflict',
  'operation_conflict', 'revision_conflict', 'invalid_cursor', 'not_found', 'result_too_large', 'reference_unavailable', 'reference_changed']);
function receipt(value: unknown, operationId: string): value is OperationReceipt {
  if (!object(value) || value.operation_id !== operationId || value.status !== 'committed' || !text(value.story_id)
    || !text(value.revision) || !hash(value.content_hash)) return false;
  if (!('kind' in value)) return keys(value, ['operation_id', 'status', 'story_id', 'chapter_id', 'revision', 'content_hash']) && text(value.chapter_id);
  if (!keys(value, ['operation_id', 'status', 'story_id', 'kind', 'revision', 'content_hash', 'draft_id', 'draft_revision', 'draft_hash', 'assets', 'chapter'])
    || !text(value.draft_id) || !text(value.draft_revision) || !hash(value.draft_hash) || value.content_hash !== value.draft_hash
    || !Array.isArray(value.assets) || value.assets.length > 8) return false;
  const ids = new Set<string>(); const singletonKinds = new Set<string>();
  for (const asset of value.assets) {
    if (!object(asset) || !keys(asset, ['asset_id', 'kind', 'revision', 'content_hash']) || !text(asset.asset_id)
      || !['setting', 'outline', 'snapshot'].includes(String(asset.kind)) || !text(asset.revision) || !hash(asset.content_hash)
      || ids.has(asset.asset_id) || (asset.kind !== 'snapshot' && singletonKinds.has(String(asset.kind)))) return false;
    ids.add(asset.asset_id); singletonKinds.add(String(asset.kind));
  }
  if (value.kind === 'story_initialized') return !('chapter' in value);
  return value.kind === 'first_chapter_saved' && object(value.chapter) && keys(value.chapter, ['chapter_id', 'revision', 'content_hash'])
    && text(value.chapter.chapter_id) && text(value.chapter.revision) && hash(value.chapter.content_hash);
}
function hash(value: unknown): value is string { return typeof value === 'string' && /^sha256:[a-f0-9]{64}$/.test(value); }
export function formalCommit(tool: Pick<ToolSnapshot, 'name' | 'version'>, args: Record<string, unknown>): boolean {
  return args.mode === 'commit' && (tool.version === '1' && ['create_chapter', 'initialize_story'].includes(tool.name)
    || tool.version === '2' && ['save_character', 'save_world', 'initialize_story', 'create_chapter'].includes(tool.name));
}
function matchesReceipt(value: OperationReceipt, binding: OperationBinding): boolean {
  if ('protocol_version' in value || !formalCommit(binding.tool, binding.arguments) || value.story_id !== binding.story_id) return false;
  if (binding.tool.name === 'create_chapter') return !('kind' in value);
  return 'kind' in value && value.draft_id === binding.arguments.draft_id
    && value.draft_revision === binding.arguments.draft_revision && value.draft_hash === binding.arguments.draft_hash;
}
function transport(): never { throw new Error('tool_transport_failed'); }
interface Options { allowLoopback?: boolean; token?: (audience: string, signal: AbortSignal) => Promise<string>; fetch?: typeof fetch }
export class AppTools {
  readonly #bindings: Record<string, ToolBinding>;
  readonly #options: Options;
  constructor(bindings: Record<string, ToolBinding>, options: Options = {}) {
    if (!object(bindings)) invalid('invalid_tool_configuration');
    for (const [appId, binding] of Object.entries(bindings)) {
      if (!/^[a-z][a-z0-9_-]{0,63}$/.test(appId) || !object(binding)
        || !keys(binding, ['endpoint', 'operations_endpoint', 'audience', 'tools']) || !text(binding.audience, 256)
        || !/^api:\/\/[A-Za-z0-9-]+$/.test(binding.audience)) invalid('invalid_tool_configuration');
      const urls: URL[] = [];
      for (const address of [binding.endpoint, binding.operations_endpoint]) {
        if (!text(address, 2048)) invalid('invalid_tool_configuration');
        let url: URL;
        try { url = new URL(address); } catch { invalid('invalid_tool_configuration'); }
        if (url.username || url.password || url.search || url.hash || url.pathname.endsWith('/')
          || (url.protocol !== 'https:' && !(options.allowLoopback && options.token && url.protocol === 'http:' && ['127.0.0.1', '[::1]', 'localhost'].includes(url.hostname)))) invalid('invalid_tool_configuration');
        urls.push(url);
      }
      if (urls[0]!.origin !== urls[1]!.origin || !Array.isArray(binding.tools) || !binding.tools.length || binding.tools.length > 16) invalid('invalid_tool_configuration');
      const names = new Set<string>();
      for (const tool of binding.tools) {
        if (!object(tool) || !keys(tool, ['name', 'version', 'effect']) || !text(tool.name, 64)
          || !/^[a-z][a-z0-9_]*$/.test(tool.name) || !text(tool.version) || !['read', 'write'].includes(tool.effect) || names.has(tool.name + '/' + tool.version)) invalid('invalid_tool_configuration');
        names.add(tool.name + '/' + tool.version);
      }
    }
    this.#bindings = structuredClone(bindings); this.#options = options;
  }
  static fromEnv(env: NodeJS.ProcessEnv): AppTools {
    let value: unknown = {};
    if (env.MOCHI_APP_TOOLS !== undefined) {
      try { value = JSON.parse(env.MOCHI_APP_TOOLS); } catch { invalid('invalid_tool_configuration'); }
    }
    const credential = new ManagedIdentityCredential({ clientId: env.AZURE_CLIENT_ID });
    return new AppTools(value as Record<string, ToolBinding>, {
      token: async (audience, signal) => (await credential.getToken(audience + '/.default', { abortSignal: signal })).token,
    });
  }
  assertSupported(appId: string, tools: ToolSnapshot[]): void {
    const binding = this.#bindings[appId];
    if (!binding || tools.some(tool => !binding.tools.some(allowed => allowed.name === tool.name && allowed.version === tool.version && allowed.effect === tool.effect))) invalid('tool_version_unavailable');
  }
  validate(appId: string, value: unknown, protocolVersion?: 2): { tools: ToolSnapshot[]; tool_snapshot_hash: string } | undefined {
    if (value === undefined || (Array.isArray(value) && value.length === 0)) return undefined;
    if (!Array.isArray(value) || value.length > 16 || Buffer.byteLength(JSON.stringify(value)) > 32768) invalid();
    const names = new Set<string>();
    for (const tool of value) {
      if (!object(tool) || !keys(tool, ['name', 'version', 'description', 'effect', 'parameters']) || !text(tool.name, 64)
        || !/^[a-z][a-z0-9_]*$/.test(tool.name) || !text(tool.version) || !text(tool.description, 2048)
        || !['read', 'write'].includes(String(tool.effect)) || names.has(tool.name)) invalid();
      schema(tool.parameters, 0, protocolVersion === 2 ? 30 : 16); names.add(tool.name);
    }
    const tools = structuredClone(value) as ToolSnapshot[];
    this.assertSupported(appId, tools);
    return { tools, tool_snapshot_hash: 'sha256:' + createHash('sha256').update(stable(tools)).digest('hex') };
  }
  validateArguments(tool: ToolSnapshot, args: unknown): void {
    schema(tool.parameters, 0, 30);
    if (!object(args) || !matches(tool.parameters, args)) invalid('invalid_arguments');
  }
  async #request(appId: string, path: 'endpoint' | 'operations_endpoint', signal: AbortSignal, body?: CallbackRequest, operationId?: string): Promise<unknown> {
    const binding = this.#bindings[appId];
    if (!binding || !this.#options.token) transport();
    const deadline = AbortSignal.any([signal, AbortSignal.timeout(15000)]);
    try {
      deadline.throwIfAborted();
      const token = await this.#options.token(binding.audience, deadline);
      deadline.throwIfAborted();
      if (!text(token, 16384) || /[\r\n]/.test(token)) transport();
      const serialized = body === undefined ? undefined : JSON.stringify(body);
      if (serialized !== undefined && Buffer.byteLength(serialized) > 131072) transport();
      if (operationId !== undefined && (!text(operationId) || ['.', '..'].includes(operationId))) transport();
      const url = binding[path] + (operationId === undefined ? '' : '/' + encodeURIComponent(operationId));
      const response = await (this.#options.fetch ?? fetch)(url, {
        method: body === undefined ? 'GET' : 'POST', redirect: 'error', signal: deadline,
        headers: { authorization: 'Bearer ' + token, accept: 'application/json', ...(body === undefined ? {} : { 'content-type': 'application/json' }) }, body: serialized,
      });
      if (response.status !== 200 || response.headers.get('content-type')?.split(';')[0]?.trim() !== 'application/json' || !response.body) {
        await response.body?.cancel(); transport();
      }
      const reader = response.body.getReader(); let bytes = 0; const chunks: Uint8Array[] = [];
      try {
        while (true) {
          deadline.throwIfAborted();
          const { value, done } = await reader.read();
          if (done) break;
          bytes += value.byteLength;
          if (bytes > 65536) transport();
          chunks.push(value);
        }
        deadline.throwIfAborted();
        return JSON.parse(Buffer.concat(chunks).toString('utf8'));
      } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
    } catch { transport(); }
  }
  async invoke(appId: string, request: CallbackRequest, signal: AbortSignal): Promise<CallbackResponse> {
    if (request.app_id !== appId || ![1, 2].includes(request.protocol_version)) transport();
    if (request.protocol_version === 1 && (request.tool.version === '2' || request.scope.protocol_version !== undefined)) transport();
    if (request.protocol_version === 2) {
      if (!isV2Tool(request.tool)) transport();
      try { scopeV2({ ...request.scope, task_id: request.task_id }); } catch { transport(); }
    }
    const binding = this.#bindings[appId];
    if (!binding?.tools.some(tool => tool.name === request.tool.name && tool.version === request.tool.version)) invalid('tool_version_unavailable');
    const value = await this.#request(appId, 'endpoint', signal, request);
    if (!object(value) || value.protocol_version !== request.protocol_version || value.invocation_id !== request.invocation_id) transport();
    if (value.outcome === 'error') {
      if (!keys(value, ['protocol_version', 'invocation_id', 'outcome', 'error']) || !object(value.error)
        || !keys(value.error, ['code', 'retryable']) || !errorCodes.has(String(value.error.code)) || value.error.retryable !== false) transport();
    } else if (value.outcome === 'ok') {
      if (!keys(value, ['protocol_version', 'invocation_id', 'outcome', 'data', 'receipt']) || !object(value.data)) transport();
      const commit = formalCommit(request.tool, request.arguments);
      if (commit) {
        if (!binding.tools.some(tool => tool.name === request.tool.name && tool.version === request.tool.version && tool.effect === 'write')
          || !(request.protocol_version === 2
            ? receiptV2(value.receipt, request.scope.operation_id, operationBinding(request.tool, { ...request.scope, task_id: request.task_id } as import('./tool-types.ts').RunScope, request.arguments))
            : receipt(value.receipt, request.scope.operation_id) && matchesReceipt(value.receipt, { tool: request.tool, story_id: 'story_id' in request.scope ? request.scope.story_id : undefined, arguments: request.arguments }))) transport();
      } else if ('receipt' in value) transport();
      if (request.protocol_version === 2 && request.tool.version === '2' && request.arguments.mode === 'draft' && !artifactV2(value.data, request.tool.name)) transport();
      if (request.tool.name === 'initialize_story' && request.tool.version === '1' && request.arguments.mode === 'draft') {
        if (!text(value.data.draft_id) || !text(value.data.draft_revision) || !hash(value.data.draft_hash) || !text(value.data.title, 512)
          || value.data.artifact_kind !== 'story_initialization' || typeof value.data.includes_chapter !== 'boolean'
          || value.data.includes_chapter !== ('chapter' in request.arguments)) transport();
      }
    } else transport();
    return value as unknown as CallbackResponse;
  }
  async operation(appId: string, operationId: string, signal: AbortSignal, binding?: OperationBinding): Promise<OperationResponse> {
    const value = await this.#request(appId, 'operations_endpoint', signal, undefined, operationId);
    if (binding?.scope) {
      if (!object(value) || value.protocol_version !== 2 || value.operation_id !== operationId) transport();
      if (value.status === 'committed') {
        if (!keys(value, ['protocol_version', 'operation_id', 'status', 'receipt']) || !receiptV2(value.receipt, operationId, binding)) transport();
      } else if (!['unknown', 'revoked', 'conflict'].includes(String(value.status)) || !keys(value, ['protocol_version', 'operation_id', 'status'])) transport();
      return value as unknown as OperationResponse;
    }
    if (!object(value) || value.protocol_version !== 1 || value.operation_id !== operationId) transport();
    if (value.status === 'committed') {
      if (!keys(value, ['protocol_version', 'operation_id', 'status', 'receipt']) || !receipt(value.receipt, operationId)
        || (binding && !matchesReceipt(value.receipt, binding))) transport();
    } else if (value.status === 'rejected') {
      if (!keys(value, ['protocol_version', 'operation_id', 'status', 'error']) || !object(value.error)
        || !keys(value.error, ['code']) || !errorCodes.has(String(value.error.code))) transport();
    } else if (value.status !== 'not_found' || !keys(value, ['protocol_version', 'operation_id', 'status'])) transport();
    return value as unknown as OperationResponse;
  }
}
