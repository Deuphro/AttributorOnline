//Kernel worker: loads its own instance of the attribrustor WASM module and
//executes compute kernels off the main thread, so the UI never blocks.
import init,* as rust from "../XOP/rust-extension/pkg/attribrustor.js"
/* Le réseau de mesures. Ce module n'importe QUE forest.js, qui n'importe rien:
   c'est ce qui permet au worker de l'avoir sans traîner la table périodique
   dans chaque fil — et c'est pourquoi `growForest` y est le MÊME calcul que
   dans le noyau, et non une version allégée. */
import {growForest} from "./forest.js"

let wasmReady=null
//Log-histogram bar density, kept in step with LOG_BINS_PER_DECADE in trim.rs
const LOG_BINS_PER_DECADE=6
const MIN_LOG_BINS=8
//Values per state in the attribution sieve's flat output, kept in step with
//STRIDE in attribution.rs. Four: mass, charge, signature, parent.
//
// It is a constant rather than something read back from the wasm module on
// purpose: the JS fallback and the Rust kernel must agree WITHOUT exchanging
// anything at run time, and a value read from one side would be a value the
// other side could disagree with. A test checks the two against each other.
const ATTRIBUTION_STRIDE=4
function ensureWasm(){
    if(!wasmReady){
        wasmReady=init()
    }
    return wasmReady
}

const kernels={
    async addScalar({core,params}){
        const scalar=params?.scalar??1
        try{
            await ensureWasm()
            if(typeof rust.add_scalar!=="function"){
                throw new Error("rust add_scalar is missing (stale pkg build?)")
            }
            rust.add_scalar(core,scalar)
        }catch(err){
            console.warn("[kernelWorker] rust kernel unavailable, JS fallback:",err)
            for(let k=0;k<core.length;k++){
                core[k]+=scalar
            }
        }
        return {core}
    },
    async persistentHomology0D({core,params}){
        const mode=params?.mode??"sublevel"
        const stride=params?.stride??1
        let result
        try{
            await ensureWasm()
            if(typeof rust.persistent_homology_0d_waves!=="function"){
                throw new Error("rust persistent_homology_0d_waves is missing (stale pkg build?)")
            }
            const analysis=rust.persistent_homology_0d_waves(core,stride,mode)
            result={
                births:toFloat64(analysis.births),
                deaths:toFloat64(analysis.deaths),
                pointsX:toFloat64(analysis.points_x),
                pointsY:toFloat64(analysis.points_y),
                birthIndices:toFloat64(analysis.birth_indices),
                slope:analysis.slope,
                //the area and the centroid the union-find integrated on the
                //way through. A stale pkg build simply lacks them, and the
                //fields come back undefined rather than throwing
                integratedMass:toFloat64(analysis.integrated_mass),
                centroidX:toFloat64(analysis.centroid_x),
            }
        }catch(err){
            console.warn("[kernelWorker] rust H0 unavailable, JS fallback:",err)
            result=analysePersistence0DJS(core,stride,mode)
        }
        return result
    },
    async classifyPersistence0D({births,deaths,pointsX,pointsY,pointsIndex,integratedMass,centroidX,params}){
        const slope=params?.slope
        if(!Number.isFinite(slope)) throw new Error("classification requires a finite slope")
        //pointsIndex travels with the points and is returned untouched: it is
        //the only route from a kept point back to the profile it was read from,
        //which is what a width-based filter (anti_radio) needs.
        const indices=pointsIndex??new Float64Array(births.length)
        //and so does the integrated mass, for the same reason — see the note in
        //persistence.rs. Without it the only surviving intensity is the
        //chief's, which is exactly what the integration replaced.
        const masses=integratedMass??new Float64Array(births.length).fill(NaN)
        const centroids=centroidX??new Float64Array(births.length).fill(NaN)
        let result
        try{
            await ensureWasm()
            if(typeof rust.classify_persistence_0d!=="function"){
                throw new Error("rust classify_persistence_0d is missing (stale pkg build?)")
            }
            const classification=rust.classify_persistence_0d(births,deaths,pointsX,pointsY,indices,slope,masses,centroids)
            result={
                keptBirths:toFloat64(classification.kept_births),
                keptDeaths:toFloat64(classification.kept_deaths),
                keptPointsX:toFloat64(classification.kept_points_x),
                keptPointsY:toFloat64(classification.kept_points_y),
                keptIndices:toFloat64(classification.kept_indices),
                keptIntegratedMass:toFloat64(classification.kept_integrated_mass),
                keptCentroidX:toFloat64(classification.kept_centroid_x),
                discardedBirths:toFloat64(classification.discarded_births),
                discardedDeaths:toFloat64(classification.discarded_deaths),
                keptCount:classification.kept_count
            }
        }catch(err){
            console.warn("[kernelWorker] rust classification unavailable, JS fallback:",err)
            result=classifyPersistence0DJS(births,deaths,pointsX,pointsY,indices,slope,masses,centroids)
        }
        return result
    },
    /* The guess for z: a threshold READ from the spectrum rather than the 3
       convention. Returns ONE number, like trim_guess, so the shell does not
       have to re-measure every width to show it. */
    async antiRadioGuessZ({core,pointsIndex,params}){
        const stride=params?.stride??2
        try{
            await ensureWasm()
            if(typeof rust.anti_radio_guess_z!=="function"){
                throw new Error("rust anti_radio_guess_z is missing (stale pkg build?)")
            }
            return rust.anti_radio_guess_z(core,stride,pointsIndex)
        }catch(err){
            console.warn("[kernelWorker] rust anti-radio guess unavailable, JS fallback:",err)
            return antiRadioGuessZJS(core,stride,pointsIndex)
        }
    },
    /* Anti-radio: drops the peaks whose half-height width is out of the width
       population measured on the spectrum itself. Mirrors antiradio.rs.

       Two inputs and NOT one, and that is the whole point: the CANDIDATES come
       from the persistence homology node (it knows which points are peaks), and
       the PROFILE comes from the raw wave (only it has the samples around a
       peak, so only it can say how wide that peak is). A width is a property of
       the signal, not of the point list. */
    async antiRadioFilter({core,pointsX,pointsY,pointsIndex,params}){
        const stride=params?.stride??2
        const z=params?.z??3
        let result
        try{
            await ensureWasm()
            if(typeof rust.anti_radio_filter!=="function"){
                throw new Error("rust anti_radio_filter is missing (stale pkg build?)")
            }
            const decision=rust.anti_radio_filter(core,stride,pointsX,pointsY,pointsIndex,z)
            result={
                pointsX:toFloat64(decision.points_x),
                pointsY:toFloat64(decision.points_y),
                indices:toFloat64(decision.indices),
                widthsPpm:toFloat64(decision.widths_ppm),
                isRadio:Array.from(decision.is_radio),
                keptCount:decision.kept_count,
                referencePpm:decision.reference_ppm,
                thresholdPpm:decision.threshold_ppm
            }
        }catch(err){
            console.warn("[kernelWorker] rust anti-radio unavailable, JS fallback:",err)
            result=antiRadioFilterJS(core,stride,pointsX,pointsY,pointsIndex,z)
        }
        return result
    },
    async trimGuess({core,params}){
        const method=params?.method??"passthrough"
        const stride=params?.stride??1
        const k=params?.k??5
        const window=params?.window??9
        const threshold=params?.threshold??0.1
        //returns ONE number, so the rust path allocates and clones nothing: the
        //shell only needs the threshold, and the old design built the whole
        //trimmed point set just to read it back
        try{
            await ensureWasm()
            if(typeof rust.trim_guess!=="function"){
                throw new Error("rust trim_guess is missing (stale pkg build?)")
            }
            return rust.trim_guess(core,stride,method,k,window,threshold)
        }catch(err){
            console.warn("[kernelWorker] rust guess unavailable, JS fallback:",err)
            return trimGuessJS(core,stride,method,k,window,threshold)
        }
    },
    async trimApply({core,params}){
        const stride=params?.stride??1
        //a non-finite bound means "no cut on that side"
        const low=Number.isFinite(params?.lowBound)?params.lowBound:-Infinity
        const high=Number.isFinite(params?.highBound)?params.highBound:Infinity
        let result
        try{
            await ensureWasm()
            if(typeof rust.trim_apply!=="function"){
                throw new Error("rust trim_apply is missing (stale pkg build?)")
            }
            const trimmed=rust.trim_apply(core,stride,low,high)
            //wasm-bindgen exposes the #[wasm_bindgen(getter)] fields as plain
            //properties here, exactly like PersistenceAnalysis.births
            result={
                pointsX:toFloat64(trimmed.points_x),
                pointsY:toFloat64(trimmed.points_y),
                keptIndices:toFloat64(trimmed.kept_indices),
                keptCount:trimmed.kept_count,
                totalCount:trimmed.total_count,
                lowBound:trimmed.low_bound,
                highBound:trimmed.high_bound
            }
        }catch(err){
            console.warn("[kernelWorker] rust trim unavailable, JS fallback:",err)
            result=trimApplyJS(core,stride,low,high)
        }
        return result
    },
    /* F-KMD: Formula - Kendrick Mass Defect.

       The Rust kernel is fkmd.rs, beside persistence.rs and trim.rs. It returns
       a FLAT, non-interleaved [x'0..x'N, y'0..y'N] - the same layout a 2D Wave
       core uses, so the shell hands it straight to Wave.fromCoordinates.

       fkmd returns a bare Float64Array, NOT a struct: the only thing it has to
       say is the wave, and a wrapper would be one more shape to keep in step.
       The JS fallback below computes exactly the same thing, so a stale or
       failed wasm build still resolves the flow. */
    async fkmd({core,params}){
        try{
            await ensureWasm()
            if(typeof rust.fkmd!=="function"){
                throw new Error("rust fkmd is missing (stale pkg build?)")
            }
            return {core:toFloat64(rust.fkmd(core,params?.mz??0))}
        }catch(err){
            console.warn("[kernelWorker] rust fkmd unavailable, JS fallback:",err)
            return {core:fkmdJS(core,params?.mz??0)}
        }
    },
    /* The attribution sieve: exhaustive combinations of masses, in RISING MASS
       ORDER, without duplicates.

       The Rust kernel is src/attribution.rs. It returns a FLAT array of STRIDE
       values per state - [mass, charge, signature, parent] - because that is the
       layout the whole project uses for kernel output, and because a struct with
       getters cannot be built on a Vec field with the wasm-bindgen version in
       use here.

       The caps are NOT computed here: they come from the plan, because an
       adduct's bound depends on the IONISATION WINDOW and only the plan knows
       it. A massless adduct - a [2+], which weighs two lost electrons - has a
       NEGATIVE mass, so a mass-derived bound is meaningless for it and a wrong
       one makes the walk never end. The kernel therefore refuses a combination
       of "unbounded" and "massless" outright, and so does the JS fallback.

       The JS fallback computes the same thing, so a stale or failed wasm build
       still resolves the flow - and the two agree, which is what lets the shell
       treat the kernel as an implementation detail rather than a dependency. */
    async attributionCrible({params}){
        const masses=params?.itemMasses??[]
        const charges=params?.itemCharges??[]
        const caps=params?.caps??[]
        const maxMass=params?.maxMass??0
        const limit=params?.limit??Number.MAX_SAFE_INTEGER
        try{
            await ensureWasm()
            if(typeof rust.crible_heap!=="function"){
                throw new Error("rust crible_heap is missing (stale pkg build?)")
            }
            const flat=toFloat64(rust.crible_heap(
                Float64Array.from(masses),
                Float64Array.from(charges),
                Uint32Array.from(caps),
                maxMass,
                limit
            ))
            return {flat,stride:ATTRIBUTION_STRIDE,truncated:flat.length>0&&flat.length%ATTRIBUTION_STRIDE!==0}
        }catch(err){
            console.warn("[kernelWorker] rust crible unavailable, JS fallback:",err)
            const flat=cribleHeapJS(masses,charges,caps,maxMass,limit)
            return {flat,stride:ATTRIBUTION_STRIDE,truncated:flat.length%ATTRIBUTION_STRIDE!==0}
        }
    },
    /* THE MIXED-RADIX SIEVE — the kernel the attribution node actually uses.

       Unlike `attributionCrible` above, which drives the HEAP, this one drives
       `crible_mixed_radix`: the same recursion the JS `cribleMixedRadix` runs, with
       the per-peak selection INSIDE. They are not interchangeable — the heap is a
       different algorithm — so they are two named tasks, never one behind a flag.

       WHAT COMES BACK IS NOT A STATE LIST. The kernel renders at most
       `masses.length() * best_matches` rows, whatever the size of the space it
       walked: that is what makes it usable on a 1000 Da peak list, where the JS
       state array is what exhausted the browser.

       The rows carry COUNTS, not formulas. Chemistry stays in JS, where it already
       lives: `stateToFormula` turns counts into a formula, so the kernel needs no
       table, no notation and no knowledge of groups by name.

       The JS fallback runs the REAL JS sieve, through `attributeSpectrum`, so a
       stale or failed wasm build degrades to the previous behaviour instead of
       producing something subtly different. */
    async attributionCriblemixed({params}){
        const {plan,masses,maxMass,minMass,ppm,bestMatches}=params??{}
        try{
            await ensureWasm()
            if(typeof rust.crible_mixed_radix!=="function"){
                throw new Error("rust crible_mixed_radix is missing (stale pkg build?)")
            }
            const rows=rust.crible_mixed_radix(
                Float64Array.from(plan.itemMasses),
                Float64Array.from(plan.itemCharges),
                Float64Array.from(plan.logProbs),
                Uint32Array.from(params.caps),
                Float64Array.from(masses),
                maxMass,minMass,ppm,bestMatches,
                {fixed:plan.fixed??[],...(plan.dependence?{dependence:plan.dependence}:{})}
            )
            /* `Reading` is a wasm-bindgen class, so it does NOT survive
               structuredClone: the worker would throw on postMessage. It is turned
               into plain rows HERE, and the counts into a plain array — which is
               also cheaper than moving a wasm view around. */
            return {
                rows:rows.map(row=>({
                    peak:row.peak,
                    errorPpm:row.error_ppm,
                    logProbability:row.log_probability,
                    mass:row.mass,
                    charge:row.charge,
                    counts:Array.from(row.counts)
                }))
            }
        }catch(err){
            console.warn("[kernelWorker] rust mixed sieve unavailable, JS fallback:",err)
            return {rows:null,fallback:err?.message??String(err)}
        }
    },
    /* LE RÉSEAU DE MESURES — l'arbre couvrant de poids minimal.

       Unlike the sieve above, this one KNOWS NOTHING about chemistry: the
       reference masses arrive as numbers, because a difference of m/z is a
       number. `forest.js` builds the list from the plan, this runs the tree,
       and neither of them needs the other.

       The returned shape is the FLAT one the worker can post: plain arrays,
       no wasm classes. A `Forest` would not survive `structuredClone` — the
       same reason `attributionCriblemixed` turns its `Reading` rows into plain
       objects HERE rather than in the node. */
    async attributionForest({params}){
        const {masses,intensities,standards,tolerance,degreeMax,limit}=params??{}
        try{
            await ensureWasm()
            if(typeof rust.forest_grow!=="function"){
                throw new Error("rust forest_grow is missing (stale pkg build?)")
            }
            const forest=rust.forest_grow(
                Float64Array.from(masses??[]),
                Float64Array.from(intensities??[]),
                Float64Array.from(standards??[]),
                Number(tolerance),
                Number(degreeMax??0),
                Number(limit??0)
            )
            return {
                forest:{
                    edgeU:toFloat64(forest.edge_u),
                    edgeV:toFloat64(forest.edge_v),
                    edgeWeight:toFloat64(forest.edge_weight),
                    edgeStandard:toFloat64(forest.edge_standard),
                    degree:toFloat64(forest.degree),
                    componentOf:toFloat64(forest.component_of),
                    componentRoot:toFloat64(forest.component_root),
                    componentSize:toFloat64(forest.component_size),
                    componentMaxIntensity:toFloat64(forest.component_max_intensity),
                    componentWeight:toFloat64(forest.component_weight),
                    componentRootMass:toFloat64(forest.component_root_mass),
                    componentPeakMass:toFloat64(forest.component_peak_mass),
                    /* LA COURBE ET LA COUPURE, et elles voyagent avec l'arbre:
                       c'est un seul appel qui donne le graphique, le rang
                       suggéré et le résultat, donc les trois ne peuvent pas
                       diverger — ils viennent tous du même tri. */
                    weights:toFloat64(forest.weights),
                    candidates:forest.candidates,
                    cutUsed:forest.cut_used,
                    isolated:forest.isolated,
                    edgeCount:forest.edge_count,
                    componentCount:forest.component_count
                }
            }
        }catch(err){
            /* LE REPLI EST LE MÊME CALCUL, pas une approximation — comme pour
               le crible. Il est écrit ICI, dans le worker, et non renvoyé au
               nœud: ici il n'y a aucune chimie à refaire, donc le rendre ici
               évite un aller-retour du thread principal pour un calcul que le
               worker peut faire lui-même. */
            console.warn("[kernelWorker] rust forest unavailable, JS fallback:",err)
            const forest=growForest({masses,intensities,standards,tolerance,degreeMax})
            return {forest,fallback:err?.message??String(err)}
        }
    },
    async trimHistogram({core,params}){
        const stride=params?.stride??1
        const bins=Math.max(1,params?.bins??64)
        const scale=params?.scale==="log"?"log":"linear"
        let result
        try{
            await ensureWasm()
            if(typeof rust.trim_histogram!=="function"){
                throw new Error("rust trim_histogram is missing (stale pkg build?)")
            }
            const histogram=rust.trim_histogram(core,stride,bins,scale)
            result={
                centres:toFloat64(histogram.centres),
                counts:toFloat64(histogram.counts),
                min:histogram.min,
                max:histogram.max,
                dropped:histogram.dropped
            }
        }catch(err){
            console.warn("[kernelWorker] rust histogram unavailable, JS fallback:",err)
            result=trimHistogramJS(core,stride,bins,scale)
        }
        return result
    },
    async calibrationFit({refX,refY,mode}){
        try{
            await ensureWasm()
            if(typeof rust.calibration_fit!=="function"){
                throw new Error("rust calibration_fit is missing (stale pkg build?)")
            }
            const result=rust.calibration_fit(Float64Array.from(refX),Float64Array.from(refY),mode)
            return {coeffs:toFloat64(result.coeffs),rmse:result.rmse}
        }catch(err){
            console.warn("[kernelWorker] rust calibration_fit unavailable, JS fallback:",err)
            return calibrationFitJS(refX,refY,mode)
        }
    },
    async calibrationApply({x,coeffs,mode}){
        try{
            await ensureWasm()
            if(typeof rust.calibration_apply!=="function"){
                throw new Error("rust calibration_apply is missing (stale pkg build?)")
            }
            const result=rust.calibration_apply(Float64Array.from(x),Float64Array.from(coeffs),mode)
            //calibration_apply returns a BARE Float64Array (.d.ts says so); an
            //older pkg returned {x}. result.x ?? result accepts both — reading
            //result.x alone yields undefined → a length-0 array → the downstream
            //Wave.fromCoordinates "equally-sized" TypeError.
            return {x:toFloat64(result?.x??result)}
        }catch(err){
            console.warn("[kernelWorker] rust calibration_apply unavailable, JS fallback:",err)
            return calibrationApplyJS(x,coeffs,mode)
        }
    },
    async calibrationFit2D({measuredMz,intensity,errorPpm,mode}){
        try{
            await ensureWasm()
            if(typeof rust.calibration_fit_2d!=="function"){
                throw new Error("rust calibration_fit_2d is missing (stale pkg build?)")
            }
            const result=rust.calibration_fit_2d(Float64Array.from(measuredMz),Float64Array.from(intensity),Float64Array.from(errorPpm),mode)
            return {coeffs:toFloat64(result.coeffs),rmse:result.rmse}
        }catch(err){
            console.warn("[kernelWorker] rust calibration_fit_2d unavailable, JS fallback:",err)
            return calibrationFit2DJS(measuredMz,intensity,errorPpm,mode)
        }
    },
    async calibrationApply2D({x,y,coeffs,mode}){
        try{
            await ensureWasm()
            if(typeof rust.calibration_apply_2d!=="function"){
                throw new Error("rust calibration_apply_2d is missing (stale pkg build?)")
            }
            const result=rust.calibration_apply_2d(Float64Array.from(x),Float64Array.from(y),Float64Array.from(coeffs),mode)
            //Same as calibration_apply: bare Float64Array from the current pkg,
            //{x} from an older one — unwrap both shapes.
            return {x:toFloat64(result?.x??result)}
        }catch(err){
            console.warn("[kernelWorker] rust calibration_apply_2d unavailable, JS fallback:",err)
            return calibrationApply2DJS(x,y,coeffs,mode)
        }
    },
    async parseThermoRaw({data,options={}}){
        let result
        try{
            await ensureWasm()
            if(typeof rust.parse_thermo_raw!=="function"){
                throw new Error("rust parse_thermo_raw is missing (stale pkg build?)")
            }
            const rawResult=rust.parse_thermo_raw(new Uint8Array(data),options)
            console.log("[kernelWorker] rawResult:", rawResult)
            
            // Handle metadata-only response
            if(rawResult.scanMetadata){
                console.log("[kernelWorker] metadata-only response")
                result={scanMetadata:rawResult.scanMetadata}
                return result
            }
            
            // Convert flat arrays to per-spectrum objects
            const mz=Array.from(rawResult.mz)
            const intensity=Array.from(rawResult.intensity)
            const scanNumbers=Array.from(rawResult.scanNumbers)
            const rts=Array.from(rawResult.rts)
            const msLevels=Array.from(rawResult.msLevels)
            const scanPeakCounts=Array.from(rawResult.scanPeakCounts)
            
            const spectra=[]
            let idx=0
            for(let i=0;i<scanPeakCounts.length;i++){
                const count=scanPeakCounts[i]
                const scanMz=mz.slice(idx,idx+count)
                const scanIntensity=intensity.slice(idx,idx+count)
                spectra.push({
                    mz:scanMz,
                    intensity:scanIntensity,
                    scan_number:scanNumbers[idx]??(i+1),
                    rt:rts[idx]??0,
                    ms_level:msLevels[idx]??1
                })
                idx+=count
            }
            console.log("[kernelWorker] converted spectra:", spectra)
            result={spectra,file_version:rawResult.fileVersion,scan_count:rawResult.scanCount}
        }catch(err){
            console.warn("[kernelWorker] rust parseThermoRaw unavailable, JS fallback:",err)
            result=parseThermoRawJS(data)
        }
        return result
    }
}

/* The attribution sieve in JS — the fallback for src/attribution.rs.

   It computes the SAME thing, in the same order, with the same refusals. That is
   what lets the shell treat the kernel as an implementation detail: a stale or
   failed wasm build must still resolve the flow, and produce the same masses in
   the same order — otherwise a user's attribution would depend on whether their
   build was up to date, which is not a property anyone can reason about.

   The algorithm is the same best-first walk: a min-heap on mass, seeded with the
   null vector, each state grown by incrementing ONE multiplicity, and a `seen` of
   signatures so no state is pushed twice. `attribution.js` has the same walk
   with a min-heap class; it is duplicated here rather than imported because this
   file must not pull the chemistry module into every worker.

   The two refusals matter as much as the loop:
     - a descriptor of the wrong length is a CALLER error, not a limit case;
     - "unbounded" on a "massless" item is the combination that never ends, since
       a negative mass never crosses the ceiling. */
function cribleHeapJS(itemMasses,itemCharges,caps,maxMass,limit){
    const count=itemMasses.length
    if(count===0||itemCharges.length!==count||caps.length!==count) return new Float64Array(0)
    if(!Number.isFinite(maxMass)||maxMass<=0) return new Float64Array(0)
    for(let i=0;i<count;i++){
        //a massless item with no bound would be added forever: its mass never
        //grows, so the ceiling never stops it
        if(caps[i]===0xFFFFFFFF&&!(itemMasses[i]>0)) return new Float64Array(0)
    }
    if(caps.every(cap=>cap===0)) return new Float64Array(0)

    //the signature is the identity of a state. A STRING, not a hash: this is the
    //cost that made the Rust kernel worth writing, and the reason is written
    //here rather than only there.
    const signature=(counts)=>counts.join(",")
    //the heap is a plain array scanned for the minimum. O(k) per pop instead of
    //O(log k), which is fine at the sizes a browser tolerates and which keeps
    //this fallback short enough to be obviously correct.
    const open=[]
    const push=(mass,counts)=>open.push({mass,counts})
    const popMin=()=>{
        let best=0
        for(let i=1;i<open.length;i++){
            if(open[i].mass<open[best].mass) best=i
        }
        return open.splice(best,1)[0]
    }
    const seen=new Set()
    const zero=new Int32Array(count)
    seen.add(signature(zero))
    push(0,zero)
    const out=[]
    let emitted=0
    while(open.length){
        const state=popMin()
        let charge=0
        for(let i=0;i<count;i++) charge+=itemCharges[i]*state.counts[i]
        out.push(state.mass,charge,0,emitted===0?-1:emitted-1)
        emitted++
        if(emitted>=limit) break
        for(let i=0;i<count;i++){
            if(state.counts[i]>=caps[i]) continue
            const mass=state.mass+itemMasses[i]
            if(mass>maxMass) continue
            const counts=Int32Array.from(state.counts)
            counts[i]+=1
            const marker=signature(counts)
            if(seen.has(marker)) continue
            seen.add(marker)
            push(mass,counts)
        }
    }
    //the signature slot stays zero here: it is the RUST kernel's identity token,
    //and the JS caller only ever reads mass and charge out of this array. Filling
    //it with a JS-incompatible value would be worse than leaving it explicit.
    return Float64Array.from(out)
}


//Same semantics as fkmd.rs, so a stale or failed wasm build still resolves the
//flow. Both steps, in the same order: the defect reads the NEW x, which is the
//whole definition of the transform. A non-finite or non-positive m/z yields an
//EMPTY result, never a silent pass-through - the shell must be able to tell
//"no result" from "result identical to the input".
function fkmdJS(core,mz){
    if(!Number.isFinite(mz)||mz<=0) return new Float64Array(0)
    const reference=Math.round(mz)
    if(!(reference>0)) return new Float64Array(0)
    const factor=reference/mz        //constant for the whole wave: computed ONCE
    const n=Math.floor((core?.length??0)/2)
    const out=new Float64Array(n*2)
    for(let i=0;i<n;i++){
        const scaled=core[i]*factor
        out[i]=scaled                 //X' = x * round(mz)/m/z
        out[n+i]=scaled-Math.round(scaled)  //Y' = x' - round(x'), per index
    }
    return out
}
function toFloat64(value){
    return value instanceof Float64Array?value:new Float64Array(value)
}

//Same semantics as trim.rs trim_guess, so a stale or failed wasm build still
//resolves the flow instead of breaking it.
function trimGuessJS(core,stride,method,k,window,threshold){
    const n=Math.floor(core.length/stride)
    const y=stride===2?core.subarray(n):core
    const kSafe=Number.isFinite(k)?k:5
    const windowSafe=Number.isFinite(window)&&window>=3?Math.round(window):9
    const thresholdSafe=Number.isFinite(threshold)?threshold:0.1
    if(method==="madResidual"){
        //relative: baseline + k*sigma, never the absolute k*sigma
        return baselineLevelJS(y)+residualSigmaJS(y,windowSafe)*kSafe
    }
    if(method==="intensityThreshold") return thresholdSafe
    //passthrough, and any unknown name: nothing is cut
    return -Infinity
}
//Same semantics as trim.rs trim_apply: a pure two-bounds cut, no method.
function trimApplyJS(core,stride,lowBound,highBound){
    const n=Math.floor(core.length/stride)
    const y=stride===2?core.subarray(n):core
    const xs=[],ys=[],indices=[]
    for(let i=0;i<n;i++){
        const value=y[i]
        //a NaN compares false against every bound: filter it explicitly
        if(Number.isNaN(value)) continue
        if(value<lowBound||(Number.isFinite(highBound)&&value>highBound)) continue
        xs.push(stride===2?core[i]:i)
        ys.push(value)
        indices.push(i)
    }
    return {
        pointsX:Float64Array.from(xs),
        pointsY:Float64Array.from(ys),
        keptIndices:Float64Array.from(indices),
        keptCount:xs.length,
        totalCount:n,
        lowBound,
        highBound
    }
}
function residualSigmaJS(y,window){
    const n=y.length
    if(!n) return 0
    const half=Math.floor(window/2)
    const deviations=new Float64Array(n)
    for(let i=0;i<n;i++){
        let sum=0
        const start=Math.max(0,i-half),end=Math.min(n,i+half+1)
        for(let k=start;k<end;k++) sum+=y[k]
        deviations[i]=Math.abs(y[i]-sum/(end-start))
    }
    const sorted=Array.from(deviations).sort((a,b)=>a-b)
    const median=sorted.length%2===1?sorted[(sorted.length-1)/2]:0.5*(sorted[sorted.length/2-1]+sorted[sorted.length/2])
    return 1.4826*median
}
//Median of the values: the robust "where the signal sits" estimate, matching
//baseline_level in trim.rs.
function baselineLevelJS(y){
    const values=Array.from(y).filter(v=>!Number.isNaN(v)).sort((a,b)=>a-b)
    if(!values.length) return 0
    return values.length%2===1
        ?values[(values.length-1)/2]
        :0.5*(values[values.length/2-1]+values[values.length/2])
}
function trimHistogramJS(core,stride,bins,scale="linear"){
    const n=Math.floor(core.length/stride)
    const y=stride===2?core.subarray(n):core
    if(!n) return {centres:new Float64Array(0),counts:new Float64Array(0),min:0,max:0,dropped:0}
    if(scale==="log") return logHistogramJS(y,bins)
    let min=Infinity,max=-Infinity
    for(let i=0;i<n;i++){
        const v=y[i]
        if(Number.isNaN(v)) continue
        if(v<min) min=v
        if(v>max) max=v
    }
    if(!Number.isFinite(min)||!Number.isFinite(max)){min=0;max=0}
    const width=(max-min)/bins
    const counts=new Float64Array(bins)
    for(let i=0;i<n;i++){
        const v=y[i]
        if(Number.isNaN(v)) continue
        const index=width>0?Math.min(bins-1,Math.max(0,Math.floor((v-min)/width))):0
        counts[index]+=1
    }
    const step=width>0?width:1
    const centres=new Float64Array(bins)
    for(let i=0;i<bins;i++) centres[i]=min+(i+0.5)*step
    return {centres,counts,min,max,dropped:0}
}
//Evenly spaced bins in log10(value), mirroring log_histogram in trim.rs: the
//centres are GEOMETRIC means, because the value axis is log-scaled and only a
//geometric mean lands at the centre of its slot.
function logHistogramJS(y,bins){
    let lo=Infinity,hi=-Infinity,dropped=0
    for(let i=0;i<y.length;i++){
        const v=y[i]
        //zero, negatives and NaN have no log10: they cannot sit on a log axis
        if(Number.isNaN(v)||v<=0){dropped++;continue}
        const lg=Math.log10(v)
        if(lg<lo) lo=lg
        if(lg>hi) hi=lg
    }
    if(!Number.isFinite(lo)||!Number.isFinite(hi)){
        return {centres:new Float64Array(0),counts:new Float64Array(0),min:0,max:0,dropped}
    }
    //bar count from the span, not a fixed one: see LOG_BINS_PER_DECADE in trim.rs
    const wanted=Math.round((hi-lo)*LOG_BINS_PER_DECADE)
    const effective=Math.min(bins,Math.max(MIN_LOG_BINS,wanted))
    const width=(hi-lo)/effective
    const counts=new Float64Array(effective)
    for(let i=0;i<y.length;i++){
        const v=y[i]
        if(Number.isNaN(v)||v<=0) continue
        const index=width>0
            ?Math.min(effective-1,Math.max(0,Math.floor((Math.log10(v)-lo)/width)))
            :0
        counts[index]+=1
    }
    const step=width>0?width:1
    const centres=new Float64Array(effective)
    for(let i=0;i<effective;i++) centres[i]=Math.pow(10,lo+(i+0.5)*step)
    return {centres,counts,min:Math.pow(10,lo),max:Math.pow(10,hi),dropped}
}

function analysePersistence0DJS(core,stride=1,mode="sublevel"){
    const n=Math.floor(core.length/stride), offset=stride===2?n:0
    const y=stride===2?core.subarray(offset):core
    const raw=computePersistentHomology0D_JS(y,mode),count=raw.length/4
    //the same integration the Rust sweep does, so a stale wasm build and this
    //fallback report the SAME numbers - see persistence.rs
    const masses=integrateComponentMassJS(core,stride,mode)
    const rows=Array.from({length:count},(_,i)=>{const idx=Math.round(raw[count*2+i]);return{x:stride===2?core[idx]:idx,birth:raw[i],death:raw[count+i],idx,mass:masses.mass[idx]??0,centroid:masses.centroid[idx]??NaN}})
    rows.sort((a,b)=>a.x-b.x||a.idx-b.idx)
    const births=new Float64Array(count),deaths=new Float64Array(count),pointsX=new Float64Array(count),pointsY=new Float64Array(count),birthIndices=new Float64Array(count),integratedMass=new Float64Array(count),centroidX=new Float64Array(count)
    let sumBirth=0,sumDeath=0
    rows.forEach((p,i)=>{births[i]=p.birth;deaths[i]=p.death;pointsX[i]=p.x;pointsY[i]=y[p.idx];birthIndices[i]=p.idx;integratedMass[i]=p.mass;centroidX[i]=p.centroid;sumBirth+=p.birth;sumDeath+=p.death})
    const slope=sumBirth>0&&Number.isFinite(sumDeath/sumBirth)?clampJS(sumDeath/sumBirth):clampJS(keepAllSlopeJS(births,deaths))
    return {births,deaths,pointsX,pointsY,birthIndices,slope,integratedMass,centroidX}
}
/* The union-find integration, mirrored from persistent_homology_0d_waves.

   Same three rules, because three of them are the whole algorithm:
     - the accumulators live on the ROOTS, not on the points
     - a DYING component is stamped with its own total BEFORE it is folded
       into the survivor, because after the fold that total is gone
     - a component that never dies still has a mass, and is not an exception

   The tie rule matters as much as the rest and is easy to get wrong: the side
   the parent pointer KEEPS is the survivor, so on a tie the survivor is the
   first argument. Deriving the dying side from the birth values instead picks
   the survivor on a tie, and the surviving peak then reports a partial area. */
function integrateComponentMassJS(core,stride,mode){
    const n=Math.floor(core.length/stride), offset=stride===2?n:0
    const y=stride===2?core.subarray(offset):core
    const superlevel=mode==="superlevel"
    const xOf=(i)=>stride===2?core[i]:i
    const mass=new Float64Array(n), xmass=new Float64Array(n)
    for(let i=0;i<n;i++){
        const v=y[i]
        mass[i]=Number.isFinite(v)?v:0
        const xv=xOf(i)
        xmass[i]=Number.isFinite(xv)&&Number.isFinite(v)?xv*v:0
    }
    const parent=new Uint32Array(n)
    for(let i=0;i<n;i++) parent[i]=i
    function find(i){let root=i;while(root!==parent[root]) root=parent[root];while(i!==root){const next=parent[i];parent[i]=root;i=next}return root}
    const order=Array.from({length:n},(_,i)=>i)
    order.sort((a,b)=>{const cmp=y[a]-y[b];return (superlevel?-cmp:cmp)||(xOf(a)-xOf(b))})
    const active=new Uint8Array(n)
    const outMass=new Float64Array(n), outCentroid=new Float64Array(n)
    const died=new Uint8Array(n)
    for(const idx of order){
        active[idx]=1
        for(const nb of [idx>0?idx-1:-1, idx+1<n?idx+1:-1]){
            if(nb<0||!active[nb]) continue
            const ra=find(idx), rb=find(nb)
            if(ra===rb) continue
            const raIsOld=superlevel?y[ra]>=y[rb]:y[ra]<=y[rb]
            const survivor=raIsOld?ra:rb, dying=raIsOld?rb:ra
            outMass[dying]=mass[dying]
            outCentroid[dying]=mass[dying]!==0?xmass[dying]/mass[dying]:NaN
            died[dying]=1
            mass[survivor]+=mass[dying]
            xmass[survivor]+=xmass[dying]
            if(raIsOld) parent[rb]=ra; else parent[ra]=rb
        }
    }
    for(let i=0;i<n;i++){
        if(!died[i]){
            outMass[i]=mass[i]
            outCentroid[i]=mass[i]!==0?xmass[i]/mass[i]:NaN
        }
    }
    return {mass:outMass,centroid:outCentroid}
}
function classifyPersistence0DJS(births,deaths,pointsX,pointsY,pointsIndex,slope,integratedMass,centroidX){
    const count=births.length
    const keptBirths=new Float64Array(count),keptDeaths=new Float64Array(count),keptPointsX=new Float64Array(count),keptPointsY=new Float64Array(count),keptIndices=new Float64Array(count),keptMass=new Float64Array(count),keptCentroid=new Float64Array(count),discardedBirths=new Float64Array(count),discardedDeaths=new Float64Array(count)
    let kept=0,discarded=0
    for(let i=0;i<count;i++){
        if(deaths[i]<=slope*births[i]||deaths[i]<=slope*births[i]+1e-9*Math.max(1,Math.abs(births[i]))){
            keptBirths[kept]=births[i];keptDeaths[kept]=deaths[i];keptPointsX[kept]=pointsX[i];keptPointsY[kept]=pointsY[i]
            //NaN, never a guess: see the note on the Rust side
            keptIndices[kept]=pointsIndex?.[i]??NaN
            //and the same for the integrated mass, which is carried rather than
            //recomputed: the classifier has no profile to recompute it from
            keptMass[kept]=integratedMass?.[i]??NaN
            keptCentroid[kept]=centroidX?.[i]??NaN
            kept++
        }else{discardedBirths[discarded]=births[i];discardedDeaths[discarded]=deaths[i];discarded++}
    }
    return {keptBirths:keptBirths.subarray(0,kept),keptDeaths:keptDeaths.subarray(0,kept),keptPointsX:keptPointsX.subarray(0,kept),keptPointsY:keptPointsY.subarray(0,kept),keptIndices:keptIndices.subarray(0,kept),keptIntegratedMass:keptMass.subarray(0,kept),keptCentroidX:keptCentroid.subarray(0,kept),discardedBirths:discardedBirths.subarray(0,discarded),discardedDeaths:discardedDeaths.subarray(0,discarded),keptCount:kept}
}
//Same semantics as antiradio.rs: a self-limiting half-height scan, then a
//robust (median + MAD) reference built from the spectrum's own widths. The
//constants are duplicated on purpose - the same reason trim.js keeps its own
//LOG_BINS_PER_DECADE - so a stale wasm build still filters identically.
const MAD_TO_SIGMA_JS=1.4826
const MIN_PEAKS_FOR_REFERENCE_JS=8
function medianJS(values){
    if(!values.length) return NaN
    const sorted=Array.from(values).sort((a,b)=>a-b)
    const n=sorted.length
    return n%2===1?sorted[n/2]:0.5*(sorted[n/2-1]+sorted[n/2])
}
function widthPpmJS(x,y,peak){
    const n=y.length
    if(peak<0||peak>=n) return NaN
    const height=y[peak]
    if(!Number.isFinite(height)||height<=0) return NaN
    const level=0.5*height
    let left=peak
    while(left>0&&y[left-1]>level) left--
    let right=peak
    while(right+1<n&&y[right+1]>level) right++
    if(left===0||right===n-1) return NaN
    const mass=x[peak]
    if(!Number.isFinite(mass)||mass<=0) return NaN
    return (x[right]-x[left])/mass*1e6
}
//Same semantics as antiradio.rs anti_radio_guess_z, so a stale wasm build still
//guesses. The width scan, the robust spread and the gap test all mirror the
//Rust side; the fallback exists for a browser with no Worker, not as a second
//implementation to maintain on its own.
const MIN_GAP_OVER_NOISE_JS=8
function antiRadioGuessZJS(core,stride,pointsIndex){
    const n=Math.floor(core.length/stride)
    const x=stride===2?core.subarray(0,n):null
    const y=stride===2?core.subarray(n):core
    if(!x) return 3
    const measured=[]
    for(let i=0;i<(pointsIndex?.length??0);i++){
        const idx=pointsIndex[i]
        if(!Number.isFinite(idx)) continue
        const w=widthPpmJS(x,y,Math.round(idx))
        if(Number.isFinite(w)&&w>0) measured.push(w)
    }
    if(measured.length<MIN_PEAKS_FOR_REFERENCE_JS) return 3
    measured.sort((a,b)=>a-b)
    const reference=medianJS(measured)
    const spread=MAD_TO_SIGMA_JS*medianJS(measured.map(w=>Math.abs(w-reference)))
    if(!(spread>0)) return 3
    const steps=[]
    for(let i=1;i<measured.length;i++) steps.push((measured[i]-measured[i-1])/spread)
    if(!steps.length) return 3
    const bestGap=Math.max(...steps)
    if(!(bestGap>MIN_GAP_OVER_NOISE_JS*medianJS(steps))) return 3
    const z=bestGap/2
    return Number.isFinite(z)&&z>0?z:3
}
function antiRadioFilterJS(core,stride,pointsX,pointsY,pointsIndex,z){
    const n=Math.floor(core.length/stride)
    const x=stride===2?core.subarray(0,n):null
    const y=stride===2?core.subarray(n):core
    const count=pointsX.length
    const widths=new Float64Array(count)
    for(let i=0;i<count;i++){
        const idx=pointsIndex?.[i]
        widths[i]=Number.isFinite(idx)?widthPpmJS(x,y,Math.round(idx)):NaN
    }
    const measured=Array.from(widths).filter(w=>Number.isFinite(w)&&w>0)
    let reference=NaN,threshold=Infinity
    if(measured.length>=MIN_PEAKS_FOR_REFERENCE_JS){
        reference=medianJS(measured)
        const deviations=measured.map(w=>Math.abs(w-reference))
        const spread=MAD_TO_SIGMA_JS*medianJS(deviations)
        const zSafe=Number.isFinite(z)?z:3
        threshold=reference+zSafe*spread
    }
    const xs=[],ys=[],indices=[],isRadio=new Array(count).fill(0)
    let kept=0
    for(let i=0;i<count;i++){
        const radio=Number.isFinite(widths[i])&&widths[i]>threshold
        isRadio[i]=radio?1:0
        if(!radio){xs.push(pointsX[i]);ys.push(pointsY[i]);indices.push(pointsIndex?.[i]??NaN);kept++}
    }
    return {pointsX:Float64Array.from(xs),pointsY:Float64Array.from(ys),indices:Float64Array.from(indices),widthsPpm:widths,isRadio,keptCount:kept,referencePpm:reference,thresholdPpm:threshold}
}
function clampJS(v){return Number.isFinite(v)?Math.min(1-1e-12,Math.max(1e-9,v)):1-1e-12}
function keepAllSlopeJS(births,deaths){let r=0;for(let i=0;i<births.length;i++)if(births[i]>0)r=Math.max(r,deaths[i]/births[i]);return r}

function calibrationFitJS(refX,refY,mode){
    const n=refX.length
    if(n<2) return {coeffs:new Float64Array([1,0]),rmse:0}
    if(mode==="linear"){
        let sumX=0,sumY=0,sumXY=0,sumXX=0
        for(let i=0;i<n;i++){
            sumX+=refX[i]
            sumY+=refY[i]
            sumXY+=refX[i]*refY[i]
            sumXX+=refX[i]*refX[i]
        }
        const denom=n*sumXX-sumX*sumX
        if(!Number.isFinite(denom) || denom===0) return {coeffs:new Float64Array([1,0]),rmse:0}
        const a=(n*sumXY-sumX*sumY)/denom
        const b=(sumY*sumXX-sumX*sumXY)/denom
        let rmse=0
        for(let i=0;i<n;i++){
            const pred=a*refX[i]+b
            rmse+=(pred-refY[i])**2
        }
        rmse=Math.sqrt(rmse/n)
        return {coeffs:new Float64Array([a,b]),rmse}
    }
    if(mode==="quadratic"){
        const XT=new Float64Array(n*3)
        const Y=new Float64Array(n)
        for(let i=0;i<n;i++){
            XT[i*3]=refX[i]*refX[i]
            XT[i*3+1]=refX[i]
            XT[i*3+2]=1
            Y[i]=refY[i]
        }
        const coeffs=solveNormalEqsJS(XT,Y,3)
        let rmse=0
        for(let i=0;i<n;i++){
            const pred=coeffs[0]*refX[i]*refX[i]+coeffs[1]*refX[i]+coeffs[2]
            rmse+=(pred-refY[i])**2
        }
        rmse=Math.sqrt(rmse/n)
        return {coeffs,rmse}
    }
    if(mode==="cubic"){
        const XT=new Float64Array(n*4)
        const Y=new Float64Array(n)
        for(let i=0;i<n;i++){
            XT[i*4]=refX[i]*refX[i]*refX[i]
            XT[i*4+1]=refX[i]*refX[i]
            XT[i*4+2]=refX[i]
            XT[i*4+3]=1
            Y[i]=refY[i]
        }
        const coeffs=solveNormalEqsJS(XT,Y,4)
        let rmse=0
        for(let i=0;i<n;i++){
            const pred=coeffs[0]*refX[i]*refX[i]*refX[i]+coeffs[1]*refX[i]*refX[i]+coeffs[2]*refX[i]+coeffs[3]
            rmse+=(pred-refY[i])**2
        }
        rmse=Math.sqrt(rmse/n)
        return {coeffs,rmse}
    }
    return {coeffs:new Float64Array([1,0]),rmse:0}
}

function solveNormalEqsJS(XT,Y,k){
    const n=Y.length
    const XTX=new Float64Array(k*k)
    const XTY=new Float64Array(k)
    for(let i=0;i<k;i++){
        for(let j=0;j<k;j++){
            let sum=0
            for(let r=0;r<n;r++){
                sum+=XT[r*k+i]*XT[r*k+j]
            }
            XTX[i*k+j]=sum
        }
        let sum=0
        for(let r=0;r<n;r++){
            sum+=XT[r*k+i]*Y[r]
        }
        XTY[i]=sum
    }
    return gaussianEliminationJS(XTX,XTY,k)
}

function gaussianEliminationJS(A,b,k){
    const M=new Float64Array(k*(k+1))
    for(let i=0;i<k;i++){
        for(let j=0;j<k;j++) M[i*(k+1)+j]=A[i*k+j]
        M[i*(k+1)+k]=b[i]
    }
    for(let col=0;col<k;col++){
        let pivot=col
        for(let row=col+1;row<k;row++){
            if(Math.abs(M[row*(k+1)+col])>Math.abs(M[pivot*(k+1)+col])){
                pivot=row
            }
        }
        if(Math.abs(M[pivot*(k+1)+col])<1e-12) return new Float64Array(k).fill(0)
        if(pivot!==col){
            for(let j=col;j<=k;j++){
                const tmp=M[col*(k+1)+j]
                M[col*(k+1)+j]=M[pivot*(k+1)+j]
                M[pivot*(k+1)+j]=tmp
            }
        }
        const pivVal=M[col*(k+1)+col]
        for(let j=col;j<=k;j++) M[col*(k+1)+j]/=pivVal
        for(let row=0;row<k;row++){
            if(row===col) continue
            const factor=M[row*(k+1)+col]
            if(factor===0) continue
            for(let j=col;j<=k;j++){
                M[row*(k+1)+j]-=factor*M[col*(k+1)+j]
            }
        }
    }
    const x=new Float64Array(k)
    for(let i=0;i<k;i++) x[i]=M[i*(k+1)+k]
    return x
}

function calibrationApplyJS(x,coeffs,mode){
    if(!coeffs || !coeffs.length) return {x:Float64Array.from(x)}
    const n=x.length
    const result=new Float64Array(n)
    for(let i=0;i<n;i++){
        const xi=x[i]
        if(mode==="linear"){
            result[i]=coeffs[0]*xi+coeffs[1]
        }else if(mode==="quadratic"){
            result[i]=coeffs[0]*xi*xi+coeffs[1]*xi+coeffs[2]
        }else if(mode==="cubic"){
            result[i]=coeffs[0]*xi*xi*xi+coeffs[1]*xi*xi+coeffs[2]*xi+coeffs[3]
        }else{
            result[i]=xi
        }
    }
    return {x:result}
}

function calibrationFit2DJS(measuredMz,intensity,errorPpm,mode){
    const n=measuredMz.length
    if(n<3) return {coeffs:new Float64Array([0,0,0]),rmse:0}

    let k, design
    if(mode==="linear2d"){
        k=3
        design=new Float64Array(n*k)
        for(let i=0;i<n;i++){
            design[i*k]=measuredMz[i]
            design[i*k+1]=intensity[i]
            design[i*k+2]=1
        }
    }else if(mode==="quadratic2d"){
        k=6
        design=new Float64Array(n*k)
        for(let i=0;i<n;i++){
            const x=measuredMz[i], y=intensity[i]
            design[i*k]=x*x
            design[i*k+1]=y*y
            design[i*k+2]=x*y
            design[i*k+3]=x
            design[i*k+4]=y
            design[i*k+5]=1
        }
    }else if(mode==="cubic2d"){
        k=10
        design=new Float64Array(n*k)
        for(let i=0;i<n;i++){
            const x=measuredMz[i], y=intensity[i]
            design[i*k]=x*x*x
            design[i*k+1]=x*x*y
            design[i*k+2]=x*y*y
            design[i*k+3]=y*y*y
            design[i*k+4]=x*x
            design[i*k+5]=x*y
            design[i*k+6]=y*y
            design[i*k+7]=x
            design[i*k+8]=y
            design[i*k+9]=1
        }
    }else{
        return {coeffs:new Float64Array([0,0,0]),rmse:0}
    }

    const coeffs=solveNormalEqs2DJS(design,errorPpm,k)
    let rmse=0
    for(let i=0;i<n;i++){
        const x=measuredMz[i], y=intensity[i]
        let pred=0
        if(mode==="linear2d"){
            pred=coeffs[0]*x+coeffs[1]*y+coeffs[2]
        }else if(mode==="quadratic2d"){
            pred=coeffs[0]*x*x+coeffs[1]*y*y+coeffs[2]*x*y+coeffs[3]*x+coeffs[4]*y+coeffs[5]
        }else if(mode==="cubic2d"){
            pred=coeffs[0]*x*x*x+coeffs[1]*x*x*y+coeffs[2]*x*y*y+coeffs[3]*y*y*y
                +coeffs[4]*x*x+coeffs[5]*x*y+coeffs[6]*y*y+coeffs[7]*x+coeffs[8]*y+coeffs[9]
        }
        rmse+=(pred-errorPpm[i])**2
    }
    rmse=Math.sqrt(rmse/n)
    return {coeffs,rmse}
}

function calibrationApply2DJS(x,y,coeffs,mode){
    if(!coeffs || !coeffs.length) return {x:Float64Array.from(x)}
    const n=x.length
    const result=new Float64Array(n)
    for(let i=0;i<n;i++){
        const xi=x[i], yi=y[i]
        let errorPpm=0
        if(mode==="linear2d"){
            errorPpm=coeffs[0]*xi+coeffs[1]*yi+coeffs[2]
        }else if(mode==="quadratic2d"){
            errorPpm=coeffs[0]*xi*xi+coeffs[1]*yi*yi+coeffs[2]*xi*yi+coeffs[3]*xi+coeffs[4]*yi+coeffs[5]
        }else if(mode==="cubic2d"){
            errorPpm=coeffs[0]*xi*xi*xi+coeffs[1]*xi*xi*yi+coeffs[2]*xi*yi*yi+coeffs[3]*yi*yi*yi
                +coeffs[4]*xi*xi+coeffs[5]*xi*yi+coeffs[6]*yi*yi+coeffs[7]*xi+coeffs[8]*yi+coeffs[9]
        }
        result[i]=xi/(1+errorPpm/1e6)
    }
    return {x:result}
}

function solveNormalEqs2DJS(design,target,k){
    const n=target.length
    const xtx=new Float64Array(k*k)
    const xty=new Float64Array(k)
    for(let i=0;i<k;i++){
        for(let j=0;j<k;j++){
            let sum=0
            for(let r=0;r<n;r++){
                sum+=design[r*k+i]*design[r*k+j]
            }
            xtx[i*k+j]=sum
        }
        let sum=0
        for(let r=0;r<n;r++){
            sum+=design[r*k+i]*target[r]
        }
        xty[i]=sum
    }
    return gaussianElimination2DJS(xtx,xty,k)
}

function gaussianElimination2DJS(a,b,k){
    const m=new Float64Array(k*(k+1))
    for(let i=0;i<k;i++){
        for(let j=0;j<k;j++) m[i*(k+1)+j]=a[i*k+j]
        m[i*(k+1)+k]=b[i]
    }
    for(let col=0;col<k;col++){
        let pivot=col
        for(let row=col+1;row<k;row++){
            if(Math.abs(m[row*(k+1)+col])>Math.abs(m[pivot*(k+1)+col])){
                pivot=row
            }
        }
        if(Math.abs(m[pivot*(k+1)+col])<1e-12) return new Float64Array(k).fill(0)
        if(pivot!==col){
            for(let j=col;j<=k;j++){
                const tmp=m[col*(k+1)+j]
                m[col*(k+1)+j]=m[pivot*(k+1)+j]
                m[pivot*(k+1)+j]=tmp
            }
        }
        const pivVal=m[col*(k+1)+col]
        for(let j=col;j<=k;j++) m[col*(k+1)+j]/=pivVal
        for(let row=0;row<k;row++){
            if(row===col) continue
            const factor=m[row*(k+1)+col]
            if(factor===0) continue
            for(let j=col;j<=k;j++){
                m[row*(k+1)+j]-=factor*m[col*(k+1)+j]
            }
        }
    }
    const x=new Float64Array(k)
    for(let i=0;i<k;i++) x[i]=m[i*(k+1)+k]
    return x
}

//JS fallback for Thermo .raw parsing - returns empty result since we can't parse .raw in pure JS
function parseThermoRawJS(data){
    console.warn("Thermo .raw parsing requires WASM build with thermorawfile crate")
    return {spectra:[],file_version:0,scan_count:0}
}

function computePersistentHomology0D_JS(data,mode="sublevel"){
    const n=data.length
    if(n===0) return new Float64Array(0)
    const isSuperlevel=mode==="superlevel"
    const parent=new Uint32Array(n)
    const birthVal=new Float64Array(n)
    const birthIdx=new Uint32Array(n)
    for(let i=0;i<n;i++){
        parent[i]=i
        birthVal[i]=data[i]
        birthIdx[i]=i
    }
    function find(i){
        let root=i
        while(root!==parent[root]) root=parent[root]
        while(i!==root){
            const next=parent[i]
            parent[i]=root
            i=next
        }
        return root
    }
    const edges=new Array(n-1)
    for(let i=0;i<n-1;i++){
        const w=isSuperlevel?Math.min(data[i],data[i+1]):Math.max(data[i],data[i+1])
        edges[i]={u:i,v:i+1,weight:w}
    }
    if(isSuperlevel){
        edges.sort((a,b)=>b.weight-a.weight)
    }else{
        edges.sort((a,b)=>a.weight-b.weight)
    }
    const births=[]
    const deaths=[]
    const birthIndices=[]
    const deathIndices=[]
    for(let k=0;k<edges.length;k++){
        const edge=edges[k]
        const ru=find(edge.u)
        const rv=find(edge.v)
        if(ru!==rv){
            const bu=birthVal[ru]
            const bv=birthVal[rv]
            const uIsOlder=isSuperlevel
                ?(bu>bv||(bu===bv&&ru<rv))
                :(bu<bv||(bu===bv&&ru<rv))
            const death=edge.weight
            const deathIdx=isSuperlevel
                ?(data[edge.u]<=data[edge.v]?edge.u:edge.v)
                :(data[edge.u]>=data[edge.v]?edge.u:edge.v)
            if(uIsOlder){
                births.push(bv)
                deaths.push(death)
                birthIndices.push(birthIdx[rv])
                deathIndices.push(deathIdx)
                parent[rv]=ru
            }else{
                births.push(bu)
                deaths.push(death)
                birthIndices.push(birthIdx[ru])
                deathIndices.push(deathIdx)
                parent[ru]=rv
            }
        }
    }
    //A superlevel component containing the global maximum never dies:
    //return it explicitly as (birth=max, death=0) for downstream filtering.
    if(isSuperlevel){
        let maximumIdx=0
        for(let i=1;i<n;i++){
            if(data[i]>data[maximumIdx]) maximumIdx=i
        }
        births.push(data[maximumIdx])
        deaths.push(0)
        birthIndices.push(maximumIdx)
        deathIndices.push(maximumIdx)
    }
    const pairCount=births.length
    const result=new Float64Array(pairCount*4)
    result.set(births,0)
    result.set(deaths,pairCount)
    result.set(birthIndices,pairCount*2)
    result.set(deathIndices,pairCount*3)
    return result
}

self.addEventListener("message",async e=>{
    const {id,kernel,payload}=e.data
    try{
        const kernelFn=kernels[kernel]
        if(!kernelFn){
            throw new Error(`unknown kernel "${kernel}"`)
        }
        const result=await kernelFn(payload)
        const transfer=Object.values(result??{})
            .filter(value=>value instanceof Float64Array)
            .map(value=>value.buffer)
            .filter((buffer,index,buffers)=>buffers.indexOf(buffer)===index)
        self.postMessage({id,ok:true,result},transfer)
    }catch(err){
        self.postMessage({id,ok:false,error:err?.message??String(err)})
    }
})
