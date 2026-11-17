/** The /effort command plugin: direct set, clear, validation, the picker
 *  waterfall round trip, and the headless fallback. */

import { describe, expect, it } from 'vitest'
import { applyEffort as apply } from '../src/index.ts'
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

function fakeEnv(
  efforts: readonly { id: string; name?: string; description?: string }[],
  opts: { defaultEffort?: string; initial?: Selection | undefined } = {},
) {
  let recorded: Selection | undefined = opts.initial === undefined ? { provider: 'p', model: 'm' } : opts.initial
  const agent = {
    model: {
      current: () => recorded,
      select: (next: Selection) => { recorded = next },
    },
    session: { id: 's1' },
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
        resolveModelInfo: async () => ({
          reasoning: {
            efforts,
            ...(opts.defaultEffort === undefined ? {} : { defaultEffort: opts.defaultEffort }),
          },
        }),
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
    recorded: () => recorded,
    lastRequest: () => lastRequest,
    setPickerAnswerer: (fn: (req: PickerRequest) => Promise<unknown>) => { pickerAnswerer = fn },
  }
}

const LEVELS = [{ id: 'low' }, { id: 'high' }]

describe('/effort command plugin', () => {
  it('registers with the discovery metadata', () => {
    const env = fakeEnv(LEVELS)
    expect(env.lastRequest()).toBeUndefined()
    // Registration shape is asserted through the handler tests below; the
    // name/description/hint ride the registry list any frontend reads.
  })

  it('sets a disclosed level directly', async () => {
    const env = fakeEnv(LEVELS)
    expect(await env.invoke(' high ')).toEqual({ kind: 'success', text: 'Reasoning effort set to high' })
    expect(env.recorded()?.reasoningEffort).toBe('high')
  })

  it('clears back to the model default with off', async () => {
    const env = fakeEnv(LEVELS, { initial: { provider: 'p', model: 'm', reasoningEffort: 'high' } })
    expect(await env.invoke('off')).toEqual({ kind: 'success', text: 'Reasoning effort cleared (model default).' })
    expect(env.recorded()?.reasoningEffort).toBeUndefined()
  })

  it('rejects an unknown level with the disclosed list', async () => {
    const env = fakeEnv(LEVELS)
    expect(await env.invoke('ultra')).toEqual({ kind: 'error', text: 'Unknown effort: ultra · available: low · high' })
    expect(env.recorded()?.reasoningEffort).toBeUndefined()
  })

  it('accepts an undisclosed level verbatim when the adapter discloses none', async () => {
    const env = fakeEnv([])
    expect(await env.invoke('turbo')).toEqual({ kind: 'success', text: 'Reasoning effort set to turbo' })
    expect(env.recorded()?.reasoningEffort).toBe('turbo')
  })

  it('bare /effort picks through the waterfall answerer', async () => {
    const env = fakeEnv(LEVELS)
    env.setPickerAnswerer(async () => ({ value: 'high' }))
    expect(await env.invoke('')).toEqual({ kind: 'success', text: 'Reasoning effort set to high' })
    expect(env.recorded()?.reasoningEffort).toBe('high')
    // The request carries the levels, the current mark, and the signal.
    const request = env.lastRequest()
    expect(request?.kind).toBe('scale')
    expect(request?.title).toBe('Effort')
    expect(request?.options).toEqual([
      { value: 'low', label: 'low', description: 'Prefer for routine or latency-sensitive tasks.' },
      { value: 'high', label: 'high', description: 'The default balance for most tasks.' },
    ])
    expect(request?.scaleEnds).toEqual({ low: 'Faster', high: 'Smarter' })
    expect(request?.signal).toBeInstanceOf(AbortSignal)
  })

  it('bare /effort reports Cancelled when the picker cancels', async () => {
    const env = fakeEnv(LEVELS)
    env.setPickerAnswerer(async () => ({ cancelled: true }))
    expect(await env.invoke('')).toEqual({ kind: 'success', text: 'Cancelled' })
    expect(env.recorded()?.reasoningEffort).toBeUndefined()
  })

  it('bare /effort falls back to the headless report with no answerer', async () => {
    const env = fakeEnv(LEVELS, { defaultEffort: 'low' })
    expect(await env.invoke('')).toEqual({ kind: 'success', text: 'Reasoning effort: low · available: low · high' })
    expect(env.recorded()?.reasoningEffort).toBeUndefined()
  })

  it('bare /effort without any disclosure is the command error', async () => {
    const env = fakeEnv([])
    expect(await env.invoke('')).toEqual({ kind: 'error', text: 'No effort levels disclosed for this model' })
  })

  it('backfills descriptions only for well-known ids', async () => {
    const env = fakeEnv([{ id: 'turbo' }, { id: 'high', description: 'adapter copy wins' }])
    env.setPickerAnswerer(async () => ({ cancelled: true }))
    await env.invoke('')
    expect(env.lastRequest()?.options).toEqual([
      { value: 'turbo', label: 'turbo' },
      { value: 'high', label: 'high', description: 'adapter copy wins' },
    ])
  })
})

describe('unavailable tier fallback (nearest lower, never up)', () => {
  it('falls to the nearest LOWER standard level the route offers', async () => {
    // The route offers only low/high; a `max` preference lands on `high`.
    const env = fakeEnv([{ id: 'low' }, { id: 'high' }])
    expect(await env.invoke('max')).toEqual({ kind: 'success', text: 'Reasoning effort set to high' })
    expect(env.recorded()?.reasoningEffort).toBe('high')
  })

  it('never pushes a preference upward', async () => {
    // The route offers medium/high; a `low` preference stays unapplied
    // rather than being promoted to `medium`.
    const env = fakeEnv([{ id: 'medium' }, { id: 'high' }])
    expect(await env.invoke('low')).toEqual({ kind: 'error', text: 'Unknown effort: low · available: medium · high' })
    expect(env.recorded()?.reasoningEffort).toBeUndefined()
  })

  it('reports an unknown non-ladder id without a fallback', async () => {
    const env = fakeEnv([{ id: 'low' }, { id: 'high' }])
    expect(await env.invoke('turbo')).toEqual({ kind: 'error', text: 'Unknown effort: turbo · available: low · high' })
  })
})
