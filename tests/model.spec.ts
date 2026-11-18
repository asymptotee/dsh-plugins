/** The /model command plugin: listing, direct set, ambiguity, the picker
 *  waterfall round trip, and the headless fallback. */

import { describe, expect, it } from 'vitest'
import { applyModel as apply } from '../src/index.ts'
import type { PickerRequest } from '../src/index.ts'

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
  let pickerAnswerer: ((req: PickerRequest) => Promise<unknown>) | undefined
  let lastRequest: PickerRequest | undefined
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
    waterfall: async (_name: string, req: PickerRequest, fallback: () => Promise<unknown>) => {
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
    setPickerAnswerer: (fn: (req: PickerRequest) => Promise<unknown>) => { pickerAnswerer = fn },
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
    expect(await env.invoke('status')).toEqual({ kind: 'success', text: 'Model: Model A (anthropic/model-a)' })
  })

  it('sets an explicit provider/model route', async () => {
    const env = fakeEnv()
    expect(await env.invoke('anthropic/model-b')).toEqual({ kind: 'success', text: 'Model set to Model B (anthropic/model-b)' })
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
    expect(await env.invoke('model-b')).toEqual({ kind: 'success', text: 'Model set to Model B (anthropic/model-b)' })
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
    env.setPickerAnswerer(async () => ({ value: 'other/model-a' }))
    expect(await env.invoke('')).toEqual({ kind: 'success', text: 'Model set to Model A (other) (other/model-a)' })
    expect(env.recorded()).toEqual({ provider: 'other', model: 'model-a' })
    // The request carries every route and the current mark.
    expect(env.lastRequest()?.kind).toBe('list')
    expect(env.lastRequest()?.title).toBe('Model')
    expect(env.lastRequest()?.options).toEqual([
      { value: 'anthropic/model-a', label: 'Model A' },
      { value: 'anthropic/model-b', label: 'Model B', description: 'The slower one' },
      { value: 'other/model-a', label: 'Model A (other)' },
    ])
    expect(env.lastRequest()?.currentIndex).toBe(0)
  })

  it('reports the model kept when the picker cancels', async () => {
    const env = fakeEnv()
    env.setPickerAnswerer(async () => ({ cancelled: true }))
    // Dismissing changes nothing, so the result names what stayed in force.
    expect(await env.invoke('')).toEqual({ kind: 'success', text: 'Kept model as Model A' })
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
    expect(await env.invoke('custom-model')).toEqual({ kind: 'success', text: 'Model set to custom-model (anthropic/custom-model)' })
    expect(env.recorded()).toEqual({ provider: 'anthropic', model: 'custom-model' })
  })
})
describe('gateway-style catalogs (opaque ids, readable names)', () => {
  // A proxy fronting several backends: the id is a routing hash and the name
  // is the only thing a person can read.
  const GATEWAY = [
    { provider: 'ts-deepseek', id: 'mode-7f5c1e7c45b6', name: 'Deepseek-v4.1-flash-1017' },
    { provider: 'ts-pro', id: 'mode-8a8dd030c1ac', name: '高级（Pro）' },
  ]

  it('shows the readable name and keeps the route verifiable', async () => {
    const env = fakeEnv(GATEWAY, { initial: { provider: 'ts-deepseek', model: 'mode-7f5c1e7c45b6' } })
    expect(await env.invoke('status')).toEqual({
      kind: 'success',
      text: 'Model: Deepseek-v4.1-flash-1017 (ts-deepseek/mode-7f5c1e7c45b6)',
    })
  })

  it('labels picker rows with the name and the provider, not the hash', async () => {
    const env = fakeEnv(GATEWAY, { initial: { provider: 'ts-deepseek', model: 'mode-7f5c1e7c45b6' } })
    env.setPickerAnswerer(async () => ({ cancelled: true }))
    await env.invoke('')
    expect(env.lastRequest()?.options).toEqual([
      { value: 'ts-deepseek/mode-7f5c1e7c45b6', label: 'Deepseek-v4.1-flash-1017' },
      { value: 'ts-pro/mode-8a8dd030c1ac', label: '高级（Pro）' },
    ])
  })

  it('falls back to the id when a row declares no distinct name', async () => {
    const env = fakeEnv([{ provider: 'plain', id: 'deepseek-chat', name: 'deepseek-chat' }], {
      initial: { provider: 'plain', model: 'deepseek-chat' },
    })
    expect(await env.invoke('status')).toEqual({
      kind: 'success',
      text: 'Model: deepseek-chat (plain/deepseek-chat)',
    })
  })
})
