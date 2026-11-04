/**
 * Local stand-in for the SDK's `defineTool`.
 *
 * The host resolves `@deepseek-ai/cordis` for plugin bundles, but the runtime
 * SDK packages (`@deepseek-ai/dsh-tools`, `@deepseek-ai/dsh-llm`, …) are not
 * importable from an installed plugin: their value imports fail with
 * `ERR_MODULE_NOT_FOUND` on newer DSH hosts. A registered tool only needs a
 * plain JSON-schema-typed descriptor, so the parameter spec is compiled here
 * and the SDK is imported for types only.
 *
 * @module dsh-teambition/host/tool-spec
 */
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'

/** One parameter of the tool: JSON-schema keywords plus the required flag. */
export interface ToolParameterSpec {
  readonly type: string
  readonly required?: boolean
  readonly enum?: readonly string[]
  readonly description?: string
}

/** Arguments, validation and output of one tool. */
export interface ToolSpec {
  readonly name: string
  readonly description: string
  readonly parameters: Record<string, ToolParameterSpec>
  readonly timeoutMs?: number
  readonly output: {
    readonly schema: Record<string, unknown>
    render(args: unknown, value: unknown): ContentBlock[]
  }
  execute(args: Record<string, unknown>, exec: unknown): Promise<unknown>
}

/**
 * Compile a parameter spec into the registry-ready tool definition.
 * @param spec - declared tool, arguments and output.
 * @returns The same tool with a JSON-schema `parameters` object.
 */
export function defineTool(spec: ToolSpec): ToolDefinition {
  const { parameters, ...rest } = spec
  const properties: Record<string, unknown> = {}
  const required: string[] = []
  for (const [name, parameter] of Object.entries(parameters)) {
    const { required: isRequired, ...schema } = parameter
    properties[name] = schema
    if (isRequired === true) required.push(name)
  }
  const compiled = {
    type: 'object',
    properties,
    ...(required.length === 0 ? {} : { required }),
    additionalProperties: false,
  }
  return { ...rest, parameters: compiled } as unknown as ToolDefinition
}
