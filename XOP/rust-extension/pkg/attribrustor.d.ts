/* tslint:disable */
/* eslint-disable */
/**
* Computes one H0 interval per input point. `core` is canonical:
* [x0..xN, y0..yN] for stride 2, or [y0..yN] for stride 1.
* Superlevel activates points by decreasing Y; sublevel by increasing Y.
* @param {Float64Array} core
* @param {number} stride
* @param {string} mode
* @returns {PersistenceAnalysis}
*/
export function persistent_homology_0d_waves(core: Float64Array, stride: number, mode: string): PersistenceAnalysis;
/**
* @param {Float64Array} births
* @param {Float64Array} deaths
* @param {Float64Array} points_x
* @param {Float64Array} points_y
* @param {number} slope
* @returns {PersistenceClassification}
*/
export function classify_persistence_0d(births: Float64Array, deaths: Float64Array, points_x: Float64Array, points_y: Float64Array, slope: number): PersistenceClassification;
/**
* @param {number} a
* @param {number} b
* @returns {number}
*/
export function compute(a: number, b: number): number;
/**
* @param {number} a
* @param {number} b
* @returns {number}
*/
export function add(a: number, b: number): number;
/**
* @param {Float64Array} data
*/
export function arrust(data: Float64Array): void;
/**
* @param {Float64Array} data
* @param {number} scalar
*/
export function add_scalar(data: Float64Array, scalar: number): void;
/**
* @param {bigint} n
* @returns {bigint}
*/
export function bench(n: bigint): bigint;
/**
* @returns {string}
*/
export function sieve(): string;
/**
* @param {number} n
* @returns {Int32Array}
*/
export function zeros_matrix(n: number): Int32Array;
/**
* Computes 0D persistent homology on a 1D sequence of values (Y values).
* Supports sublevel (default) and superlevel set filtration.
* Returns a flat, non-interleaved vector with four contiguous blocks:
* [births..., deaths..., birth_indices..., death_indices...].
* @param {Float64Array} data
* @param {string} mode
* @returns {Float64Array}
*/
export function persistent_homology_0d(data: Float64Array, mode: string): Float64Array;
/**
*/
export class PersistenceAnalysis {
  free(): void;
/**
*/
  readonly birth_indices: Float64Array;
/**
*/
  readonly births: Float64Array;
/**
*/
  readonly deaths: Float64Array;
/**
*/
  readonly points_x: Float64Array;
/**
*/
  readonly points_y: Float64Array;
/**
*/
  readonly slope: number;
}
/**
*/
export class PersistenceClassification {
  free(): void;
/**
*/
  readonly discarded_births: Float64Array;
/**
*/
  readonly discarded_deaths: Float64Array;
/**
*/
  readonly kept_births: Float64Array;
/**
*/
  readonly kept_count: number;
/**
*/
  readonly kept_deaths: Float64Array;
/**
*/
  readonly kept_points_x: Float64Array;
/**
*/
  readonly kept_points_y: Float64Array;
}

export type InitInput = RequestInfo | URL | Response | BufferSource | WebAssembly.Module;

export interface InitOutput {
  readonly memory: WebAssembly.Memory;
  readonly __wbg_persistenceanalysis_free: (a: number) => void;
  readonly persistenceanalysis_births: (a: number, b: number) => void;
  readonly persistenceanalysis_deaths: (a: number, b: number) => void;
  readonly persistenceanalysis_points_x: (a: number, b: number) => void;
  readonly persistenceanalysis_points_y: (a: number, b: number) => void;
  readonly persistenceanalysis_birth_indices: (a: number, b: number) => void;
  readonly persistenceanalysis_slope: (a: number) => number;
  readonly __wbg_persistenceclassification_free: (a: number) => void;
  readonly persistenceclassification_kept_births: (a: number, b: number) => void;
  readonly persistenceclassification_kept_count: (a: number) => number;
  readonly persistent_homology_0d_waves: (a: number, b: number, c: number, d: number, e: number) => number;
  readonly classify_persistence_0d: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number, i: number) => number;
  readonly persistenceclassification_kept_deaths: (a: number, b: number) => void;
  readonly persistenceclassification_kept_points_x: (a: number, b: number) => void;
  readonly persistenceclassification_kept_points_y: (a: number, b: number) => void;
  readonly persistenceclassification_discarded_births: (a: number, b: number) => void;
  readonly persistenceclassification_discarded_deaths: (a: number, b: number) => void;
  readonly compute: (a: number, b: number) => number;
  readonly add: (a: number, b: number) => number;
  readonly arrust: (a: number, b: number, c: number) => void;
  readonly add_scalar: (a: number, b: number, c: number, d: number) => void;
  readonly bench: (a: number) => number;
  readonly sieve: (a: number) => void;
  readonly zeros_matrix: (a: number, b: number) => void;
  readonly persistent_homology_0d: (a: number, b: number, c: number, d: number, e: number) => void;
  readonly __wbindgen_add_to_stack_pointer: (a: number) => number;
  readonly __wbindgen_free: (a: number, b: number, c: number) => void;
  readonly __wbindgen_malloc: (a: number, b: number) => number;
  readonly __wbindgen_realloc: (a: number, b: number, c: number, d: number) => number;
}

export type SyncInitInput = BufferSource | WebAssembly.Module;
/**
* Instantiates the given `module`, which can either be bytes or
* a precompiled `WebAssembly.Module`.
*
* @param {SyncInitInput} module
*
* @returns {InitOutput}
*/
export function initSync(module: SyncInitInput): InitOutput;

/**
* If `module_or_path` is {RequestInfo} or {URL}, makes a request and
* for everything else, calls `WebAssembly.instantiate` directly.
*
* @param {InitInput | Promise<InitInput>} module_or_path
*
* @returns {Promise<InitOutput>}
*/
export default function __wbg_init (module_or_path?: InitInput | Promise<InitInput>): Promise<InitOutput>;
