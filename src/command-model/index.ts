/**
 * The `/model` command for DeepSeek Harness: switches the agent-owned model
 * route through its model selection. `select()` appends the durable
 * `model/selection` event, so the switch persists across resume and fork; the
 * upstream `installModelSelection` listener narrates the change into the
 * transcript on the next step.
 *
 * `/model <provider>/<model>` (or a bare model id when the route is
 * unambiguous) sets directly, a bare `/model` opens a picker through the
 * shared `picker/request` waterfall, and with no answerer the command
 * degrades to a headless text report. `/model status` reports the route in
 * effect.
 * @module dsh-plugins/model
 */

import type { Context } from '@deepseek-ai/cordis'
// Pulls the commands registry's Context augmentation into this program; the
// register call itself stays structural for version tolerance.
import type {} from '@deepseek-ai/dsh-commands'
import type { AgentModelLike, CommandResultLike } from '../shared/index.ts'
import { askPicker, nextPickerId } from '../picker/index.ts'

/** One discovered route, as this command builds it from the adapter catalog. */
export interface ModelOptionInfo {
  readonly provider: string
  readonly model: string
  readonly name?: string
  readonly description?: string
}

/** The structural face of one discovered model. */
interface ModelInfoLike {
  readonly provider: string
  readonly id: string
  readonly name: string
  readonly description?: string
}

/** The structural face of the `llm` service this command reads. */
interface LlmLike {
  listProviders(): { id: string }[]
  listModels(provider: string): Promise<ModelInfoLike[]>
}

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

/** `provider/model` for display and matching. */
export function routeLabel(provider: string, model: string): string {
  return `${provider}/${model}`
}

/** Every route the mounted adapters advertise, in adapter-preferred order.
 *  A provider whose catalog fails to load is skipped rather than failing the
 *  whole listing (one broken adapter must not hide the others). */
async function discoverRoutes(llm: LlmLike | undefined): Promise<ModelOptionInfo[]> {
  if (llm === undefined || typeof llm.listProviders !== 'function') return []
  const discovered: ModelOptionInfo[] = []
  for (const provider of llm.listProviders()) {
    const models = await llm.listModels(provider.id).catch(() => [])
    for (const model of models) {
      discovered.push({
        provider: model.provider ?? provider.id,
        model: model.id,
        ...(model.name === undefined ? {} : { name: model.name }),
        ...(model.description === undefined ? {} : { description: model.description }),
      })
    }
  }
  return discovered
}

export function apply(ctx: Context): void {
  // The commands registry may mount after this plugin; ctx.inject waits for
  // it the way the built-in command packages do.
  ctx.inject(['commands'], (commandCtx) => {
    const commands = commandCtx.commands as unknown as CommandsLike
    commands.register({
      name: 'model',
      description: 'Show or switch the model route',
      input: { hint: '[provider/]<model>|status' },
      handler: async ({ agent, rawInput, signal }) => {
        const wanted = rawInput.trim()
        const current = agent.model.current()
        const currentLabel = current === undefined ? undefined : routeLabel(current.provider, current.model)

        // The shared tail: apply through the agent-owned selection. The
        // effort carried by the outgoing route is dropped — a level the new
        // route may not offer must not ride along silently.
        const applyRoute = (provider: string, model: string): CommandResultLike => {
          agent.model.select({ provider, model })
          return { kind: 'success', text: `Model set to ${routeLabel(provider, model)}` }
        }

        if (wanted === 'status') {
          return currentLabel === undefined
            ? { kind: 'error', text: 'No model selection is recorded for this session.' }
            : { kind: 'success', text: `Model: ${currentLabel}` }
        }

        const llm = ctx.get('llm') as LlmLike | undefined
        if (wanted === '') {
          // Bare /model: an interactive pick when a frontend answers the
          // waterfall, a headless report when none is mounted.
          const models = await discoverRoutes(llm)
          if (models.length === 0) return { kind: 'error', text: 'No models disclosed by the mounted adapters' }
          const currentIndex = currentLabel === undefined
            ? -1
            : models.findIndex(option => routeLabel(option.provider, option.model) === currentLabel)
          const outcome = await askPicker(ctx as never, {
            pickerId: nextPickerId('model'),
            kind: 'list',
            title: 'Model',
            options: models.map(option => ({
              value: routeLabel(option.provider, option.model),
              label: routeLabel(option.provider, option.model),
              // A display name that merely repeats the id adds nothing.
              ...(option.name === undefined || option.name === option.model || option.name === routeLabel(option.provider, option.model)
                ? {}
                : { note: option.name }),
              ...(option.description === undefined ? {} : { description: option.description }),
            })),
            ...(currentIndex === -1 ? {} : { currentIndex }),
            signal,
          })
          if (outcome.kind === 'unanswered') {
            const shown = currentLabel ?? 'unset'
            const listed = models.map(option => routeLabel(option.provider, option.model)).join(' · ')
            return { kind: 'success', text: `Model: ${shown} · available: ${listed}` }
          }
          if (outcome.kind === 'cancelled') return { kind: 'success', text: 'Cancelled' }
          const picked = models.find(option => routeLabel(option.provider, option.model) === outcome.value)
          if (picked === undefined) return { kind: 'error', text: `Unknown model: ${outcome.value}` }
          return applyRoute(picked.provider, picked.model)
        }

        // A direct set: an explicit `provider/model`, else a bare model id
        // resolved against the catalog (unambiguous only).
        const models = await discoverRoutes(llm)
        const slash = wanted.indexOf('/')
        if (slash > 0) {
          const provider = wanted.slice(0, slash)
          const model = wanted.slice(slash + 1)
          if (model === '') return { kind: 'error', text: `Usage: /model [provider/]<model>` }
          // Validate against the catalog when one is available: an unknown
          // route is a typo far more often than an intentional escape.
          if (models.length > 0 && !models.some(option => option.provider === provider && option.model === model)) {
            const known = models.map(option => routeLabel(option.provider, option.model)).join(' · ')
            return { kind: 'error', text: `Unknown model: ${wanted} · available: ${known}` }
          }
          return applyRoute(provider, model)
        }
        const matches = models.filter(option => option.model === wanted)
        if (matches.length === 1) {
          const only = matches[0]!
          return applyRoute(only.provider, only.model)
        }
        if (matches.length > 1) {
          const providers = matches.map(option => option.provider).join(' · ')
          return { kind: 'error', text: `Ambiguous model "${wanted}" offered by: ${providers} — use provider/${wanted}` }
        }
        if (models.length === 0) {
          // No catalog: trust the bare id as a route on the current provider.
          return current === undefined
            ? { kind: 'error', text: 'No model selection is recorded for this session.' }
            : applyRoute(current.provider, wanted)
        }
        const known = models.map(option => routeLabel(option.provider, option.model)).join(' · ')
        return { kind: 'error', text: `Unknown model: ${wanted} · available: ${known}` }
      },
    })
  })
}