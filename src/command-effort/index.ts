/**
 * The `/effort` command for DeepSeek Harness: switches the agent-owned
 * reasoning effort through its model selection. `select()` appends the
 * durable `model/selection` event, so the switch persists across resume and
 * fork exactly like the built-in commands' domain events.
 *
 * `<level>` sets directly, `off` clears back to the model default, and a
 * bare `/effort` dispatches the `effort-picker/request` waterfall: a mounted
 * frontend answers it with an interactive selection, and with no answerer the
 * command degrades to a headless text report.
 * @module dsh-command-effort
 */

import type { Context } from '@deepseek-ai/cordis'
import { ReasoningEffortId } from '@deepseek-ai/dsh-llm/brand'
// Pulls the commands registry's Context augmentation into this program; the
// register call itself stays structural for version tolerance.
import type {} from '@deepseek-ai/dsh-commands'
import type { AgentModelLike, CommandResultLike, EffortLevelInfo, LlmLike, ModelInfoLike } from '../shared/index.ts'
import { nearestLowerEffort, withDescription } from '../shared/index.ts'
import type { EffortPickRequest } from './types.ts'

export type { EffortLevelInfo, EffortPickAnswer, EffortPickRequest } from './types.ts'

interface AgentLike {
  model: AgentModelLike
}

interface CommandInvocationLike {
  agent: AgentLike
  rawInput: string
  signal: AbortSignal
}

interface CommandsLike {
  register(definition: {
    name: string
    description: string
    input?: { hint?: string }
    handler(invocation: CommandInvocationLike): Promise<CommandResultLike> | CommandResultLike
  }): unknown
}

export function apply(ctx: Context): void {
  // The commands registry may mount after this plugin; ctx.inject waits for
  // it the way the built-in command packages do.
  ctx.inject(['commands'], (commandCtx) => {
    const commands = commandCtx.commands as unknown as CommandsLike
    commands.register({
      name: 'effort',
      description: 'Set the reasoning effort',
      input: { hint: '<level>|off' },
      handler: async ({ agent, rawInput, signal }) => {
        const wanted = rawInput.trim()
        const route = agent.model.current()
        const info = route === undefined
          ? undefined
          : (await (ctx.get('llm') as LlmLike | undefined)
            ?.resolveModelInfo(route.provider, route.model)
            .catch(() => undefined)) as ModelInfoLike | undefined
        const efforts = info?.reasoning?.efforts ?? []
        const availableIds = efforts.map(level => level.id as string)

        // The shared tail: apply (or clear) through the agent-owned selection.
        // The appended model/selection event is the durable record.
        const applySelection = (level: ReasoningEffortId | undefined): CommandResultLike => {
          const base = agent.model.current()
          if (base === undefined) return { kind: 'error', text: 'No model selection is recorded for this session.' }
          agent.model.select(level === undefined
            ? { provider: base.provider, model: base.model }
            : { provider: base.provider, model: base.model, reasoningEffort: level })
          return {
            kind: 'success',
            text: level === undefined
              ? 'Reasoning effort cleared (model default).'
              : `Reasoning effort set to ${level}`,
          }
        }

        if (wanted === '') {
          // Bare /effort: an interactive pick when a frontend answers the
          // waterfall, a headless report when none is mounted.
          if (efforts.length === 0) return { kind: 'error', text: 'No effort levels disclosed for this model' }
          const levels: EffortLevelInfo[] = efforts.map(level => withDescription({
            id: level.id as string,
            ...(level.name === undefined ? {} : { name: level.name }),
            ...(level.description === undefined ? {} : { description: level.description }),
          }))
          const currentId = agent.model.current()?.reasoningEffort as string | undefined
          const request: EffortPickRequest = {
            agent,
            levels,
            ...(currentId === undefined ? {} : { current: currentId }),
            signal,
          }
          const answer = await ctx.waterfall('effort-picker/request', request, () => Promise.resolve(undefined))
          if (answer === undefined) {
            const shown = currentId ?? info?.reasoning?.defaultEffort ?? 'model default'
            return {
              kind: 'success',
              text: `Reasoning effort: ${shown} · available: ${availableIds.join(' · ')}`,
            }
          }
          if ('cancelled' in answer) return { kind: 'success', text: 'Cancelled' }
          const match = efforts.find(level => (level.id as string) === answer.level)
          if (match === undefined) return { kind: 'error', text: `Unknown effort: ${answer.level}` }
          return applySelection(match.id as ReasoningEffortId)
        }

        const clearing = wanted === 'off' || wanted === 'none' || wanted === 'default'
        if (!clearing) {
          const match = efforts.find(level => (level.id as string) === wanted || level.name === wanted)
          if (efforts.length > 0 && match === undefined) {
            // An unavailable tier falls to the nearest LOWER standard level —
            // never up — so a `low` preference is not pushed to `high`.
            const fallback = nearestLowerEffort(wanted, availableIds)
            if (fallback === undefined) {
              const known = availableIds.join(' · ')
              return { kind: 'error', text: `Unknown effort: ${wanted}${known === '' ? '' : ` · available: ${known}`}` }
            }
            return applySelection(ReasoningEffortId(fallback))
          }
          return applySelection(match?.id as ReasoningEffortId | undefined ?? ReasoningEffortId(wanted))
        }
        return applySelection(undefined)
      },
    })
  })
}