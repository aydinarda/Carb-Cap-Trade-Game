import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { RlModelInfo } from '../../shared/types'
import { featuresFor, RL_MODES, type RlMode } from './observe'

/**
 * Trained RL policies the host can put into a game, read from `server/rl/models/*.json`.
 *
 * A model file is written by the local training kit (`rl/export_policy.py`). It holds the
 * policy network's actor (dense layers and a linear head) and the observation normaliser it
 * was trained behind, so the server runs it with plain arithmetic: no Python, no ML runtime.
 *
 * A file is only offered when it is safe to run, and otherwise listed with the reason:
 *  - its feature list must match what `./observe.ts` builds for its mode, name for name,
 *    because this folder holds a COPY of the training code and the two can drift;
 *  - it must reproduce the reference actions Python computed when it was exported.
 */

type Activation = 'tanh' | 'relu' | 'linear'

export interface ModelFile {
  format: 1
  id: string
  label: string
  mode: RlMode
  /** The observation features the policy was trained on, in vector order. */
  features: string[]
  env: { round_seconds: number; agent_every_seconds: number }
  source?: {
    run?: string
    which?: string
    steps_trained?: number | null
    best_at?: number | null
    exported_at?: string
  }
  /** Base64 little-endian float64 running mean and variance, as VecNormalize kept them. */
  normalizer: { mean: string; var: string; clip: number; epsilon: number }
  /** Base64 little-endian float32, weight rows of `out × in`. */
  layers: { in: number; out: number; activation: Activation; weight: string; bias: string }[]
  /** Raw observations and the deterministic actions Python produced for them. */
  check: { obs: number[][]; action: number[][] }
}

export interface LoadedModel {
  info: RlModelInfo
  /** Null when the model cannot run on this server; `info.error` says why. */
  policy: Policy | null
  /** The decision clock it was trained with. */
  everyMs: number
  decisionsPerWindow: number
}

const ACTION_DIM = 4
/** Largest gap allowed from the exported actions: float32 and float64 arithmetic differ near 1e-6. */
const CHECK_TOLERANCE = 1e-4
const ACTIVATIONS: Activation[] = ['tanh', 'relu', 'linear']
/** How long a label may be: agents are named `RL <label> <n>` within the 40-character name limit. */
const LABEL_MAX = 24

function decodeFloats(b64: string, bytes: 4 | 8): number[] {
  const buf = Buffer.from(b64, 'base64')
  if (buf.length % bytes !== 0) throw new Error('a weight block is not a whole number of floats')
  const out: number[] = new Array(buf.length / bytes)
  for (let i = 0; i < out.length; i++) {
    out[i] = bytes === 4 ? buf.readFloatLE(i * 4) : buf.readDoubleLE(i * 8)
  }
  return out
}

/** The actor of a trained policy, evaluated deterministically. */
export class Policy {
  readonly obsDim: number
  private readonly mean: Float64Array
  private readonly scale: Float64Array
  private readonly clipObs: number
  private readonly layers: {
    in: number
    out: number
    activation: Activation
    weight: Float64Array
    bias: Float64Array
  }[]

  constructor(file: Pick<ModelFile, 'normalizer' | 'layers'>) {
    const mean = decodeFloats(file.normalizer.mean, 8)
    const variance = decodeFloats(file.normalizer.var, 8)
    if (mean.length !== variance.length) throw new Error('normaliser mean and variance differ in length')
    this.obsDim = mean.length
    this.mean = Float64Array.from(mean)
    this.scale = Float64Array.from(variance, (v) => 1 / Math.sqrt(v + file.normalizer.epsilon))
    this.clipObs = file.normalizer.clip

    let width = this.obsDim
    this.layers = file.layers.map((layer, i) => {
      const weight = decodeFloats(layer.weight, 4)
      const bias = decodeFloats(layer.bias, 4)
      if (layer.in !== width || weight.length !== layer.in * layer.out || bias.length !== layer.out) {
        throw new Error(`layer ${i + 1} does not fit: it should take ${width} inputs`)
      }
      if (!ACTIVATIONS.includes(layer.activation)) {
        throw new Error(`layer ${i + 1} uses an unsupported activation "${layer.activation}"`)
      }
      width = layer.out
      return { ...layer, weight: Float64Array.from(weight), bias: Float64Array.from(bias) }
    })
    if (width !== ACTION_DIM) {
      throw new Error(`the policy outputs ${width} numbers but the agent acts on ${ACTION_DIM}`)
    }
  }

  /** The mean of the policy's action distribution, clipped to the action space, as SB3's `predict`. */
  act(obs: readonly number[]): number[] {
    if (obs.length !== this.obsDim) {
      throw new Error(`observation has ${obs.length} features, the policy takes ${this.obsDim}`)
    }
    let x = new Float64Array(this.obsDim)
    for (let i = 0; i < this.obsDim; i++) {
      const z = (obs[i] - this.mean[i]) * this.scale[i]
      x[i] = Math.max(-this.clipObs, Math.min(this.clipObs, z))
    }
    for (const layer of this.layers) {
      const y = new Float64Array(layer.out)
      for (let o = 0; o < layer.out; o++) {
        const row = o * layer.in
        let sum = layer.bias[o]
        for (let i = 0; i < layer.in; i++) sum += layer.weight[row + i] * x[i]
        y[o] =
          layer.activation === 'tanh' ? Math.tanh(sum) : layer.activation === 'relu' ? Math.max(0, sum) : sum
      }
      x = y
    }
    return Array.from(x, (v) => Math.max(-1, Math.min(1, v)))
  }
}

/** Validates a parsed model file. Never throws: a file that cannot run comes back with `error` set. */
export function modelFromFile(raw: unknown, fallbackId: string): LoadedModel {
  const file = (raw ?? {}) as Partial<ModelFile>
  const id = typeof file.id === 'string' && /^[a-z0-9][a-z0-9-]*$/.test(file.id) ? file.id : fallbackId
  const label =
    typeof file.label === 'string' && file.label.trim() ? file.label.trim().slice(0, LABEL_MAX) : id.slice(0, LABEL_MAX)
  const mode = RL_MODES.includes(file.mode as RlMode) ? (file.mode as RlMode) : null
  const info: RlModelInfo = {
    id,
    label,
    mode,
    checkpoint: file.source?.which ?? null,
    stepsTrained: file.source?.steps_trained ?? null,
    error: null,
  }
  const refuse = (error: string): LoadedModel => ({
    info: { ...info, error },
    policy: null,
    everyMs: 0,
    decisionsPerWindow: 0,
  })

  if (file.format !== 1) return refuse(`unsupported model file format ${String(file.format)}`)
  if (!mode) return refuse(`unknown mode "${String(file.mode)}"`)

  const expected = featuresFor(mode).map((f) => f.name)
  const trained = Array.isArray(file.features) ? file.features : []
  if (trained.length !== expected.length) {
    return refuse(
      `trained on ${trained.length} observation features, but this server builds ${expected.length} for ${mode}`,
    )
  }
  const differs = expected.findIndex((name, i) => trained[i] !== name)
  if (differs !== -1) {
    return refuse(
      `observation feature ${differs + 1} is "${trained[differs]}" in the model but "${expected[differs]}" here; ` +
        'server/rl/observe.ts and the training copy have drifted',
    )
  }

  const every = Number(file.env?.agent_every_seconds)
  const round = Number(file.env?.round_seconds)
  if (!(every > 0) || !(round >= every)) return refuse('the model file has no usable decision timing')

  let policy: Policy
  try {
    policy = new Policy(file as ModelFile)
  } catch (error) {
    return refuse(`damaged weights: ${error instanceof Error ? error.message : String(error)}`)
  }
  if (policy.obsDim !== expected.length) {
    return refuse(`the normaliser covers ${policy.obsDim} features, not ${expected.length}`)
  }

  const check = file.check
  if (!check || !Array.isArray(check.obs) || check.obs.length === 0 || check.obs.length !== check.action?.length) {
    return refuse('the model file carries no reference actions to verify against')
  }
  for (let k = 0; k < check.obs.length; k++) {
    const got = policy.act(check.obs[k])
    const gap = Math.max(...got.map((v, i) => Math.abs(v - Number(check.action[k][i]))))
    if (!(gap <= CHECK_TOLERANCE)) {
      return refuse(`does not reproduce the actions it was exported with (off by ${gap.toExponential(1)})`)
    }
  }

  return {
    info,
    policy,
    everyMs: every * 1000,
    decisionsPerWindow: Math.max(1, Math.floor(round / every + 1e-9)),
  }
}

/**
 * Where model files live: an explicit `RL_MODELS_DIR`, next to this module when the server runs
 * from source, then the repo path, which is where the bundled server (`dist/server/index.js`,
 * started from the repo root) finds them.
 */
function modelsDir(): string | null {
  const here = path.dirname(fileURLToPath(import.meta.url))
  const candidates = [process.env.RL_MODELS_DIR, path.join(here, 'models'), path.resolve(process.cwd(), 'server', 'rl', 'models')]
  for (const dir of candidates) if (dir && existsSync(dir)) return dir
  return null
}

/** The folder is listed at most this often: the host snapshot asks on every lobby flush. */
const RESCAN_MS = 5_000
/** Parsed files, reused until the file on disk changes. */
const parsed = new Map<string, { stamp: string; model: LoadedModel }>()
let cached: { at: number; models: Map<string, LoadedModel> } | null = null

function scan(): Map<string, LoadedModel> {
  const out = new Map<string, LoadedModel>()
  const dir = modelsDir()
  if (!dir) return out
  for (const name of readdirSync(dir).filter((n) => n.endsWith('.json')).sort()) {
    const full = path.join(dir, name)
    const stat = statSync(full)
    const stamp = `${stat.mtimeMs}:${stat.size}`
    let entry = parsed.get(full)
    if (!entry || entry.stamp !== stamp) {
      const fallbackId = name.replace(/\.json$/, '').toLowerCase().replace(/[^a-z0-9-]/g, '-')
      let model: LoadedModel
      try {
        model = modelFromFile(JSON.parse(readFileSync(full, 'utf8')), fallbackId)
      } catch (error) {
        model = modelFromFile({ id: fallbackId }, fallbackId)
        model.info.error = `unreadable model file: ${error instanceof Error ? error.message : String(error)}`
      }
      entry = { stamp, model }
      parsed.set(full, entry)
    }
    const { model } = entry
    if (out.has(model.info.id)) {
      out.set(`${model.info.id}:${name}`, {
        ...model,
        info: { ...model.info, error: `another model file already uses the id "${model.info.id}"` },
        policy: null,
      })
    } else {
      out.set(model.info.id, model)
    }
  }
  return out
}

function models(now = Date.now()): Map<string, LoadedModel> {
  if (!cached || now - cached.at > RESCAN_MS) cached = { at: now, models: scan() }
  return cached.models
}

/** Every model file on this server, usable or not. */
export function listModels(): RlModelInfo[] {
  return [...models().values()].map((m) => m.info)
}

export function getModel(id: string): LoadedModel | undefined {
  return models().get(id)
}
