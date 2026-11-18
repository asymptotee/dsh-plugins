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

/** `provider/model` — the technical route, for matching and for the
 *  parenthetical that lets a reader verify where a request actually goes. */
export function routeLabel(provider: string, model: string): string {
  return `${provider}/${model}`
}

/** What a person sees for one route: the adapter's human-readable name when
 *  it has one distinct from the id, else the id itself. Adapters fronting a
 *  gateway often use opaque ids (`mode-7f5c…`) and carry the readable name
 *  separately, so display code must never assume the id is legible. */
export function modelDisplayName(option: { provider: string; model: string; name?: string }): string {
  const name = option.name
  // A name equal to the id (or to the whole route) adds nothing.
  if (name === undefined || name === '' || name === option.model || name === routeLabel(option.provider, option.model)) {
    return option.model
  }
  return name
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
        const applyRoute = (provider: string, model: string, name?: string): CommandResultLike => {
          agent.model.select({ provider, model })
          const label = modelDisplayName({ provider, model, ...(name === undefined ? {} : { name }) })
          return { kind: 'success', text: `Model set to ${label} (${routeLabel(provider, model)})` }
        }

        const llm = ctx.get('llm') as LlmLike | undefined
        // `currentLabel` is the technical route; the catalog turns it into
        // the readable name when one is advertised.
        const routes = await discoverRoutes(llm)
        const currentOption = currentLabel === undefined
          ? undefined
          : routes.find(option => routeLabel(option.provider, option.model) === currentLabel)
        const currentDisplay = current === undefined
          ? undefined
          : modelDisplayName({ ...current, ...(currentOption?.name === undefined ? {} : { name: currentOption.name }) })
        if (wanted === 'status') {
          return currentDisplay === undefined || currentLabel === undefined
            ? { kind: 'error', text: 'No model selection is recorded for this session.' }
            : { kind: 'success', text: `Model: ${currentDisplay} (${currentLabel})` }
        }

        if (wanted === '') {
          // Bare /model: an interactive pick when a frontend answers the
          // waterfall, a headless report when none is mounted.
          const models = routes
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
              // The readable name alone: the provider column added a second
              // identifier to read on every row without telling a person
              // anything they act on. `⎿` keeps the full route for verification.
              label: modelDisplayName(option),
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
          // Dismissing the picker changes nothing, so the result says what
          // stayed in force rather than a bare "Cancelled" — the reader gets
          // the answer they opened the picker to find.
          if (outcome.kind === 'cancelled') {
            return {
              kind: 'success',
              text: currentDisplay === undefined
                ? 'Cancelled'
                : `Kept model as ${currentDisplay}`,
            }
          }
          const picked = models.find(option => routeLabel(option.provider, option.model) === outcome.value)
          if (picked === undefined) return { kind: 'error', text: `Unknown model: ${outcome.value}` }
          return applyRoute(picked.provider, picked.model, picked.name)
        }

        // A direct set: an explicit `provider/model`, else a bare model id
        // resolved against the catalog (unambiguous only).
        const models = routes
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
          return applyRoute(provider, model, routes.find(option => option.provider === provider && option.model === model)?.name)
        }
        const matches = models.filter(option => option.model === wanted)
        if (matches.length === 1) {
          const only = matches[0]!
          return applyRoute(only.provider, only.model, only.name)
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