import { operationBinding, assertScopeTools, hash, keys, text } from './free-session.ts';
import { randomUUID } from 'node:crypto';
import type { ToolDefinition } from '@earendil-works/pi-coding-agent';
import type { PiMessage, Usage } from './task-types.ts';
import type { ExecutionInput, RecordExecution } from './tasks.ts';
import { formalCommit, type AppTools } from './app-tools.ts';
import type { CallbackRequest, RunArtifact, ToolInvocation } from './tool-types.ts';

export function toolExecution(input: ExecutionInput, appTools: AppTools, record: RecordExecution, signal: AbortSignal,
  stop: (error: Error) => void) {
  const { run, session } = input;
  const scope = run.input.scope!; const budget = run.input.budget!;
  if (scope.protocol_version === 2) assertScopeTools(scope, session.tools);
  let calls = 0; let responses = 0; let toolCalls = 0; let writeIdentity: string | undefined;
  const draftIds = new Set<string>();
  let usage: Usage | null = null; let usageComplete = true;
  const fail = (code: string): never => { const error = new Error(code); stop(error); throw error; };
  const customTools: ToolDefinition[] = session.tools!.map(tool => ({
    name: tool.name, label: tool.name, description: tool.description,
    parameters: (Array.isArray(tool.parameters.oneOf) ? { ...tool.parameters, type: 'object' } : tool.parameters) as ToolDefinition['parameters'], executionMode: 'sequential',
    async execute(toolCallId, args, toolSignal) {
      signal.throwIfAborted(); toolSignal?.throwIfAborted();
      appTools.validateArguments(tool, args);
      const arguments_ = args as Record<string, unknown>;
      if (scope.protocol_version === 2 && scope.phase === 'resolve' && tool.effect === 'write') fail('forbidden_scope');
      const commit = tool.effect === 'write' && arguments_.mode === 'commit';
      if (scope.protocol_version === 2 && tool.effect === 'write' && arguments_.mode === 'draft' && draftIds.size >= 8) fail('result_too_large');
      if (commit && !formalCommit(tool, arguments_)) fail('tool_version_unavailable');
      if (commit) {
        if (scope.protocol_version === 2) {
          if (!scope.authorization_id) fail('authorization_required');
          const expected = scope.action === 'revise_story_materials' ? 'revise_story_materials' : scope.target?.kind === 'world' ? 'save_world' : scope.target?.kind === 'character' ? 'save_character' : scope.action === 'create_chapter' ? 'create_chapter' : 'initialize_story';
          if (tool.name !== expected || tool.version !== '2') fail('forbidden_scope');
          if (!keys(arguments_, ['mode', 'draft_id', 'draft_revision', 'draft_hash']) || !text(arguments_.draft_id)
            || arguments_.draft_revision !== '1' || !hash(arguments_.draft_hash)) fail('invalid_arguments');
        }
        const identity = JSON.stringify([tool.name, tool.version, arguments_.draft_id, arguments_.draft_revision, arguments_.draft_hash]);
        if (budget.max_write_operations < 1 || (writeIdentity !== undefined && writeIdentity !== identity)) fail('write_operation_limit');
        writeIdentity = identity;
      }
      const invocation: ToolInvocation = { invocation_id: randomUUID(), tool_call_id: toolCallId,
        name: tool.name, status: 'prepared', arguments: structuredClone(arguments_), ...(commit ? { operation_id: scope.operation_id } : {}) };
      await record({ kind: 'invocation', invocation });
      signal.throwIfAborted();
      invocation.status = 'dispatched'; await record({ kind: 'invocation', invocation });
      if (commit) await record({ kind: 'operation', operation: { operation_id: scope.operation_id, status: 'unknown' } });
      const { task_id, ...callbackScope } = scope;
      const request: CallbackRequest = { protocol_version: scope.protocol_version === 2 ? 2 : 1, app_id: run.app_id, session_id: run.session_id, run_id: run.run_id,
        task_id, scope: callbackScope, tool: { name: tool.name, version: tool.version }, tool_call_id: toolCallId,
        invocation_id: invocation.invocation_id, arguments: arguments_ };
      try {
        const response = await appTools.invoke(run.app_id, request, AbortSignal.any([signal, ...(toolSignal ? [toolSignal] : []), AbortSignal.timeout(15000)]));
        invocation.response = response;
        invocation.status = response.outcome === 'ok' ? 'succeeded' : 'rejected';
        await record({ kind: 'invocation', invocation });
        if (response.outcome === 'error') {
          if (commit) await record({ kind: 'operation', operation: { operation_id: scope.operation_id, status: 'rejected', error: { code: response.error.code } } });
          throw new ToolRejected(response.error.code);
        }
        if (commit) {
          if (!response.receipt) throw new Error('tool_transport_failed');
          await record({ kind: 'operation', operation: { operation_id: scope.operation_id, status: 'committed', receipt: response.receipt } });
        }
        if (tool.effect === 'write' && arguments_.mode === 'draft') {
          const data = response.data;
          if (!['draft_id', 'draft_revision', 'draft_hash', 'title'].every(key => typeof data[key] === 'string')) throw new Error('tool_transport_failed');
          if (scope.protocol_version === 2) draftIds.add(data.draft_id as string);
          await record({ kind: 'artifact', artifact: { draft_id: data.draft_id, draft_revision: data.draft_revision, draft_hash: data.draft_hash, title: data.title,
            ...(scope.protocol_version === 2 ? data : {}),
            ...(tool.name === 'initialize_story' && tool.version === '1' ? { artifact_kind: data.artifact_kind, includes_chapter: data.includes_chapter } : {}) } as RunArtifact });
        }
        return { content: [{ type: 'text', text: JSON.stringify(response) }], details: response };
      } catch (error) {
        if (error instanceof ToolRejected) throw new Error(error.message);
        invocation.status = 'unknown'; invocation.error = 'tool_transport_failed';
        await record({ kind: 'invocation', invocation });
        if (commit) {
          // A lost response never grants a new business operation or proves no write occurred.
          try {
            const result = await appTools.operation(run.app_id, scope.operation_id, AbortSignal.any([signal, AbortSignal.timeout(15000)]),
              operationBinding(tool, scope, arguments_));
            if (result.status === 'committed') {
              await record({ kind: 'operation', operation: { operation_id: scope.operation_id, status: 'committed', receipt: result.receipt } });
              return { content: [{ type: 'text', text: JSON.stringify({ outcome: 'ok', receipt: result.receipt, recovered: true }) }], details: result };
            }
            if (result.status === 'revoked' || result.status === 'conflict') await record({ kind: 'operation', operation: { operation_id: scope.operation_id, status: result.status } });
            if (result.status === 'rejected') await record({ kind: 'operation', operation: { operation_id: scope.operation_id, status: 'rejected', error: result.error } });
          } catch { /* The durable unknown record remains the recovery authority. */ }
          fail('tool_result_unknown');
        }
        return fail('tool_transport_failed');
      }
    },
  }));
  return {
    customTools,
    get usage() { return usage; },
    get usageComplete() { return usageComplete; },
    async message(message: PiMessage) {
      const safe = message.role === 'assistant' && message.errorMessage ? { ...message, errorMessage: 'provider_failed' } : message;
      await record({ kind: 'message', message: safe });
      if (message.role !== 'assistant') return;
      if (responses >= calls) return;
      responses++;
      const raw = message.usage;
      if (raw && [raw.input, raw.output, raw.cacheRead, raw.cacheWrite, raw.totalTokens].every(Number.isFinite) && raw.totalTokens > 0) {
        usage ??= { input: 0, output: 0, cache_read: 0, cache_write: 0, total_tokens: 0 };
        usage.input += raw.input; usage.output += raw.output; usage.cache_read += raw.cacheRead;
        usage.cache_write += raw.cacheWrite; usage.total_tokens += raw.totalTokens;
      } else usageComplete = false;
      await record({ kind: 'usage', usage, complete: usageComplete });
      toolCalls += message.content.filter(part => part.type === 'toolCall').length;
      if (scope.protocol_version === 2) await record({ kind: 'execution_usage', model_calls: calls, tool_calls: toolCalls });
      if (toolCalls > budget.max_tool_calls) fail('tool_call_limit');
    },
    async beforeModel(context: unknown, contextWindow: number) {
      signal.throwIfAborted();
      if (calls >= budget.max_model_calls) fail('model_call_limit');
      if (Buffer.byteLength(JSON.stringify(context)) + (run.input.max_output_tokens ?? 4096) + 256 > contextWindow) fail('context_budget_exceeded');
      calls++;
      if (scope.protocol_version === 2) await record({ kind: 'execution_usage', model_calls: calls, tool_calls: toolCalls });
    },
  };
}
class ToolRejected extends Error {}
