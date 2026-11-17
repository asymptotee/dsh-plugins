/** The /model command plugin: listing, direct set, ambiguity, the picker
 *  waterfall round trip, and the headless fallback. */

import { describe, expect, it } from 'vitest'
import { applyModel as apply } from '../src/index.ts'
import type { ModelPickRequest } from '../src/index.ts'

interface RegisteredDef {
  name: string
  description: string
  handler(invocation: { agent: unknown; rawInput: string; signal: AbortSignal }): Promise<{ kind: string; text?: string }>
}

interface Selection {
  provider: string
  model: string
  reasoningEffort?: string
}

const CATALOG = [
  { provider: 'anthropic', id: 'model-a', name: 'Model A' },
  { provider: 'anthropic', id: 'model-b', name: 'Model B', description: 'The slower one' },
  { provider: 'other', id: 'model-a', name: 'Model A (other)' },
]

function fakeEnv(
  catalog: readonly { provider: string; id: string; name: string; description?: string }[] = CATALOG,
  opts: { initial?: Selection | undefined; listFails?: boolean } = {},
) {
  let recorded: Selection | undefined = opts.initial === undefined
    ? { provider: 'anthropic', model: 'model-a' }
    : opts.initial
  const agent = {
    model: {
      current: () => recorded,
      select: (next: Selection) => { recorded = next },
    },
  }
  const registered: RegisteredDef[] = []
  let pickerAnswerer: ((req: ModelPickRequest) => Promise<unknown>) | undefined
  let lastRequest: ModelPickRequest | undefined
  const ctx = {
    inject: (_deps: readonly string[], cb: (c: { commands: { register(def: RegisteredDef): void } }) => void) => {
      cb({ commands: { register: (def: RegisteredDef) => registered.push(def) } })
    },
    get: (name: string) => (name === 'llm'
      ? {
        listProviders: () => [...new Set(catalog.map(entry => entry.provider))].map(id => ({ id })),
        listModels: async (provider: string) => {
          if (opts.listFails === true) throw new Error('adapter down')
          return catalog.filter(entry => entry.provider === provider)
        },
      }
      : undefined),
    waterfall: async (_name: string, req: ModelPickRequest, fallback: () => Promise<unknown>) => {
      lastRequest = req
      return pickerAnswerer === undefined ? fallback() : pickerAnswerer(req)
    },
  }
  apply(ctx as never)
  const invoke = (rawInput: string): Promise<{ kind: string; text?: string }> =>
    registered[0]!.handler({ agent, rawInput, signal: new AbortController().signal })
  return {
    invoke,
    def: () => registered[0]!,
    recorded: () => recorded,
    lastRequest: () => lastRequest,
    setPickerAnswerer: (fn: (req: ModelPickRequest) => Promise<unknown>) => { pickerAnswerer = fn },
  }
}

describe('/model command plugin', () => {
  it('registers the command with its discovery metadata', () => {
    const env = fakeEnv()
    expect(env.def().name).toBe('model')
    expect(env.def().description).toBe('Show or switch the model route')
  })

  it('reports the route in effect with status', async () => {
    const env = fakeEnv()
    expect(await env.invoke('status')).toEqual({ kind: 'success', text: 'Model: anthropic/model-a' })
  })

  it('sets an explicit provider/model route', async () => {
    const env = fakeEnv()
    expect(await env.invoke('anthropic/model-b')).toEqual({ kind: 'success', text: 'Model set to anthropic/model-b' })
    expect(env.recorded()).toEqual({ provider: 'anthropic', model: 'model-b' })
  })

  it('drops the outgoing effort when the route changes', async () => {
    // The new route may not offer the old level; it must not ride along.
    const env = fakeEnv(CATALOG, { initial: { provider: 'anthropic', model: 'model-a', reasoningEffort: 'high' } })
    await env.invoke('anthropic/model-b')
    expect(env.recorded()?.reasoningEffort).toBeUndefined()
  })

  it('resolves a bare model id when exactly one provider offers it', async () => {
    const env = fakeEnv()
    expect(await env.invoke('model-b')).toEqual({ kind: 'success', text: 'Model set to anthropic/model-b' })
    expect(env.recorded()).toEqual({ provider: 'anthropic', model: 'model-b' })
  })

  it('refuses an ambiguous bare model id and names the providers', async () => {
    const env = fakeEnv()
    expect(await env.invoke('model-a')).toEqual({
      kind: 'error',
      text: 'Ambiguous model "model-a" offered by: anthropic · other — use provider/model-a',
    })
    // The recorded route is untouched.
    expect(env.recorded()).toEqual({ provider: 'anthropic', model: 'model-a' })
  })

  it('rejects an unknown route with the catalog', async () => {
    const env = fakeEnv()
    expect(await env.invoke('anthropic/nope')).toEqual({
      kind: 'error',
      text: 'Unknown model: anthropic/nope · available: anthropic/model-a · anthropic/model-b · other/model-a',
    })
  })

  it('picks through the waterfall answerer', async () => {
    const env = fakeEnv()
    env.setPickerAnswerer(async () => ({ provider: 'other', model: 'model-a' }))
    expect(await env.invoke('')).toEqual({ kind: 'success', text: 'Model set to other/model-a' })
    expect(env.recorded()).toEqual({ provider: 'other', model: 'model-a' })
    // The request carries every route and the current mark.
    expect(env.lastRequest()?.models).toEqual([
      { provider: 'anthropic', model: 'model-a', name: 'Model A' },
      { provider: 'anthropic', model: 'model-b', name: 'Model B', description: 'The slower one' },
      { provider: 'other', model: 'model-a', name: 'Model A (other)' },
    ])
    expect(env.lastRequest()?.current).toBe('anthropic/model-a')
  })

  it('reports Cancelled when the picker cancels', async () => {
    const env = fakeEnv()
    env.setPickerAnswerer(async () => ({ cancelled: true }))
    expect(await env.invoke('')).toEqual({ kind: 'success', text: 'Cancelled' })
    expect(env.recorded()).toEqual({ provider: 'anthropic', model: 'model-a' })
  })

  it('falls back to the headless report with no answerer', async () => {
    const env = fakeEnv()
    expect(await env.invoke('')).toEqual({
      kind: 'success',
      text: 'Model: anthropic/model-a · available: anthropic/model-a · anthropic/model-b · other/model-a',
    })
  })

  it('survives an adapter whose catalog fails to load', async () => {
    // A broken provider must not hide the others: with every catalog failing
    // the command reports no disclosure rather than throwing.
    const env = fakeEnv(CATALOG, { listFails: true })
    expect(await env.invoke('')).toEqual({ kind: 'error', text: 'No models disclosed by the mounted adapters' })
  })

  it('trusts a bare id on the current provider when no catalog exists', async () => {
    const env = fakeEnv([])
    expect(await env.invoke('custom-model')).toEqual({ kind: 'success', text: 'Model set to anthropic/custom-model' })
    expect(env.recorded()).toEqual({ provider: 'anthropic', model: 'custom-model' })
  })
})