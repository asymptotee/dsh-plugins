/**
 * The `/effort` command for DeepSeek Harness: switches the agent-owned
 * reasoning effort through its model selection. `select()` appends the
 * durable `model/selection` event, so the switch persists across resume and
 * fork exactly like the built-in commands' domain events.
 *
 * `<level>` sets directly, `off` clears back to the model default, and a
 * bare `/effort` opens a picker through the shared `picker/request`
 * waterfall; with no answerer it degrades to a headless text report.
 * @module dsh-plugins/effort
 */

import type { Context } from '@deepseek-ai/cordis'
import { ReasoningEffortId } from '@deepseek-ai/dsh-llm/brand'
// Pulls the commands registry's Context augmentation into this program; the
// register call itself stays structural for version tolerance.
import type {} from '@deepseek-ai/dsh-commands'
import type { AgentModelLike, CommandResultLike, LlmLike, ModelInfoLike } from '../shared/index.ts'
import { nearestLowerEffort, withDescription } from '../shared/index.ts'
import { askPicker, nextPickerId } from '../picker/index.ts'

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
          const currentId = agent.model.current()?.reasoningEffort as string | undefined
          const currentIndex = currentId === undefined ? -1 : availableIds.indexOf(currentId)
          const outcome = await askPicker(ctx as never, {
            pickerId: nextPickerId('effort'),
            kind: 'scale',
            title: 'Effort',
            options: efforts.map(level => {
              const described = withDescription({
                id: level.id as string,
                ...(level.name === undefined ? {} : { name: level.name }),
                ...(level.description === undefined ? {} : { description: level.description }),
              })
              return {
                value: level.id as string,
                label: level.id as string,
                ...(described.description === undefined ? {} : { description: described.description }),
              }
            }),
            ...(currentIndex === -1 ? {} : { currentIndex }),
            scaleEnds: { low: 'Faster', high: 'Smarter' },
            signal,
          })
          if (outcome.kind === 'unanswered') {
            const shown = currentId ?? info?.reasoning?.defaultEffort ?? 'model default'
            return { kind: 'success', text: `Reasoning effort: ${shown} · available: ${availableIds.join(' · ')}` }
          }
          if (outcome.kind === 'cancelled') return { kind: 'success', text: 'Cancelled' }
          const match = efforts.find(level => (level.id as string) === outcome.value)
          if (match === undefined) return { kind: 'error', text: `Unknown effort: ${outcome.value}` }
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