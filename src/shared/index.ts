/**
 * Shared building blocks for dsh-plugins: the structural faces commands read
 * upstream services through, and the reasoning-effort vocabulary more than
 * one plugin needs. Structural (no `@deepseek-ai` value imports) so the faces
 * tolerate the pre-stable upstream line without dragging package identities
 * into every plugin.
 * @module dsh-plugins-shared
 */

import type { ReasoningEffortId } from '@deepseek-ai/dsh-llm/brand'

/** The structural face of the `llm` service. */
export interface LlmLike {
  resolveModelInfo(provider: string, model: string): Promise<unknown>
}

/** The `resolveModelInfo` payload this family reads. */
export interface ModelInfoLike {
  context?: { contextWindow: number }
  reasoning?: {
    defaultEffort?: ReasoningEffortId
    efforts?: readonly EffortLevelInfo[]
  }
}

/** One adapter-disclosed reasoning-effort level. */
export interface EffortLevelInfo {
  readonly id: ReasoningEffortId | string
  readonly name?: string
  readonly description?: string
}

/** The structural face of an agent's model selection. */
export interface AgentModelLike {
  current(): { provider: string; model: string; reasoningEffort?: ReasoningEffortId } | undefined
  select(selection: { provider: string; model: string; reasoningEffort?: ReasoningEffortId }): void
}

/** The structural face of one command result. */
export type CommandResultLike =
  | { kind: 'success'; text?: string }
  | { kind: 'error'; text: string }

/**
 * Presentation fallbacks for well-known effort ids: adapters that disclose
 * descriptions win; the rest get standard wording so pickers never show a
 * blank caption (the deepseek adapter discloses them, pi-ai does not).
 */
export const EFFORT_DESCRIPTION_FALLBACKS: Readonly<Record<string, string>> = {
  off: 'Use for simple tasks that do not need reasoning.',
  low: 'Prefer for routine or latency-sensitive tasks.',
  medium: 'A balanced choice for everyday tasks.',
  high: 'The default balance for most tasks.',
  xhigh: 'Deeper reasoning for demanding tasks.',
  max: 'Reserve for the hardest quality-first tasks.',
}

/** The standard effort ladder, weakest to strongest. */
export const STANDARD_EFFORT_LADDER: readonly string[] = ['low', 'medium', 'high', 'xhigh', 'max']

/**
 * Resolve a preferred effort against a route's available levels when the
 * exact one is absent: take the nearest LOWER standard level the route
 * offers, never a higher one — a user who chose `low` must not be pushed up
 * to `high` on a route that lacks it. Unknown ids (custom route levels
 * outside the standard ladder) never participate.
 */
export function nearestLowerEffort(preferred: string, available: readonly string[]): string | undefined {
  if (available.includes(preferred)) return preferred
  const target = STANDARD_EFFORT_LADDER.indexOf(preferred)
  if (target === -1) return undefined
  for (let index = target - 1; index >= 0; index--) {
    const candidate = STANDARD_EFFORT_LADDER[index]
    if (candidate !== undefined && available.includes(candidate)) return candidate
  }
  return undefined
}

/** Fill in a level's description from the fallback table when the adapter
 *  disclosed none, leaving unknown ids blank rather than inventing copy. */
export function withDescription(level: EffortLevelInfo): EffortLevelInfo {
  if (level.description !== undefined) return level
  const fallback = EFFORT_DESCRIPTION_FALLBACKS[level.id as string]
  return fallback === undefined ? level : { ...level, description: fallback }
}