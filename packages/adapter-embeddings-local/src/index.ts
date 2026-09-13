import type { Embedder } from "@cairn/core";

/**
 * An embedding model running inside Cairn's own process, through
 * transformers.js and ONNX Runtime (ADR-022). No service beside the container
 * (ADR-020), no key, no network once the model is on disk.
 *
 * The default model, bge-small-en-v1.5, is English only. Text in other
 * languages still gets keyword search, which is not affected.
 */

export interface LocalModel {
  /** Hugging Face repository with ONNX weights, such as `Xenova/bge-small-en-v1.5`. */
  id: string;
  /** Weight precision. `q8` is a quarter of the size of `fp32`, for a small loss. */
  dtype: "fp32" | "fp16" | "q8";
  pooling: "cls" | "mean";
  /** Put in front of a search query, for models trained with one. */
  queryPrefix: string;
}

/** English only: 384 dimensions, 34 MB at q8, MIT licence. */
export const BGE_SMALL_EN: LocalModel = {
  id: "Xenova/bge-small-en-v1.5",
  dtype: "q8",
  pooling: "cls",
  queryPrefix: "Represent this sentence for searching relevant passages: ",
};

export interface LocalEmbedderOptions {
  model?: LocalModel;
  /** Where model files are kept. Downloaded there the first time if allowed. */
  cacheDir: string;
  /** False in the container image, which ships the model and never fetches. */
  allowDownload?: boolean;
  /**
   * Texts per model call. Memory grows with the batch, because every text is
   * padded to the longest: embedding 1,098 chunks peaked at 312 MB one at a
   * time, 690 MB four at a time and 1.3 GB thirty-two at a time, and one at a
   * time was also the fastest. So 1 (ADR-022).
   */
  batchSize?: number;
  /** ONNX Runtime threads. 1, so background embedding leaves CPU for requests. */
  threads?: number;
}

type Extractor = (
  texts: string[],
  options: { pooling: "cls" | "mean"; normalize: boolean },
) => Promise<{ dims: number[]; data: Float32Array; dispose?: () => void }>;

export class LocalEmbedder implements Embedder {
  readonly model: string;
  dimensions = 0;

  private readonly spec: LocalModel;
  private readonly options: LocalEmbedderOptions;
  private readonly batchSize: number;
  private extractor: (Extractor & { dispose?: () => Promise<void> }) | null = null;

  constructor(options: LocalEmbedderOptions) {
    this.spec = options.model ?? BGE_SMALL_EN;
    this.options = options;
    this.batchSize = Math.max(1, options.batchSize ?? 1);
    this.model = `${this.spec.id} ${this.spec.dtype} ${this.spec.pooling}`;
  }

  async init(): Promise<void> {
    // Loaded on demand, so a Cairn with embeddings off never loads ONNX Runtime.
    const { env, pipeline } = await import("@huggingface/transformers");
    env.cacheDir = this.options.cacheDir;
    env.allowRemoteModels = this.options.allowDownload ?? true;
    const extractor = await pipeline("feature-extraction", this.spec.id, {
      dtype: this.spec.dtype,
      session_options: { intraOpNumThreads: this.options.threads ?? 1 },
    });
    this.extractor = extractor as unknown as Extractor & { dispose?: () => Promise<void> };
    const [probe] = await this.run(["dimensions"]);
    this.dimensions = probe!.length;
  }

  async embedDocuments(texts: string[]): Promise<Float32Array[]> {
    const vectors: Float32Array[] = [];
    for (let i = 0; i < texts.length; i += this.batchSize) {
      vectors.push(...(await this.run(texts.slice(i, i + this.batchSize))));
    }
    return vectors;
  }

  async embedQuery(text: string): Promise<Float32Array> {
    const [vector] = await this.run([this.spec.queryPrefix + text]);
    return vector!;
  }

  async close(): Promise<void> {
    await this.extractor?.dispose?.();
    this.extractor = null;
  }

  private async run(texts: string[]): Promise<Float32Array[]> {
    if (!this.extractor) throw new Error("the embedding model is not loaded");
    const output = await this.extractor(texts, { pooling: this.spec.pooling, normalize: true });
    const width = output.dims[output.dims.length - 1]!;
    const vectors = texts.map((_, i) => output.data.slice(i * width, (i + 1) * width));
    output.dispose?.();
    return vectors;
  }
}
