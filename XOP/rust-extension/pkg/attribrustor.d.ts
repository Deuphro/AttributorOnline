/* tslint:disable */
/* eslint-disable */
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
* Returns a flat vector of [birth, death, birth_idx, death_idx, ...].
* @param {Float64Array} data
* @param {string} mode
* @returns {Float64Array}
*/
export function persistent_homology_0d(data: Float64Array, mode: string): Float64Array;

export type InitInput = RequestInfo | URL | Response | BufferSource | WebAssembly.Module;

export interface InitOutput {
  readonly memory: WebAssembly.Memory;
  readonly compute: (a: number, b: number) => number;
  readonly add: (a: number, b: number) => number;
  readonly arrust: (a: number, b: number, c: number) => void;
  readonly add_scalar: (a: number, b: number, c: number, d: number) => void;
  readonly bench: (a: number) => number;
  readonly sieve: (a: number) => void;
  readonly zeros_matrix: (a: number, b: number) => void;
  readonly persistent_homology_0d: (a: number, b: number, c: number, d: number, e: number) => void;
  readonly __wbindgen_malloc: (a: number, b: number) => number;
  readonly __wbindgen_add_to_stack_pointer: (a: number) => number;
  readonly __wbindgen_free: (a: number, b: number, c: number) => void;
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
