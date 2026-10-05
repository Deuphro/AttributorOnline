let wasm;

const heap = new Array(128).fill(undefined);

heap.push(undefined, null, true, false);

function getObject(idx) { return heap[idx]; }

function isLikeNone(x) {
    return x === undefined || x === null;
}

let cachedFloat64Memory0 = null;

function getFloat64Memory0() {
    if (cachedFloat64Memory0 === null || cachedFloat64Memory0.byteLength === 0) {
        cachedFloat64Memory0 = new Float64Array(wasm.memory.buffer);
    }
    return cachedFloat64Memory0;
}

let cachedInt32Memory0 = null;

function getInt32Memory0() {
    if (cachedInt32Memory0 === null || cachedInt32Memory0.byteLength === 0) {
        cachedInt32Memory0 = new Int32Array(wasm.memory.buffer);
    }
    return cachedInt32Memory0;
}

const cachedTextDecoder = (typeof TextDecoder !== 'undefined' ? new TextDecoder('utf-8', { ignoreBOM: true, fatal: true }) : { decode: () => { throw Error('TextDecoder not available') } } );

if (typeof TextDecoder !== 'undefined') { cachedTextDecoder.decode(); };

let cachedUint8Memory0 = null;

function getUint8Memory0() {
    if (cachedUint8Memory0 === null || cachedUint8Memory0.byteLength === 0) {
        cachedUint8Memory0 = new Uint8Array(wasm.memory.buffer);
    }
    return cachedUint8Memory0;
}

function getStringFromWasm0(ptr, len) {
    ptr = ptr >>> 0;
    return cachedTextDecoder.decode(getUint8Memory0().subarray(ptr, ptr + len));
}

let heap_next = heap.length;

function addHeapObject(obj) {
    if (heap_next === heap.length) heap.push(heap.length + 1);
    const idx = heap_next;
    heap_next = heap[idx];

    heap[idx] = obj;
    return idx;
}

function dropObject(idx) {
    if (idx < 132) return;
    heap[idx] = heap_next;
    heap_next = idx;
}

function takeObject(idx) {
    const ret = getObject(idx);
    dropObject(idx);
    return ret;
}

function getArrayU8FromWasm0(ptr, len) {
    ptr = ptr >>> 0;
    return getUint8Memory0().subarray(ptr / 1, ptr / 1 + len);
}

let cachedUint32Memory0 = null;

function getUint32Memory0() {
    if (cachedUint32Memory0 === null || cachedUint32Memory0.byteLength === 0) {
        cachedUint32Memory0 = new Uint32Array(wasm.memory.buffer);
    }
    return cachedUint32Memory0;
}

function getArrayU32FromWasm0(ptr, len) {
    ptr = ptr >>> 0;
    return getUint32Memory0().subarray(ptr / 4, ptr / 4 + len);
}

let WASM_VECTOR_LEN = 0;

function passArrayF64ToWasm0(arg, malloc) {
    const ptr = malloc(arg.length * 8, 8) >>> 0;
    getFloat64Memory0().set(arg, ptr / 8);
    WASM_VECTOR_LEN = arg.length;
    return ptr;
}

function passArray32ToWasm0(arg, malloc) {
    const ptr = malloc(arg.length * 4, 4) >>> 0;
    getUint32Memory0().set(arg, ptr / 4);
    WASM_VECTOR_LEN = arg.length;
    return ptr;
}

function getArrayJsValueFromWasm0(ptr, len) {
    ptr = ptr >>> 0;
    const mem = getUint32Memory0();
    const slice = mem.subarray(ptr / 4, ptr / 4 + len);
    const result = [];
    for (let i = 0; i < slice.length; i++) {
        result.push(takeObject(slice[i]));
    }
    return result;
}
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
export function crible_mixed_radix(item_masses, item_charges, log_probs, caps, masses, max_mass, min_mass, ppm, best_matches, plan) {
    try {
        const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
        const ptr0 = passArrayF64ToWasm0(item_masses, wasm.__wbindgen_malloc);
        const len0 = WASM_VECTOR_LEN;
        const ptr1 = passArrayF64ToWasm0(item_charges, wasm.__wbindgen_malloc);
        const len1 = WASM_VECTOR_LEN;
        const ptr2 = passArrayF64ToWasm0(log_probs, wasm.__wbindgen_malloc);
        const len2 = WASM_VECTOR_LEN;
        const ptr3 = passArray32ToWasm0(caps, wasm.__wbindgen_malloc);
        const len3 = WASM_VECTOR_LEN;
        const ptr4 = passArrayF64ToWasm0(masses, wasm.__wbindgen_malloc);
        const len4 = WASM_VECTOR_LEN;
        wasm.crible_mixed_radix(retptr, ptr0, len0, ptr1, len1, ptr2, len2, ptr3, len3, ptr4, len4, max_mass, min_mass, ppm, best_matches, addHeapObject(plan));
        var r0 = getInt32Memory0()[retptr / 4 + 0];
        var r1 = getInt32Memory0()[retptr / 4 + 1];
        var r2 = getInt32Memory0()[retptr / 4 + 2];
        var r3 = getInt32Memory0()[retptr / 4 + 3];
        if (r3) {
            throw takeObject(r2);
        }
        var v6 = getArrayJsValueFromWasm0(r0, r1).slice();
        wasm.__wbindgen_free(r0, r1 * 4, 4);
        return v6;
    } finally {
        wasm.__wbindgen_add_to_stack_pointer(16);
    }
}

function getArrayF64FromWasm0(ptr, len) {
    ptr = ptr >>> 0;
    return getFloat64Memory0().subarray(ptr / 8, ptr / 8 + len);
}
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
export function crible_heap(item_masses, item_charges, caps, max_mass, limit) {
    try {
        const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
        const ptr0 = passArrayF64ToWasm0(item_masses, wasm.__wbindgen_malloc);
        const len0 = WASM_VECTOR_LEN;
        const ptr1 = passArrayF64ToWasm0(item_charges, wasm.__wbindgen_malloc);
        const len1 = WASM_VECTOR_LEN;
        const ptr2 = passArray32ToWasm0(caps, wasm.__wbindgen_malloc);
        const len2 = WASM_VECTOR_LEN;
        wasm.crible_heap(retptr, ptr0, len0, ptr1, len1, ptr2, len2, max_mass, limit);
        var r0 = getInt32Memory0()[retptr / 4 + 0];
        var r1 = getInt32Memory0()[retptr / 4 + 1];
        var v4 = getArrayF64FromWasm0(r0, r1).slice();
        wasm.__wbindgen_free(r0, r1 * 8, 8);
        return v4;
    } finally {
        wasm.__wbindgen_add_to_stack_pointer(16);
    }
}

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
export function forest_grow(masses, intensities, standards, tolerance, degree_max, limit) {
    const ptr0 = passArrayF64ToWasm0(masses, wasm.__wbindgen_malloc);
    const len0 = WASM_VECTOR_LEN;
    const ptr1 = passArrayF64ToWasm0(intensities, wasm.__wbindgen_malloc);
    const len1 = WASM_VECTOR_LEN;
    const ptr2 = passArrayF64ToWasm0(standards, wasm.__wbindgen_malloc);
    const len2 = WASM_VECTOR_LEN;
    const ret = wasm.forest_grow(ptr0, len0, ptr1, len1, ptr2, len2, tolerance, degree_max, limit);
    return Forest.__wrap(ret);
}

const cachedTextEncoder = (typeof TextEncoder !== 'undefined' ? new TextEncoder('utf-8') : { encode: () => { throw Error('TextEncoder not available') } } );

const encodeString = (typeof cachedTextEncoder.encodeInto === 'function'
    ? function (arg, view) {
    return cachedTextEncoder.encodeInto(arg, view);
}
    : function (arg, view) {
    const buf = cachedTextEncoder.encode(arg);
    view.set(buf);
    return {
        read: arg.length,
        written: buf.length
    };
});

function passStringToWasm0(arg, malloc, realloc) {

    if (realloc === undefined) {
        const buf = cachedTextEncoder.encode(arg);
        const ptr = malloc(buf.length, 1) >>> 0;
        getUint8Memory0().subarray(ptr, ptr + buf.length).set(buf);
        WASM_VECTOR_LEN = buf.length;
        return ptr;
    }

    let len = arg.length;
    let ptr = malloc(len, 1) >>> 0;

    const mem = getUint8Memory0();

    let offset = 0;

    for (; offset < len; offset++) {
        const code = arg.charCodeAt(offset);
        if (code > 0x7F) break;
        mem[ptr + offset] = code;
    }

    if (offset !== len) {
        if (offset !== 0) {
            arg = arg.slice(offset);
        }
        ptr = realloc(ptr, len, len = offset + arg.length * 3, 1) >>> 0;
        const view = getUint8Memory0().subarray(ptr + offset, ptr + len);
        const ret = encodeString(arg, view);

        offset += ret.written;
        ptr = realloc(ptr, len, offset, 1) >>> 0;
    }

    WASM_VECTOR_LEN = offset;
    return ptr;
}
/**
* Computes one H0 interval per input point. `core` is canonical:
* [x0..xN, y0..yN] for stride 2, or [y0..yN] for stride 1.
* Superlevel activates points by decreasing Y; sublevel by increasing Y.
* @param {Float64Array} core
* @param {number} stride
* @param {string} mode
* @returns {PersistenceAnalysis}
*/
export function persistent_homology_0d_waves(core, stride, mode) {
    const ptr0 = passArrayF64ToWasm0(core, wasm.__wbindgen_malloc);
    const len0 = WASM_VECTOR_LEN;
    const ptr1 = passStringToWasm0(mode, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
    const len1 = WASM_VECTOR_LEN;
    const ret = wasm.persistent_homology_0d_waves(ptr0, len0, stride, ptr1, len1);
    return PersistenceAnalysis.__wrap(ret);
}

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
export function classify_persistence_0d(births, deaths, points_x, points_y, points_index, slope, integrated_mass, centroid_x) {
    const ptr0 = passArrayF64ToWasm0(births, wasm.__wbindgen_malloc);
    const len0 = WASM_VECTOR_LEN;
    const ptr1 = passArrayF64ToWasm0(deaths, wasm.__wbindgen_malloc);
    const len1 = WASM_VECTOR_LEN;
    const ptr2 = passArrayF64ToWasm0(points_x, wasm.__wbindgen_malloc);
    const len2 = WASM_VECTOR_LEN;
    const ptr3 = passArrayF64ToWasm0(points_y, wasm.__wbindgen_malloc);
    const len3 = WASM_VECTOR_LEN;
    const ptr4 = passArrayF64ToWasm0(points_index, wasm.__wbindgen_malloc);
    const len4 = WASM_VECTOR_LEN;
    const ptr5 = passArrayF64ToWasm0(integrated_mass, wasm.__wbindgen_malloc);
    const len5 = WASM_VECTOR_LEN;
    const ptr6 = passArrayF64ToWasm0(centroid_x, wasm.__wbindgen_malloc);
    const len6 = WASM_VECTOR_LEN;
    const ret = wasm.classify_persistence_0d(ptr0, len0, ptr1, len1, ptr2, len2, ptr3, len3, ptr4, len4, slope, ptr5, len5, ptr6, len6);
    return PersistenceClassification.__wrap(ret);
}

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
export function trim_guess(core, stride, method, k, window, threshold) {
    const ptr0 = passArrayF64ToWasm0(core, wasm.__wbindgen_malloc);
    const len0 = WASM_VECTOR_LEN;
    const ptr1 = passStringToWasm0(method, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
    const len1 = WASM_VECTOR_LEN;
    const ret = wasm.trim_guess(ptr0, len0, stride, ptr1, len1, k, window, threshold);
    return ret;
}

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
export function trim_apply(core, stride, low_bound, high_bound) {
    const ptr0 = passArrayF64ToWasm0(core, wasm.__wbindgen_malloc);
    const len0 = WASM_VECTOR_LEN;
    const ret = wasm.trim_apply(ptr0, len0, stride, low_bound, high_bound);
    return TrimResult.__wrap(ret);
}

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
export function trim_histogram(core, stride, bins, scale) {
    const ptr0 = passArrayF64ToWasm0(core, wasm.__wbindgen_malloc);
    const len0 = WASM_VECTOR_LEN;
    const ptr1 = passStringToWasm0(scale, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
    const len1 = WASM_VECTOR_LEN;
    const ret = wasm.trim_histogram(ptr0, len0, stride, bins, ptr1, len1);
    return TrimHistogram.__wrap(ret);
}

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
export function anti_radio_guess_z(core, stride, points_index) {
    const ptr0 = passArrayF64ToWasm0(core, wasm.__wbindgen_malloc);
    const len0 = WASM_VECTOR_LEN;
    const ptr1 = passArrayF64ToWasm0(points_index, wasm.__wbindgen_malloc);
    const len1 = WASM_VECTOR_LEN;
    const ret = wasm.anti_radio_guess_z(ptr0, len0, stride, ptr1, len1);
    return ret;
}

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
export function anti_radio_filter(core, stride, points_x, points_y, points_index, z) {
    const ptr0 = passArrayF64ToWasm0(core, wasm.__wbindgen_malloc);
    const len0 = WASM_VECTOR_LEN;
    const ptr1 = passArrayF64ToWasm0(points_x, wasm.__wbindgen_malloc);
    const len1 = WASM_VECTOR_LEN;
    const ptr2 = passArrayF64ToWasm0(points_y, wasm.__wbindgen_malloc);
    const len2 = WASM_VECTOR_LEN;
    const ptr3 = passArrayF64ToWasm0(points_index, wasm.__wbindgen_malloc);
    const len3 = WASM_VECTOR_LEN;
    const ret = wasm.anti_radio_filter(ptr0, len0, stride, ptr1, len1, ptr2, len2, ptr3, len3, z);
    return RadioDecision.__wrap(ret);
}

/**
* @param {number} a
* @param {number} b
* @returns {number}
*/
export function compute(a, b) {
    const ret = wasm.compute(a, b);
    return ret;
}

/**
* @param {number} a
* @param {number} b
* @returns {number}
*/
export function add(a, b) {
    const ret = wasm.add(a, b);
    return ret;
}

/**
* @param {Float64Array} data
*/
export function arrust(data) {
    var ptr0 = passArrayF64ToWasm0(data, wasm.__wbindgen_malloc);
    var len0 = WASM_VECTOR_LEN;
    wasm.arrust(ptr0, len0, addHeapObject(data));
}

/**
* @param {Float64Array} data
* @param {number} scalar
*/
export function add_scalar(data, scalar) {
    var ptr0 = passArrayF64ToWasm0(data, wasm.__wbindgen_malloc);
    var len0 = WASM_VECTOR_LEN;
    wasm.add_scalar(ptr0, len0, addHeapObject(data), scalar);
}

/**
* @param {bigint} n
* @returns {bigint}
*/
export function bench(n) {
    const ret = wasm.bench(n);
    return BigInt.asUintN(64, ret);
}

/**
* @returns {string}
*/
export function sieve() {
    let deferred1_0;
    let deferred1_1;
    try {
        const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
        wasm.sieve(retptr);
        var r0 = getInt32Memory0()[retptr / 4 + 0];
        var r1 = getInt32Memory0()[retptr / 4 + 1];
        deferred1_0 = r0;
        deferred1_1 = r1;
        return getStringFromWasm0(r0, r1);
    } finally {
        wasm.__wbindgen_add_to_stack_pointer(16);
        wasm.__wbindgen_free(deferred1_0, deferred1_1, 1);
    }
}

function getArrayI32FromWasm0(ptr, len) {
    ptr = ptr >>> 0;
    return getInt32Memory0().subarray(ptr / 4, ptr / 4 + len);
}
/**
* @param {number} n
* @returns {Int32Array}
*/
export function zeros_matrix(n) {
    try {
        const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
        wasm.zeros_matrix(retptr, n);
        var r0 = getInt32Memory0()[retptr / 4 + 0];
        var r1 = getInt32Memory0()[retptr / 4 + 1];
        var v1 = getArrayI32FromWasm0(r0, r1).slice();
        wasm.__wbindgen_free(r0, r1 * 4, 4);
        return v1;
    } finally {
        wasm.__wbindgen_add_to_stack_pointer(16);
    }
}

/**
* Computes 0D persistent homology on a 1D sequence of values (Y values).
* Supports sublevel (default) and superlevel set filtration.
* Returns a flat, non-interleaved vector with four contiguous blocks:
* [births..., deaths..., birth_indices..., death_indices...].
* @param {Float64Array} data
* @param {string} mode
* @returns {Float64Array}
*/
export function persistent_homology_0d(data, mode) {
    try {
        const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
        const ptr0 = passArrayF64ToWasm0(data, wasm.__wbindgen_malloc);
        const len0 = WASM_VECTOR_LEN;
        const ptr1 = passStringToWasm0(mode, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len1 = WASM_VECTOR_LEN;
        wasm.persistent_homology_0d(retptr, ptr0, len0, ptr1, len1);
        var r0 = getInt32Memory0()[retptr / 4 + 0];
        var r1 = getInt32Memory0()[retptr / 4 + 1];
        var v3 = getArrayF64FromWasm0(r0, r1).slice();
        wasm.__wbindgen_free(r0, r1 * 8, 8);
        return v3;
    } finally {
        wasm.__wbindgen_add_to_stack_pointer(16);
    }
}

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
export function fkmd(core, mz) {
    try {
        const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
        const ptr0 = passArrayF64ToWasm0(core, wasm.__wbindgen_malloc);
        const len0 = WASM_VECTOR_LEN;
        wasm.fkmd(retptr, ptr0, len0, mz);
        var r0 = getInt32Memory0()[retptr / 4 + 0];
        var r1 = getInt32Memory0()[retptr / 4 + 1];
        var v2 = getArrayF64FromWasm0(r0, r1).slice();
        wasm.__wbindgen_free(r0, r1 * 8, 8);
        return v2;
    } finally {
        wasm.__wbindgen_add_to_stack_pointer(16);
    }
}

function handleError(f, args) {
    try {
        return f.apply(this, args);
    } catch (e) {
        wasm.__wbindgen_exn_store(addHeapObject(e));
    }
}

const ForestFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_forest_free(ptr >>> 0));
/**
* Ce que rend `forest_grow`.
*
* Les tableaux sont PLATS et non entrelacés: c'est la forme que le worker
* transporte et que `toFloat64` rend directement. Les composants sont ORDONNÉS
* par taille décroissante puis par indice de sommet croissant — le même tri que
* le `Sort2D(...,1,1,-1)` d'Igor, rendu déterministe.
*/
export class Forest {

    static __wrap(ptr) {
        ptr = ptr >>> 0;
        const obj = Object.create(Forest.prototype);
        obj.__wbg_ptr = ptr;
        ForestFinalization.register(obj, obj.__wbg_ptr, obj);
        return obj;
    }

    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        ForestFinalization.unregister(this);
        return ptr;
    }

    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_forest_free(ptr);
    }
    /**
    * @returns {Float64Array}
    */
    get edge_u() {
        try {
            const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
            wasm.forest_edge_u(retptr, this.__wbg_ptr);
            var r0 = getInt32Memory0()[retptr / 4 + 0];
            var r1 = getInt32Memory0()[retptr / 4 + 1];
            var v1 = getArrayF64FromWasm0(r0, r1).slice();
            wasm.__wbindgen_free(r0, r1 * 8, 8);
            return v1;
        } finally {
            wasm.__wbindgen_add_to_stack_pointer(16);
        }
    }
    /**
    * @returns {Float64Array}
    */
    get edge_v() {
        try {
            const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
            wasm.forest_edge_v(retptr, this.__wbg_ptr);
            var r0 = getInt32Memory0()[retptr / 4 + 0];
            var r1 = getInt32Memory0()[retptr / 4 + 1];
            var v1 = getArrayF64FromWasm0(r0, r1).slice();
            wasm.__wbindgen_free(r0, r1 * 8, 8);
            return v1;
        } finally {
            wasm.__wbindgen_add_to_stack_pointer(16);
        }
    }
    /**
    * @returns {Float64Array}
    */
    get edge_weight() {
        try {
            const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
            wasm.forest_edge_weight(retptr, this.__wbg_ptr);
            var r0 = getInt32Memory0()[retptr / 4 + 0];
            var r1 = getInt32Memory0()[retptr / 4 + 1];
            var v1 = getArrayF64FromWasm0(r0, r1).slice();
            wasm.__wbindgen_free(r0, r1 * 8, 8);
            return v1;
        } finally {
            wasm.__wbindgen_add_to_stack_pointer(16);
        }
    }
    /**
    * L'indice, dans la liste des RÉFÉRENCES, de celle qui a matché l'arête.
    * C'est ce qui permet à l'écran d'écrire « CH2 » sur un lien sans que le
    * noyau ait jamais su ce qu'est une formule.
    * @returns {Float64Array}
    */
    get edge_standard() {
        try {
            const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
            wasm.forest_edge_standard(retptr, this.__wbg_ptr);
            var r0 = getInt32Memory0()[retptr / 4 + 0];
            var r1 = getInt32Memory0()[retptr / 4 + 1];
            var v1 = getArrayF64FromWasm0(r0, r1).slice();
            wasm.__wbindgen_free(r0, r1 * 8, 8);
            return v1;
        } finally {
            wasm.__wbindgen_add_to_stack_pointer(16);
        }
    }
    /**
    * @returns {Float64Array}
    */
    get degree() {
        try {
            const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
            wasm.forest_degree(retptr, this.__wbg_ptr);
            var r0 = getInt32Memory0()[retptr / 4 + 0];
            var r1 = getInt32Memory0()[retptr / 4 + 1];
            var v1 = getArrayF64FromWasm0(r0, r1).slice();
            wasm.__wbindgen_free(r0, r1 * 8, 8);
            return v1;
        } finally {
            wasm.__wbindgen_add_to_stack_pointer(16);
        }
    }
    /**
    * Le rang du composant de chaque point, dans les tableaux de composants.
    * @returns {Float64Array}
    */
    get component_of() {
        try {
            const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
            wasm.forest_component_of(retptr, this.__wbg_ptr);
            var r0 = getInt32Memory0()[retptr / 4 + 0];
            var r1 = getInt32Memory0()[retptr / 4 + 1];
            var v1 = getArrayF64FromWasm0(r0, r1).slice();
            wasm.__wbindgen_free(r0, r1 * 8, 8);
            return v1;
        } finally {
            wasm.__wbindgen_add_to_stack_pointer(16);
        }
    }
    /**
    * @returns {Float64Array}
    */
    get component_root() {
        try {
            const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
            wasm.forest_component_root(retptr, this.__wbg_ptr);
            var r0 = getInt32Memory0()[retptr / 4 + 0];
            var r1 = getInt32Memory0()[retptr / 4 + 1];
            var v1 = getArrayF64FromWasm0(r0, r1).slice();
            wasm.__wbindgen_free(r0, r1 * 8, 8);
            return v1;
        } finally {
            wasm.__wbindgen_add_to_stack_pointer(16);
        }
    }
    /**
    * @returns {Float64Array}
    */
    get component_size() {
        try {
            const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
            wasm.forest_component_size(retptr, this.__wbg_ptr);
            var r0 = getInt32Memory0()[retptr / 4 + 0];
            var r1 = getInt32Memory0()[retptr / 4 + 1];
            var v1 = getArrayF64FromWasm0(r0, r1).slice();
            wasm.__wbindgen_free(r0, r1 * 8, 8);
            return v1;
        } finally {
            wasm.__wbindgen_add_to_stack_pointer(16);
        }
    }
    /**
    * @returns {Float64Array}
    */
    get component_max_intensity() {
        try {
            const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
            wasm.forest_component_max_intensity(retptr, this.__wbg_ptr);
            var r0 = getInt32Memory0()[retptr / 4 + 0];
            var r1 = getInt32Memory0()[retptr / 4 + 1];
            var v1 = getArrayF64FromWasm0(r0, r1).slice();
            wasm.__wbindgen_free(r0, r1 * 8, 8);
            return v1;
        } finally {
            wasm.__wbindgen_add_to_stack_pointer(16);
        }
    }
    /**
    * Le poids TOTAL de l'arbre du composant: la somme des erreurs de ses
    * arêtes. C'est la grandeur que l'on compare entre deux lectures du même
    * spectre, et ce n'est PAS la somme des poids de toutes les arêtes
    * candidates — seulement de celles que Kruskal a gardées.
    * @returns {Float64Array}
    */
    get component_weight() {
        try {
            const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
            wasm.forest_component_weight(retptr, this.__wbg_ptr);
            var r0 = getInt32Memory0()[retptr / 4 + 0];
            var r1 = getInt32Memory0()[retptr / 4 + 1];
            var v1 = getArrayF64FromWasm0(r0, r1).slice();
            wasm.__wbindgen_free(r0, r1 * 8, 8);
            return v1;
        } finally {
            wasm.__wbindgen_add_to_stack_pointer(16);
        }
    }
    /**
    * La masse du sommet le plus LÉGER du composant — l'ancêtre qu'Igor
    * prenait dans `roipnts[0]`, et donc celui qu'il attribuait.
    * @returns {Float64Array}
    */
    get component_root_mass() {
        try {
            const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
            wasm.forest_component_root_mass(retptr, this.__wbg_ptr);
            var r0 = getInt32Memory0()[retptr / 4 + 0];
            var r1 = getInt32Memory0()[retptr / 4 + 1];
            var v1 = getArrayF64FromWasm0(r0, r1).slice();
            wasm.__wbindgen_free(r0, r1 * 8, 8);
            return v1;
        } finally {
            wasm.__wbindgen_add_to_stack_pointer(16);
        }
    }
    /**
    * @returns {Float64Array}
    */
    get component_peak_mass() {
        try {
            const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
            wasm.forest_component_peak_mass(retptr, this.__wbg_ptr);
            var r0 = getInt32Memory0()[retptr / 4 + 0];
            var r1 = getInt32Memory0()[retptr / 4 + 1];
            var v1 = getArrayF64FromWasm0(r0, r1).slice();
            wasm.__wbindgen_free(r0, r1 * 8, 8);
            return v1;
        } finally {
            wasm.__wbindgen_add_to_stack_pointer(16);
        }
    }
    /**
    * Combien de paires ont trouvé une référence. C'est le DIAGNOSTIC qui
    * compte: le nombre d'arêtes possibles avant le tri et le plafond de degré,
    * donc il dit si un composant est pauvre par absence de liens ou par abandon.
    * @returns {number}
    */
    get candidates() {
        const ret = wasm.forest_candidates(this.__wbg_ptr);
        return ret;
    }
    /**
    * LA COURBE: tous les poids, triés. C'est ce que le panneau trace, et ce
    * sur quoi se règle la coupure.
    * @returns {Float64Array}
    */
    get weights() {
        try {
            const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
            wasm.forest_weights(retptr, this.__wbg_ptr);
            var r0 = getInt32Memory0()[retptr / 4 + 0];
            var r1 = getInt32Memory0()[retptr / 4 + 1];
            var v1 = getArrayF64FromWasm0(r0, r1).slice();
            wasm.__wbindgen_free(r0, r1 * 8, 8);
            return v1;
        } finally {
            wasm.__wbindgen_add_to_stack_pointer(16);
        }
    }
    /**
    * Où s'arrête l'arbre: combien de candidats Kruskal a consommés. Inférieur
    * à `candidates` quand la coupure a mordu, égal sinon.
    * @returns {number}
    */
    get cut_used() {
        const ret = wasm.forest_cut_used(this.__wbg_ptr);
        return ret;
    }
    /**
    * @returns {number}
    */
    get isolated() {
        const ret = wasm.forest_isolated(this.__wbg_ptr);
        return ret;
    }
    /**
    * @returns {number}
    */
    get edge_count() {
        const ret = wasm.forest_edge_count(this.__wbg_ptr);
        return ret;
    }
    /**
    * @returns {number}
    */
    get component_count() {
        const ret = wasm.forest_component_count(this.__wbg_ptr);
        return ret;
    }
}

const PersistenceAnalysisFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_persistenceanalysis_free(ptr >>> 0));
/**
*/
export class PersistenceAnalysis {

    static __wrap(ptr) {
        ptr = ptr >>> 0;
        const obj = Object.create(PersistenceAnalysis.prototype);
        obj.__wbg_ptr = ptr;
        PersistenceAnalysisFinalization.register(obj, obj.__wbg_ptr, obj);
        return obj;
    }

    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        PersistenceAnalysisFinalization.unregister(this);
        return ptr;
    }

    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_persistenceanalysis_free(ptr);
    }
    /**
    * @returns {Float64Array}
    */
    get births() {
        try {
            const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
            wasm.persistenceanalysis_births(retptr, this.__wbg_ptr);
            var r0 = getInt32Memory0()[retptr / 4 + 0];
            var r1 = getInt32Memory0()[retptr / 4 + 1];
            var v1 = getArrayF64FromWasm0(r0, r1).slice();
            wasm.__wbindgen_free(r0, r1 * 8, 8);
            return v1;
        } finally {
            wasm.__wbindgen_add_to_stack_pointer(16);
        }
    }
    /**
    * @returns {Float64Array}
    */
    get deaths() {
        try {
            const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
            wasm.persistenceanalysis_deaths(retptr, this.__wbg_ptr);
            var r0 = getInt32Memory0()[retptr / 4 + 0];
            var r1 = getInt32Memory0()[retptr / 4 + 1];
            var v1 = getArrayF64FromWasm0(r0, r1).slice();
            wasm.__wbindgen_free(r0, r1 * 8, 8);
            return v1;
        } finally {
            wasm.__wbindgen_add_to_stack_pointer(16);
        }
    }
    /**
    * @returns {Float64Array}
    */
    get points_x() {
        try {
            const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
            wasm.persistenceanalysis_points_x(retptr, this.__wbg_ptr);
            var r0 = getInt32Memory0()[retptr / 4 + 0];
            var r1 = getInt32Memory0()[retptr / 4 + 1];
            var v1 = getArrayF64FromWasm0(r0, r1).slice();
            wasm.__wbindgen_free(r0, r1 * 8, 8);
            return v1;
        } finally {
            wasm.__wbindgen_add_to_stack_pointer(16);
        }
    }
    /**
    * @returns {Float64Array}
    */
    get points_y() {
        try {
            const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
            wasm.persistenceanalysis_points_y(retptr, this.__wbg_ptr);
            var r0 = getInt32Memory0()[retptr / 4 + 0];
            var r1 = getInt32Memory0()[retptr / 4 + 1];
            var v1 = getArrayF64FromWasm0(r0, r1).slice();
            wasm.__wbindgen_free(r0, r1 * 8, 8);
            return v1;
        } finally {
            wasm.__wbindgen_add_to_stack_pointer(16);
        }
    }
    /**
    * @returns {Float64Array}
    */
    get birth_indices() {
        try {
            const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
            wasm.persistenceanalysis_birth_indices(retptr, this.__wbg_ptr);
            var r0 = getInt32Memory0()[retptr / 4 + 0];
            var r1 = getInt32Memory0()[retptr / 4 + 1];
            var v1 = getArrayF64FromWasm0(r0, r1).slice();
            wasm.__wbindgen_free(r0, r1 * 8, 8);
            return v1;
        } finally {
            wasm.__wbindgen_add_to_stack_pointer(16);
        }
    }
    /**
    * @returns {number}
    */
    get slope() {
        const ret = wasm.persistenceanalysis_slope(this.__wbg_ptr);
        return ret;
    }
    /**
    * @returns {Float64Array}
    */
    get integrated_mass() {
        try {
            const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
            wasm.persistenceanalysis_integrated_mass(retptr, this.__wbg_ptr);
            var r0 = getInt32Memory0()[retptr / 4 + 0];
            var r1 = getInt32Memory0()[retptr / 4 + 1];
            var v1 = getArrayF64FromWasm0(r0, r1).slice();
            wasm.__wbindgen_free(r0, r1 * 8, 8);
            return v1;
        } finally {
            wasm.__wbindgen_add_to_stack_pointer(16);
        }
    }
    /**
    * @returns {Float64Array}
    */
    get centroid_x() {
        try {
            const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
            wasm.persistenceanalysis_centroid_x(retptr, this.__wbg_ptr);
            var r0 = getInt32Memory0()[retptr / 4 + 0];
            var r1 = getInt32Memory0()[retptr / 4 + 1];
            var v1 = getArrayF64FromWasm0(r0, r1).slice();
            wasm.__wbindgen_free(r0, r1 * 8, 8);
            return v1;
        } finally {
            wasm.__wbindgen_add_to_stack_pointer(16);
        }
    }
}

const PersistenceClassificationFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_persistenceclassification_free(ptr >>> 0));
/**
*/
export class PersistenceClassification {

    static __wrap(ptr) {
        ptr = ptr >>> 0;
        const obj = Object.create(PersistenceClassification.prototype);
        obj.__wbg_ptr = ptr;
        PersistenceClassificationFinalization.register(obj, obj.__wbg_ptr, obj);
        return obj;
    }

    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        PersistenceClassificationFinalization.unregister(this);
        return ptr;
    }

    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_persistenceclassification_free(ptr);
    }
    /**
    * @returns {Float64Array}
    */
    get kept_births() {
        try {
            const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
            wasm.persistenceclassification_kept_births(retptr, this.__wbg_ptr);
            var r0 = getInt32Memory0()[retptr / 4 + 0];
            var r1 = getInt32Memory0()[retptr / 4 + 1];
            var v1 = getArrayF64FromWasm0(r0, r1).slice();
            wasm.__wbindgen_free(r0, r1 * 8, 8);
            return v1;
        } finally {
            wasm.__wbindgen_add_to_stack_pointer(16);
        }
    }
    /**
    * @returns {Float64Array}
    */
    get kept_deaths() {
        try {
            const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
            wasm.persistenceanalysis_births(retptr, this.__wbg_ptr);
            var r0 = getInt32Memory0()[retptr / 4 + 0];
            var r1 = getInt32Memory0()[retptr / 4 + 1];
            var v1 = getArrayF64FromWasm0(r0, r1).slice();
            wasm.__wbindgen_free(r0, r1 * 8, 8);
            return v1;
        } finally {
            wasm.__wbindgen_add_to_stack_pointer(16);
        }
    }
    /**
    * @returns {Float64Array}
    */
    get kept_points_x() {
        try {
            const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
            wasm.persistenceanalysis_deaths(retptr, this.__wbg_ptr);
            var r0 = getInt32Memory0()[retptr / 4 + 0];
            var r1 = getInt32Memory0()[retptr / 4 + 1];
            var v1 = getArrayF64FromWasm0(r0, r1).slice();
            wasm.__wbindgen_free(r0, r1 * 8, 8);
            return v1;
        } finally {
            wasm.__wbindgen_add_to_stack_pointer(16);
        }
    }
    /**
    * @returns {Float64Array}
    */
    get kept_points_y() {
        try {
            const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
            wasm.persistenceanalysis_points_x(retptr, this.__wbg_ptr);
            var r0 = getInt32Memory0()[retptr / 4 + 0];
            var r1 = getInt32Memory0()[retptr / 4 + 1];
            var v1 = getArrayF64FromWasm0(r0, r1).slice();
            wasm.__wbindgen_free(r0, r1 * 8, 8);
            return v1;
        } finally {
            wasm.__wbindgen_add_to_stack_pointer(16);
        }
    }
    /**
    * @returns {Float64Array}
    */
    get kept_indices() {
        try {
            const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
            wasm.persistenceanalysis_points_y(retptr, this.__wbg_ptr);
            var r0 = getInt32Memory0()[retptr / 4 + 0];
            var r1 = getInt32Memory0()[retptr / 4 + 1];
            var v1 = getArrayF64FromWasm0(r0, r1).slice();
            wasm.__wbindgen_free(r0, r1 * 8, 8);
            return v1;
        } finally {
            wasm.__wbindgen_add_to_stack_pointer(16);
        }
    }
    /**
    * @returns {Float64Array}
    */
    get kept_integrated_mass() {
        try {
            const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
            wasm.persistenceanalysis_birth_indices(retptr, this.__wbg_ptr);
            var r0 = getInt32Memory0()[retptr / 4 + 0];
            var r1 = getInt32Memory0()[retptr / 4 + 1];
            var v1 = getArrayF64FromWasm0(r0, r1).slice();
            wasm.__wbindgen_free(r0, r1 * 8, 8);
            return v1;
        } finally {
            wasm.__wbindgen_add_to_stack_pointer(16);
        }
    }
    /**
    * @returns {Float64Array}
    */
    get kept_centroid_x() {
        try {
            const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
            wasm.persistenceanalysis_integrated_mass(retptr, this.__wbg_ptr);
            var r0 = getInt32Memory0()[retptr / 4 + 0];
            var r1 = getInt32Memory0()[retptr / 4 + 1];
            var v1 = getArrayF64FromWasm0(r0, r1).slice();
            wasm.__wbindgen_free(r0, r1 * 8, 8);
            return v1;
        } finally {
            wasm.__wbindgen_add_to_stack_pointer(16);
        }
    }
    /**
    * @returns {Float64Array}
    */
    get discarded_births() {
        try {
            const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
            wasm.persistenceanalysis_centroid_x(retptr, this.__wbg_ptr);
            var r0 = getInt32Memory0()[retptr / 4 + 0];
            var r1 = getInt32Memory0()[retptr / 4 + 1];
            var v1 = getArrayF64FromWasm0(r0, r1).slice();
            wasm.__wbindgen_free(r0, r1 * 8, 8);
            return v1;
        } finally {
            wasm.__wbindgen_add_to_stack_pointer(16);
        }
    }
    /**
    * @returns {Float64Array}
    */
    get discarded_deaths() {
        try {
            const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
            wasm.persistenceclassification_discarded_deaths(retptr, this.__wbg_ptr);
            var r0 = getInt32Memory0()[retptr / 4 + 0];
            var r1 = getInt32Memory0()[retptr / 4 + 1];
            var v1 = getArrayF64FromWasm0(r0, r1).slice();
            wasm.__wbindgen_free(r0, r1 * 8, 8);
            return v1;
        } finally {
            wasm.__wbindgen_add_to_stack_pointer(16);
        }
    }
    /**
    * @returns {number}
    */
    get kept_count() {
        const ret = wasm.persistenceclassification_kept_count(this.__wbg_ptr);
        return ret >>> 0;
    }
}

const RadioDecisionFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_radiodecision_free(ptr >>> 0));
/**
* A candidate peak reduced to what the filter decides on.
*/
export class RadioDecision {

    static __wrap(ptr) {
        ptr = ptr >>> 0;
        const obj = Object.create(RadioDecision.prototype);
        obj.__wbg_ptr = ptr;
        RadioDecisionFinalization.register(obj, obj.__wbg_ptr, obj);
        return obj;
    }

    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        RadioDecisionFinalization.unregister(this);
        return ptr;
    }

    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_radiodecision_free(ptr);
    }
    /**
    * @returns {Float64Array}
    */
    get points_x() {
        try {
            const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
            wasm.radiodecision_points_x(retptr, this.__wbg_ptr);
            var r0 = getInt32Memory0()[retptr / 4 + 0];
            var r1 = getInt32Memory0()[retptr / 4 + 1];
            var v1 = getArrayF64FromWasm0(r0, r1).slice();
            wasm.__wbindgen_free(r0, r1 * 8, 8);
            return v1;
        } finally {
            wasm.__wbindgen_add_to_stack_pointer(16);
        }
    }
    /**
    * @returns {Float64Array}
    */
    get points_y() {
        try {
            const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
            wasm.radiodecision_points_y(retptr, this.__wbg_ptr);
            var r0 = getInt32Memory0()[retptr / 4 + 0];
            var r1 = getInt32Memory0()[retptr / 4 + 1];
            var v1 = getArrayF64FromWasm0(r0, r1).slice();
            wasm.__wbindgen_free(r0, r1 * 8, 8);
            return v1;
        } finally {
            wasm.__wbindgen_add_to_stack_pointer(16);
        }
    }
    /**
    * @returns {Float64Array}
    */
    get indices() {
        try {
            const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
            wasm.radiodecision_indices(retptr, this.__wbg_ptr);
            var r0 = getInt32Memory0()[retptr / 4 + 0];
            var r1 = getInt32Memory0()[retptr / 4 + 1];
            var v1 = getArrayF64FromWasm0(r0, r1).slice();
            wasm.__wbindgen_free(r0, r1 * 8, 8);
            return v1;
        } finally {
            wasm.__wbindgen_add_to_stack_pointer(16);
        }
    }
    /**
    * @returns {Float64Array}
    */
    get widths_ppm() {
        try {
            const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
            wasm.radiodecision_widths_ppm(retptr, this.__wbg_ptr);
            var r0 = getInt32Memory0()[retptr / 4 + 0];
            var r1 = getInt32Memory0()[retptr / 4 + 1];
            var v1 = getArrayF64FromWasm0(r0, r1).slice();
            wasm.__wbindgen_free(r0, r1 * 8, 8);
            return v1;
        } finally {
            wasm.__wbindgen_add_to_stack_pointer(16);
        }
    }
    /**
    * @returns {Uint8Array}
    */
    get is_radio() {
        try {
            const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
            wasm.radiodecision_is_radio(retptr, this.__wbg_ptr);
            var r0 = getInt32Memory0()[retptr / 4 + 0];
            var r1 = getInt32Memory0()[retptr / 4 + 1];
            var v1 = getArrayU8FromWasm0(r0, r1).slice();
            wasm.__wbindgen_free(r0, r1 * 1, 1);
            return v1;
        } finally {
            wasm.__wbindgen_add_to_stack_pointer(16);
        }
    }
    /**
    * @returns {number}
    */
    get kept_count() {
        const ret = wasm.radiodecision_kept_count(this.__wbg_ptr);
        return ret >>> 0;
    }
    /**
    * @returns {number}
    */
    get reference_ppm() {
        const ret = wasm.radiodecision_reference_ppm(this.__wbg_ptr);
        return ret;
    }
    /**
    * @returns {number}
    */
    get threshold_ppm() {
        const ret = wasm.radiodecision_threshold_ppm(this.__wbg_ptr);
        return ret;
    }
}

const ReadingFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_reading_free(ptr >>> 0));
/**
* Ce que le kernel rend, par lecture gardée.
*
* `peak` est l'INDICE du point le plus proche dans le tableau de masses,
* `error_ppm` l'écart signé, et `counts` les multiplicités — les « coefficients
* du radix », qui suffisent à JS pour reconstruire la formule sans refaire le
* crible.
*/
export class Reading {

    static __wrap(ptr) {
        ptr = ptr >>> 0;
        const obj = Object.create(Reading.prototype);
        obj.__wbg_ptr = ptr;
        ReadingFinalization.register(obj, obj.__wbg_ptr, obj);
        return obj;
    }

    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        ReadingFinalization.unregister(this);
        return ptr;
    }

    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_reading_free(ptr);
    }
    /**
    * @returns {number}
    */
    get peak() {
        const ret = wasm.reading_peak(this.__wbg_ptr);
        return ret;
    }
    /**
    * @returns {number}
    */
    get error_ppm() {
        const ret = wasm.reading_error_ppm(this.__wbg_ptr);
        return ret;
    }
    /**
    * @returns {number}
    */
    get log_probability() {
        const ret = wasm.reading_log_probability(this.__wbg_ptr);
        return ret;
    }
    /**
    * @returns {number}
    */
    get mass() {
        const ret = wasm.reading_mass(this.__wbg_ptr);
        return ret;
    }
    /**
    * @returns {number}
    */
    get charge() {
        const ret = wasm.reading_charge(this.__wbg_ptr);
        return ret;
    }
    /**
    * @returns {Uint32Array}
    */
    get counts() {
        try {
            const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
            wasm.reading_counts(retptr, this.__wbg_ptr);
            var r0 = getInt32Memory0()[retptr / 4 + 0];
            var r1 = getInt32Memory0()[retptr / 4 + 1];
            var v1 = getArrayU32FromWasm0(r0, r1).slice();
            wasm.__wbindgen_free(r0, r1 * 4, 4);
            return v1;
        } finally {
            wasm.__wbindgen_add_to_stack_pointer(16);
        }
    }
}

const TrimHistogramFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_trimhistogram_free(ptr >>> 0));
/**
* One histogram bar: the graph needs centres and counts, nothing else.
*/
export class TrimHistogram {

    static __wrap(ptr) {
        ptr = ptr >>> 0;
        const obj = Object.create(TrimHistogram.prototype);
        obj.__wbg_ptr = ptr;
        TrimHistogramFinalization.register(obj, obj.__wbg_ptr, obj);
        return obj;
    }

    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        TrimHistogramFinalization.unregister(this);
        return ptr;
    }

    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_trimhistogram_free(ptr);
    }
    /**
    * @returns {Float64Array}
    */
    get centres() {
        try {
            const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
            wasm.trimhistogram_centres(retptr, this.__wbg_ptr);
            var r0 = getInt32Memory0()[retptr / 4 + 0];
            var r1 = getInt32Memory0()[retptr / 4 + 1];
            var v1 = getArrayF64FromWasm0(r0, r1).slice();
            wasm.__wbindgen_free(r0, r1 * 8, 8);
            return v1;
        } finally {
            wasm.__wbindgen_add_to_stack_pointer(16);
        }
    }
    /**
    * @returns {Float64Array}
    */
    get counts() {
        try {
            const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
            wasm.trimhistogram_counts(retptr, this.__wbg_ptr);
            var r0 = getInt32Memory0()[retptr / 4 + 0];
            var r1 = getInt32Memory0()[retptr / 4 + 1];
            var v1 = getArrayF64FromWasm0(r0, r1).slice();
            wasm.__wbindgen_free(r0, r1 * 8, 8);
            return v1;
        } finally {
            wasm.__wbindgen_add_to_stack_pointer(16);
        }
    }
    /**
    * @returns {number}
    */
    get min() {
        const ret = wasm.trimhistogram_min(this.__wbg_ptr);
        return ret;
    }
    /**
    * @returns {number}
    */
    get max() {
        const ret = wasm.trimhistogram_max(this.__wbg_ptr);
        return ret;
    }
    /**
    * @returns {number}
    */
    get dropped() {
        const ret = wasm.trimhistogram_dropped(this.__wbg_ptr);
        return ret >>> 0;
    }
}

const TrimResultFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_trimresult_free(ptr >>> 0));
/**
* A trimmed wave. Deliberately minimal: the bounds are echoed for the shell,
* but nothing method-related lives here, because trim_apply is a pure
* two-bounds primitive.
*/
export class TrimResult {

    static __wrap(ptr) {
        ptr = ptr >>> 0;
        const obj = Object.create(TrimResult.prototype);
        obj.__wbg_ptr = ptr;
        TrimResultFinalization.register(obj, obj.__wbg_ptr, obj);
        return obj;
    }

    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        TrimResultFinalization.unregister(this);
        return ptr;
    }

    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_trimresult_free(ptr);
    }
    /**
    * @returns {Float64Array}
    */
    get points_x() {
        try {
            const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
            wasm.trimresult_points_x(retptr, this.__wbg_ptr);
            var r0 = getInt32Memory0()[retptr / 4 + 0];
            var r1 = getInt32Memory0()[retptr / 4 + 1];
            var v1 = getArrayF64FromWasm0(r0, r1).slice();
            wasm.__wbindgen_free(r0, r1 * 8, 8);
            return v1;
        } finally {
            wasm.__wbindgen_add_to_stack_pointer(16);
        }
    }
    /**
    * @returns {Float64Array}
    */
    get points_y() {
        try {
            const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
            wasm.trimresult_points_y(retptr, this.__wbg_ptr);
            var r0 = getInt32Memory0()[retptr / 4 + 0];
            var r1 = getInt32Memory0()[retptr / 4 + 1];
            var v1 = getArrayF64FromWasm0(r0, r1).slice();
            wasm.__wbindgen_free(r0, r1 * 8, 8);
            return v1;
        } finally {
            wasm.__wbindgen_add_to_stack_pointer(16);
        }
    }
    /**
    * @returns {Float64Array}
    */
    get kept_indices() {
        try {
            const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
            wasm.trimresult_kept_indices(retptr, this.__wbg_ptr);
            var r0 = getInt32Memory0()[retptr / 4 + 0];
            var r1 = getInt32Memory0()[retptr / 4 + 1];
            var v1 = getArrayF64FromWasm0(r0, r1).slice();
            wasm.__wbindgen_free(r0, r1 * 8, 8);
            return v1;
        } finally {
            wasm.__wbindgen_add_to_stack_pointer(16);
        }
    }
    /**
    * @returns {number}
    */
    get kept_count() {
        const ret = wasm.trimhistogram_dropped(this.__wbg_ptr);
        return ret >>> 0;
    }
    /**
    * @returns {number}
    */
    get total_count() {
        const ret = wasm.trimresult_total_count(this.__wbg_ptr);
        return ret >>> 0;
    }
    /**
    * @returns {number}
    */
    get low_bound() {
        const ret = wasm.trimhistogram_min(this.__wbg_ptr);
        return ret;
    }
    /**
    * @returns {number}
    */
    get high_bound() {
        const ret = wasm.trimhistogram_max(this.__wbg_ptr);
        return ret;
    }
}

async function __wbg_load(module, imports) {
    if (typeof Response === 'function' && module instanceof Response) {
        if (typeof WebAssembly.instantiateStreaming === 'function') {
            try {
                return await WebAssembly.instantiateStreaming(module, imports);

            } catch (e) {
                if (module.headers.get('Content-Type') != 'application/wasm') {
                    console.warn("`WebAssembly.instantiateStreaming` failed because your server does not serve wasm with `application/wasm` MIME type. Falling back to `WebAssembly.instantiate` which is slower. Original error:\n", e);

                } else {
                    throw e;
                }
            }
        }

        const bytes = await module.arrayBuffer();
        return await WebAssembly.instantiate(bytes, imports);

    } else {
        const instance = await WebAssembly.instantiate(module, imports);

        if (instance instanceof WebAssembly.Instance) {
            return { instance, module };

        } else {
            return instance;
        }
    }
}

function __wbg_get_imports() {
    const imports = {};
    imports.wbg = {};
    imports.wbg.__wbg_reading_new = function(arg0) {
        const ret = Reading.__wrap(arg0);
        return addHeapObject(ret);
    };
    imports.wbg.__wbindgen_number_get = function(arg0, arg1) {
        const obj = getObject(arg1);
        const ret = typeof(obj) === 'number' ? obj : undefined;
        getFloat64Memory0()[arg0 / 8 + 1] = isLikeNone(ret) ? 0 : ret;
        getInt32Memory0()[arg0 / 4 + 0] = !isLikeNone(ret);
    };
    imports.wbg.__wbindgen_string_new = function(arg0, arg1) {
        const ret = getStringFromWasm0(arg0, arg1);
        return addHeapObject(ret);
    };
    imports.wbg.__wbindgen_object_drop_ref = function(arg0) {
        takeObject(arg0);
    };
    imports.wbg.__wbindgen_is_undefined = function(arg0) {
        const ret = getObject(arg0) === undefined;
        return ret;
    };
    imports.wbg.__wbindgen_is_null = function(arg0) {
        const ret = getObject(arg0) === null;
        return ret;
    };
    imports.wbg.__wbindgen_copy_to_typed_array = function(arg0, arg1, arg2) {
        new Uint8Array(getObject(arg2).buffer, getObject(arg2).byteOffset, getObject(arg2).byteLength).set(getArrayU8FromWasm0(arg0, arg1));
    };
    imports.wbg.__wbg_get_bd8e338fbd5f5cc8 = function(arg0, arg1) {
        const ret = getObject(arg0)[arg1 >>> 0];
        return addHeapObject(ret);
    };
    imports.wbg.__wbg_length_cd7af8117672b8b8 = function(arg0) {
        const ret = getObject(arg0).length;
        return ret;
    };
    imports.wbg.__wbg_get_e3c254076557e348 = function() { return handleError(function (arg0, arg1) {
        const ret = Reflect.get(getObject(arg0), getObject(arg1));
        return addHeapObject(ret);
    }, arguments) };
    imports.wbg.__wbg_isArray_2ab64d95e09ea0ae = function(arg0) {
        const ret = Array.isArray(getObject(arg0));
        return ret;
    };
    imports.wbg.__wbg_instanceof_Object_71ca3c0a59266746 = function(arg0) {
        let result;
        try {
            result = getObject(arg0) instanceof Object;
        } catch (_) {
            result = false;
        }
        const ret = result;
        return ret;
    };
    imports.wbg.__wbindgen_throw = function(arg0, arg1) {
        throw new Error(getStringFromWasm0(arg0, arg1));
    };

    return imports;
}

function __wbg_init_memory(imports, maybe_memory) {

}

function __wbg_finalize_init(instance, module) {
    wasm = instance.exports;
    __wbg_init.__wbindgen_wasm_module = module;
    cachedFloat64Memory0 = null;
    cachedInt32Memory0 = null;
    cachedUint32Memory0 = null;
    cachedUint8Memory0 = null;


    return wasm;
}

function initSync(module) {
    if (wasm !== undefined) return wasm;

    const imports = __wbg_get_imports();

    __wbg_init_memory(imports);

    if (!(module instanceof WebAssembly.Module)) {
        module = new WebAssembly.Module(module);
    }

    const instance = new WebAssembly.Instance(module, imports);

    return __wbg_finalize_init(instance, module);
}

async function __wbg_init(input) {
    if (wasm !== undefined) return wasm;

    if (typeof input === 'undefined') {
        input = new URL('attribrustor_bg.wasm', import.meta.url);
    }
    const imports = __wbg_get_imports();

    if (typeof input === 'string' || (typeof Request === 'function' && input instanceof Request) || (typeof URL === 'function' && input instanceof URL)) {
        input = fetch(input);
    }

    __wbg_init_memory(imports);

    const { instance, module } = await __wbg_load(await input, imports);

    return __wbg_finalize_init(instance, module);
}

export { initSync }
export default __wbg_init;
