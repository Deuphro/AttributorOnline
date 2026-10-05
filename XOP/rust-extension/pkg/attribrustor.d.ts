/* tslint:disable */
/* eslint-disable */
/**
* LE KERNEL: le crible mixte du nœud, avec la sélection par pic à l'intérieur.
*
* Les tableaux viennent du plan et sont déjà triés; le kernel ne les retrie pas.
* Il rend un `Vec<Reading>` de TAILLE FIXE — au plus `masses.len() * best_matches`
* — quel que soit l'espace exploré. C'est le point: le JS rendait TOUS les
* états, et c'est ce tableau-là qui épuisait la mémoire du navigateur.
* @param {Float64Array} item_masses
* @param {Float64Array} item_charges
* @param {Float64Array} log_probs
* @param {Uint32Array} caps
* @param {Float64Array} masses
* @param {number} max_mass
* @param {number} min_mass
* @param {number} ppm
* @param {number} best_matches
* @param {any} plan
* @returns {(Reading)[]}
*/
export function crible_mixed_radix(item_masses: Float64Array, item_charges: Float64Array, log_probs: Float64Array, caps: Uint32Array, masses: Float64Array, max_mass: number, min_mass: number, ppm: number, best_matches: number, plan: any): (Reading)[];
/**
* Les bornes de multiplicité ne sont PAS calculées ici.
*
* Elles viennent de `AttributionPlan.capsFor`, en JS, et c'est la seule façon
* d'avoir raison: la borne d'un ADDUCT dépend de la FENÊTRE D'IONISATION, que
* seul le plan connaît. Une brique est bornée par `maxMass // mass`; un adduit
* est borné par la charge maximale autorisée, parce qu'un [2+] en fenêtre ±10
* donnerait sinon un volume absurde.
*
* Le calcul ici serait un second endroit où décider, donc un second endroit où
* se tromper — et l'erreur serait invisible: le crible rendrait des
* combinaisons, dans le mauvais ordre peut-être, sans qu'aucun test le voie.
*
* `caps_for` a longtemps existé ici et faisait ce calcul. Elle a été retirée
* après qu'un test eut Tourné en boucle indéfiniment: un adduit SANS ATOME a
* une masse négative, donc `maxMass / mass` est négatif, donc `max(0)` donne
* 0… et un `[2+]` en fenêtre ±3 rendait zéro combinaison, alors qu'il est
* l'adduit le plus utile d'un plan. La borne par la charge ne se devine pas
* depuis les masses, et c'est exactement pour ça qu'elle vit dans le plan.
* Le crible exhaustif, par tas.
*
* * `item_masses` la masse de chaque brique: somme des atomes pour une brique
*   de masse, masse de l'ION pour un adduit
* * `item_charges` la charge de chaque brique; 0 pour une brique de masse
* * `caps` la multiplicité maximale de chaque brique, calculée par le plan
* * `max_mass` le plafond de masse totale
* * `limit` le nombre maximal d'états rendus
*
* La sortie est un `Vec<f64>` PLAT de `STRIDE` valeurs par état, dans l'ordre
* du tas — donc par masse croissante. Un seul `Vec` et non un struct à getters:
* c'est le format que le projet utilise partout (`fkmd`,
* `persistent_homology_0d`), il n'alloue rien côté JS, et il évite le `Copy`
* que `#[wasm_bindgen(getter)]` exige sur un champ `Vec` dans la version de
* wasm-bindgen d'ici.
*
* La charge totale d'un état est la SOMME des charges des briques employées, et
* c'est elle que la fenêtre d'ionisation filtrera côté JS. Le kernel ne connaît
* pas la fenêtre: il rend ce qui existe, et le shell décide ce qui compte — la
* même séparation que partout ailleurs dans le projet.
*
* Le plafond borne à la fois le nombre de COPIES d'une brique et la somme. La
* masse ne peut qu'augmenter en ajoutant une brique, donc un état trop lourd ne
* peut jamais s'alléger en remontant, et l'élagage est sûr.
* @param {Float64Array} item_masses
* @param {Float64Array} item_charges
* @param {Uint32Array} caps
* @param {number} max_mass
* @param {number} limit
* @returns {Float64Array}
*/
export function crible_heap(item_masses: Float64Array, item_charges: Float64Array, caps: Uint32Array, max_mass: number, limit: number): Float64Array;
/**
* L'arbre couvrant de poids minimal sur des points MESURÉS.
*
* `masses` doit être TRIÉ par masse croissante — c'est ce qui autorise l'arrêt
* précoce de la boucle des paires, et le seul prérequis que la fonction ne
* peut pas vérifier elle-même sans payer un tri qu'elle ne sera pas amenée à
* faire. C'est donc un CONTRAT, et il est écrit ici parce qu'un contrat non
* écrit est un bug qui n'apparaît qu'à l'écran.
*
* `intensities` sert au composant le plus intense, comme le `wavemax(roi1)`
* d'Igor. `standards` sont des masses EN M/Z: la comparaison se fait donc dans
* l'espace mesuré, et c'est à l'appelant de diviser par la charge —
* `forest.js` le fait, à partir des briques du plan.
*
* `degree_max` plafonne le degré d'un sommet; `<= 0` ou non fini signifie
* « aucun plafond », ce qui est le `degmax=inf` de `GrowForest`.
*
* `limit` est LA COUPURE: combien de candidats, dans l'ordre des poids
* croissants, Kruskal est autorisé à consommer. `<= 0` les prend tous — c'est le
* `GrowForest` d'Igor. C'est ici, et nulle part ailleurs, que la coupure agit:
* l'arbre se construit par dessus un PRÉFIXE de la liste triée, donc changer la
* coupure ne change que le nombre d'arêtes considérées, jamais leur ordre.
* @param {Float64Array} masses
* @param {Float64Array} intensities
* @param {Float64Array} standards
* @param {number} tolerance
* @param {number} degree_max
* @param {number} limit
* @returns {Forest}
*/
export function forest_grow(masses: Float64Array, intensities: Float64Array, standards: Float64Array, tolerance: number, degree_max: number, limit: number): Forest;
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
* `points_index` is the position of each point in the INPUT wave (the
* birth_indices of persistent_homology_0d_waves, already sorted and aligned
* with the points). It is carried through the classifier untouched: the slope
* decides WHICH points survive, never where they came from.
* @param {Float64Array} births
* @param {Float64Array} deaths
* @param {Float64Array} points_x
* @param {Float64Array} points_y
* @param {Float64Array} points_index
* @param {number} slope
* @param {Float64Array} integrated_mass
* @param {Float64Array} centroid_x
* @returns {PersistenceClassification}
*/
export function classify_persistence_0d(births: Float64Array, deaths: Float64Array, points_x: Float64Array, points_y: Float64Array, points_index: Float64Array, slope: number, integrated_mass: Float64Array, centroid_x: Float64Array): PersistenceClassification;
/**
* Where the SELECTED method wants the low cursor to sit, as a single number.
*
* Deliberately returns one f64 and allocates nothing: the shell only needs the
* threshold, and the previous design had it call the full trim and throw away
* every kept point but that number - three vectors built, three clones out of
* wasm, megabytes through postMessage, all discarded.
*
* An unknown method name falls back to passthrough (an infinite low bound),
* so a stale front end still resolves its flow.
* @param {Float64Array} core
* @param {number} stride
* @param {string} method
* @param {number} k
* @param {number} window
* @param {number} threshold
* @returns {number}
*/
export function trim_guess(core: Float64Array, stride: number, method: string, k: number, window: number, threshold: number): number;
/**
* Applies the two bounds and returns the surviving points. This is a pure
* primitive: it knows NOTHING about methods, parameters or guesses. Where the
* bounds come from is the shell's business (trim_guess, or the user dragging a
* cursor), which is what keeps the two roles from getting confused.
* @param {Float64Array} core
* @param {number} stride
* @param {number} low_bound
* @param {number} high_bound
* @returns {TrimResult}
*/
export function trim_apply(core: Float64Array, stride: number, low_bound: number, high_bound: number): TrimResult;
/**
* Histogram of the wave values, in the same "binned value / count" shape the
* trimmer frame already draws. `scale` is "linear" (evenly spaced values) or
* "log" (evenly spaced DECADES, i.e. log10 of the value).
*
* A linear histogram of a spectrum spanning five orders of magnitude is
* useless: every bar piles into the first one and the rest is empty. Binning
* evenly in log10 gives one bar per decade fraction, which is what makes the
* distribution readable.
*
* In log mode the bar CENTRES are geometric means, so that a log-scaled value
* axis spaces the bars evenly on screen. Non-positive values have no log10 and
* are left out of the log histogram; `dropped` reports how many, so the shell
* can say so instead of silently showing a distribution that does not add up.
* @param {Float64Array} core
* @param {number} stride
* @param {number} bins
* @param {string} scale
* @returns {TrimHistogram}
*/
export function trim_histogram(core: Float64Array, stride: number, bins: number, scale: string): TrimHistogram;
/**
* A z READ FROM THE DATA, which is a different thing from the 3σ convention.
*
* The MAD is a spread; the cut has to be somewhere. When the widths form one
* population the two agree, but when a spectrum is MOSTLY radio - a dirty
* sample, a failed acquisition - the MAD is inflated by the very peaks the
* filter should catch, and 3σ then rejects nothing. A gap does not have that
* failure mode: it measures where the bulk ends whatever lies beyond.
*
* The cut is read as the largest gap between consecutive sorted widths, in
* robust sigma, and only when that gap is far larger than the typical spacing
* between neighbours. Two earlier attempts are worth recording, because both
* are plausible and both are wrong:
*   - a fixed quantile (90th) lands INSIDE the tight cluster when there is one
*     wide peak in eight, and reports a z of about 1, which would reject the
*     whole cluster;
*   - a ratio to the median width is not scale-free - a comb of near-identical
*     peaks has a vanishing MAD, and the ratio to the outlier explodes.
* @param {Float64Array} core
* @param {number} stride
* @param {Float64Array} points_index
* @returns {number}
*/
export function anti_radio_guess_z(core: Float64Array, stride: number, points_index: Float64Array): number;
/**
*
* `z` is the ONE knob, and it is a statistical convention rather than a fitted
* setting: a peak is "radio" when its width sits z robust sigma above the
* median width of the spectrum. Since the reference is measured on the data in
* hand, the filter follows the instrument's actual resolution instead of a
* hard-coded one, and the false-positive rate stays a property of the spread
* rather than of how many peaks the spectrum happens to contain.
* @param {Float64Array} core
* @param {number} stride
* @param {Float64Array} points_x
* @param {Float64Array} points_y
* @param {Float64Array} points_index
* @param {number} z
* @returns {RadioDecision}
*/
export function anti_radio_filter(core: Float64Array, stride: number, points_x: Float64Array, points_y: Float64Array, points_index: Float64Array, z: number): RadioDecision;
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
* Applies the F-KMD transform to a canonical core.
*
* Returns a FLAT, non-interleaved `[x'0..x'N, y'0..y'N]` — the same layout the
* input came in, so the shell can hand it straight to `Wave.fromCoordinates`
* without a second reshape.
*
* The output y is the DEFECT, and the input y (the intensities) is not carried
* over: the caller asked for one value per point, and the defect is that value.
* Intensities stay reachable on the input wave, which the caller still holds.
* @param {Float64Array} core
* @param {number} mz
* @returns {Float64Array}
*/
export function fkmd(core: Float64Array, mz: number): Float64Array;
/**
* Ce que rend `forest_grow`.
*
* Les tableaux sont PLATS et non entrelacés: c'est la forme que le worker
* transporte et que `toFloat64` rend directement. Les composants sont ORDONNÉS
* par taille décroissante puis par indice de sommet croissant — le même tri que
* le `Sort2D(...,1,1,-1)` d'Igor, rendu déterministe.
*/
export class Forest {
  free(): void;
/**
* Combien de paires ont trouvé une référence. C'est le DIAGNOSTIC qui
* compte: le nombre d'arêtes possibles avant le tri et le plafond de degré,
* donc il dit si un composant est pauvre par absence de liens ou par abandon.
*/
  readonly candidates: number;
/**
*/
  readonly component_count: number;
/**
*/
  readonly component_max_intensity: Float64Array;
/**
* Le rang du composant de chaque point, dans les tableaux de composants.
*/
  readonly component_of: Float64Array;
/**
*/
  readonly component_peak_mass: Float64Array;
/**
*/
  readonly component_root: Float64Array;
/**
* La masse du sommet le plus LÉGER du composant — l'ancêtre qu'Igor
* prenait dans `roipnts[0]`, et donc celui qu'il attribuait.
*/
  readonly component_root_mass: Float64Array;
/**
*/
  readonly component_size: Float64Array;
/**
* Le poids TOTAL de l'arbre du composant: la somme des erreurs de ses
* arêtes. C'est la grandeur que l'on compare entre deux lectures du même
* spectre, et ce n'est PAS la somme des poids de toutes les arêtes
* candidates — seulement de celles que Kruskal a gardées.
*/
  readonly component_weight: Float64Array;
/**
* Où s'arrête l'arbre: combien de candidats Kruskal a consommés. Inférieur
* à `candidates` quand la coupure a mordu, égal sinon.
*/
  readonly cut_used: number;
/**
*/
  readonly degree: Float64Array;
/**
*/
  readonly edge_count: number;
/**
* L'indice, dans la liste des RÉFÉRENCES, de celle qui a matché l'arête.
* C'est ce qui permet à l'écran d'écrire « CH2 » sur un lien sans que le
* noyau ait jamais su ce qu'est une formule.
*/
  readonly edge_standard: Float64Array;
/**
*/
  readonly edge_u: Float64Array;
/**
*/
  readonly edge_v: Float64Array;
/**
*/
  readonly edge_weight: Float64Array;
/**
*/
  readonly isolated: number;
/**
* LA COURBE: tous les poids, triés. C'est ce que le panneau trace, et ce
* sur quoi se règle la coupure.
*/
  readonly weights: Float64Array;
}
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
  readonly centroid_x: Float64Array;
/**
*/
  readonly deaths: Float64Array;
/**
*/
  readonly integrated_mass: Float64Array;
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
  readonly kept_centroid_x: Float64Array;
/**
*/
  readonly kept_count: number;
/**
*/
  readonly kept_deaths: Float64Array;
/**
*/
  readonly kept_indices: Float64Array;
/**
*/
  readonly kept_integrated_mass: Float64Array;
/**
*/
  readonly kept_points_x: Float64Array;
/**
*/
  readonly kept_points_y: Float64Array;
}
/**
* A candidate peak reduced to what the filter decides on.
*/
export class RadioDecision {
  free(): void;
/**
*/
  readonly indices: Float64Array;
/**
*/
  readonly is_radio: Uint8Array;
/**
*/
  readonly kept_count: number;
/**
*/
  readonly points_x: Float64Array;
/**
*/
  readonly points_y: Float64Array;
/**
*/
  readonly reference_ppm: number;
/**
*/
  readonly threshold_ppm: number;
/**
*/
  readonly widths_ppm: Float64Array;
}
/**
* Ce que le kernel rend, par lecture gardée.
*
* `peak` est l'INDICE du point le plus proche dans le tableau de masses,
* `error_ppm` l'écart signé, et `counts` les multiplicités — les « coefficients
* du radix », qui suffisent à JS pour reconstruire la formule sans refaire le
* crible.
*/
export class Reading {
  free(): void;
/**
*/
  readonly charge: number;
/**
*/
  readonly counts: Uint32Array;
/**
*/
  readonly error_ppm: number;
/**
*/
  readonly log_probability: number;
/**
*/
  readonly mass: number;
/**
*/
  readonly peak: number;
}
/**
* One histogram bar: the graph needs centres and counts, nothing else.
*/
export class TrimHistogram {
  free(): void;
/**
*/
  readonly centres: Float64Array;
/**
*/
  readonly counts: Float64Array;
/**
*/
  readonly dropped: number;
/**
*/
  readonly max: number;
/**
*/
  readonly min: number;
}
/**
* A trimmed wave. Deliberately minimal: the bounds are echoed for the shell,
* but nothing method-related lives here, because trim_apply is a pure
* two-bounds primitive.
*/
export class TrimResult {
  free(): void;
/**
*/
  readonly high_bound: number;
/**
*/
  readonly kept_count: number;
/**
*/
  readonly kept_indices: Float64Array;
/**
*/
  readonly low_bound: number;
/**
*/
  readonly points_x: Float64Array;
/**
*/
  readonly points_y: Float64Array;
/**
*/
  readonly total_count: number;
}

export type InitInput = RequestInfo | URL | Response | BufferSource | WebAssembly.Module;

export interface InitOutput {
  readonly memory: WebAssembly.Memory;
  readonly __wbg_reading_free: (a: number) => void;
  readonly reading_peak: (a: number) => number;
  readonly reading_error_ppm: (a: number) => number;
  readonly reading_log_probability: (a: number) => number;
  readonly reading_mass: (a: number) => number;
  readonly reading_charge: (a: number) => number;
  readonly reading_counts: (a: number, b: number) => void;
  readonly crible_mixed_radix: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number, i: number, j: number, k: number, l: number, m: number, n: number, o: number, p: number) => void;
  readonly crible_heap: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number, i: number) => void;
  readonly __wbg_forest_free: (a: number) => void;
  readonly forest_edge_u: (a: number, b: number) => void;
  readonly forest_edge_v: (a: number, b: number) => void;
  readonly forest_edge_weight: (a: number, b: number) => void;
  readonly forest_edge_standard: (a: number, b: number) => void;
  readonly forest_degree: (a: number, b: number) => void;
  readonly forest_component_of: (a: number, b: number) => void;
  readonly forest_component_root: (a: number, b: number) => void;
  readonly forest_component_size: (a: number, b: number) => void;
  readonly forest_component_max_intensity: (a: number, b: number) => void;
  readonly forest_component_weight: (a: number, b: number) => void;
  readonly forest_component_root_mass: (a: number, b: number) => void;
  readonly forest_component_peak_mass: (a: number, b: number) => void;
  readonly forest_candidates: (a: number) => number;
  readonly forest_weights: (a: number, b: number) => void;
  readonly forest_cut_used: (a: number) => number;
  readonly forest_isolated: (a: number) => number;
  readonly forest_edge_count: (a: number) => number;
  readonly forest_component_count: (a: number) => number;
  readonly forest_grow: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number, i: number) => number;
  readonly __wbg_persistenceanalysis_free: (a: number) => void;
  readonly persistenceanalysis_births: (a: number, b: number) => void;
  readonly persistenceanalysis_deaths: (a: number, b: number) => void;
  readonly persistenceanalysis_points_x: (a: number, b: number) => void;
  readonly persistenceanalysis_points_y: (a: number, b: number) => void;
  readonly persistenceanalysis_birth_indices: (a: number, b: number) => void;
  readonly persistenceanalysis_slope: (a: number) => number;
  readonly persistenceanalysis_integrated_mass: (a: number, b: number) => void;
  readonly persistenceanalysis_centroid_x: (a: number, b: number) => void;
  readonly __wbg_persistenceclassification_free: (a: number) => void;
  readonly persistenceclassification_kept_births: (a: number, b: number) => void;
  readonly persistenceclassification_discarded_deaths: (a: number, b: number) => void;
  readonly persistenceclassification_kept_count: (a: number) => number;
  readonly persistent_homology_0d_waves: (a: number, b: number, c: number, d: number, e: number) => number;
  readonly classify_persistence_0d: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number, i: number, j: number, k: number, l: number, m: number, n: number, o: number) => number;
  readonly persistenceclassification_kept_deaths: (a: number, b: number) => void;
  readonly persistenceclassification_kept_points_x: (a: number, b: number) => void;
  readonly persistenceclassification_kept_points_y: (a: number, b: number) => void;
  readonly persistenceclassification_kept_indices: (a: number, b: number) => void;
  readonly persistenceclassification_kept_integrated_mass: (a: number, b: number) => void;
  readonly persistenceclassification_kept_centroid_x: (a: number, b: number) => void;
  readonly persistenceclassification_discarded_births: (a: number, b: number) => void;
  readonly __wbg_trimresult_free: (a: number) => void;
  readonly trimresult_points_x: (a: number, b: number) => void;
  readonly trimresult_points_y: (a: number, b: number) => void;
  readonly trimresult_kept_indices: (a: number, b: number) => void;
  readonly trimresult_total_count: (a: number) => number;
  readonly __wbg_trimhistogram_free: (a: number) => void;
  readonly trimhistogram_centres: (a: number, b: number) => void;
  readonly trimhistogram_counts: (a: number, b: number) => void;
  readonly trimhistogram_min: (a: number) => number;
  readonly trimhistogram_max: (a: number) => number;
  readonly trimhistogram_dropped: (a: number) => number;
  readonly trim_guess: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number) => number;
  readonly trim_apply: (a: number, b: number, c: number, d: number, e: number) => number;
  readonly trim_histogram: (a: number, b: number, c: number, d: number, e: number, f: number) => number;
  readonly trimresult_low_bound: (a: number) => number;
  readonly trimresult_high_bound: (a: number) => number;
  readonly trimresult_kept_count: (a: number) => number;
  readonly __wbg_radiodecision_free: (a: number) => void;
  readonly radiodecision_points_x: (a: number, b: number) => void;
  readonly radiodecision_points_y: (a: number, b: number) => void;
  readonly radiodecision_indices: (a: number, b: number) => void;
  readonly radiodecision_widths_ppm: (a: number, b: number) => void;
  readonly radiodecision_is_radio: (a: number, b: number) => void;
  readonly radiodecision_kept_count: (a: number) => number;
  readonly radiodecision_reference_ppm: (a: number) => number;
  readonly radiodecision_threshold_ppm: (a: number) => number;
  readonly anti_radio_guess_z: (a: number, b: number, c: number, d: number, e: number) => number;
  readonly anti_radio_filter: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number, i: number, j: number) => number;
  readonly compute: (a: number, b: number) => number;
  readonly add: (a: number, b: number) => number;
  readonly arrust: (a: number, b: number, c: number) => void;
  readonly add_scalar: (a: number, b: number, c: number, d: number) => void;
  readonly bench: (a: number) => number;
  readonly sieve: (a: number) => void;
  readonly zeros_matrix: (a: number, b: number) => void;
  readonly persistent_homology_0d: (a: number, b: number, c: number, d: number, e: number) => void;
  readonly fkmd: (a: number, b: number, c: number, d: number) => void;
  readonly __wbindgen_add_to_stack_pointer: (a: number) => number;
  readonly __wbindgen_free: (a: number, b: number, c: number) => void;
  readonly __wbindgen_malloc: (a: number, b: number) => number;
  readonly __wbindgen_realloc: (a: number, b: number, c: number, d: number) => number;
  readonly __wbindgen_exn_store: (a: number) => void;
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
