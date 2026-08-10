/**
 * ONNX Runtime session lifecycle.
 *
 * Sessions are expensive to create (weights are parsed and graph-optimised) and
 * cheap to reuse, so there is exactly one per model per process, created lazily
 * and shared. `InferenceSession.run` is safe to call concurrently on one
 * session; the worker pool relies on that rather than holding a session per
 * thread, which would multiply memory by the worker count.
 *
 * The in-flight promise cache matters: several worker threads calling
 * `getSession('pose')` at the same instant must await one load, not start three.
 */

import fs from 'fs'
import path from 'path'
import * as ort from 'onnxruntime-node'
import { MODELS, type ModelId, type ModelSpec } from '@/vision/model-registry'

export interface SessionOptions {
  modelDir: string
  /** ORT intra-op thread count. 0 lets ORT choose. */
  threads?: number
}

export interface LoadedSession {
  session: ort.InferenceSession
  spec: ModelSpec
  inputNames: readonly string[]
  outputNames: readonly string[]
}

export class OnnxSessionManager {
  private readonly loaded = new Map<ModelId, LoadedSession>()
  private readonly loading = new Map<ModelId, Promise<LoadedSession | null>>()
  private readonly errors = new Map<ModelId, string>()

  constructor(private readonly options: SessionOptions) {}

  modelPath(id: ModelId): string {
    return path.join(this.options.modelDir, MODELS[id].file)
  }

  /** Cheap presence check — does not read or validate the file. */
  isPresent(id: ModelId): boolean {
    return fs.existsSync(this.modelPath(id))
  }

  /**
   * Load a model, or return null when it is absent or fails to load.
   *
   * Returning null rather than throwing is deliberate: `face` and
   * `segmentation` are optional, and the engine degrades to a documented
   * reduced capability instead of failing the whole analysis. Callers that
   * require a model check for null explicitly.
   */
  async get(id: ModelId): Promise<LoadedSession | null> {
    const existing = this.loaded.get(id)
    if (existing) return existing

    const inFlight = this.loading.get(id)
    if (inFlight) return inFlight

    const promise = this.load(id).finally(() => this.loading.delete(id))
    this.loading.set(id, promise)
    return promise
  }

  private async load(id: ModelId): Promise<LoadedSession | null> {
    const spec = MODELS[id]
    const file = this.modelPath(id)

    if (!fs.existsSync(file)) {
      this.errors.set(
        id,
        `model file not found: ${file} — run \`npm run models:fetch\``
      )
      return null
    }

    try {
      const session = await ort.InferenceSession.create(file, {
        executionProviders: ['cpu'],
        // 'all' enables constant folding and layout optimisation. It costs a
        // few hundred ms once at load and pays back on every inference.
        graphOptimizationLevel: 'all',
        // Sequential execution keeps CPU contention predictable: parallelism
        // comes from running several images at once across worker threads, not
        // from splitting one graph, which would oversubscribe the box.
        executionMode: 'sequential',
        ...(this.options.threads && this.options.threads > 0
          ? { intraOpNumThreads: this.options.threads }
          : {}),
      })

      const entry: LoadedSession = {
        session,
        spec,
        inputNames: session.inputNames,
        outputNames: session.outputNames,
      }
      this.loaded.set(id, entry)
      this.errors.delete(id)
      return entry
    } catch (err: any) {
      this.errors.set(id, `failed to load ${spec.file}: ${err?.message ?? err}`)
      return null
    }
  }

  error(id: ModelId): string | null {
    return this.errors.get(id) ?? null
  }

  loadedVersions(): Record<string, string> {
    const out: Record<string, string> = {}
    for (const [id, entry] of this.loaded) out[id] = entry.spec.version
    return out
  }

  async dispose(): Promise<void> {
    for (const entry of this.loaded.values()) {
      // release() exists on the Node binding but is not in every typings
      // version; it is a no-op to skip, the process exit reclaims either way.
      await (entry.session as any).release?.().catch?.(() => {})
    }
    this.loaded.clear()
    this.errors.clear()
  }
}

/** Build an NCHW float32 tensor. */
export function tensor(data: Float32Array, dims: number[]): ort.Tensor {
  return new ort.Tensor('float32', data, dims)
}

/** Read an output tensor as Float32Array regardless of its declared type. */
export function asFloat32(value: ort.Tensor | undefined): Float32Array {
  if (!value) return new Float32Array(0)
  const data = value.data
  if (data instanceof Float32Array) return data
  return Float32Array.from(data as ArrayLike<number>)
}
