//Log-histogram bar density, kept in step with LOG_BINS_PER_DECADE in trim.rs
const LOG_BINS_PER_DECADE=6
const MIN_LOG_BINS=8
//Anti-radio, kept in step with antiradio.rs: the MAD->sigma conversion and the
//number of measurable widths below which there is no population to judge from.
const MAD_TO_SIGMA=1.4826
const MIN_PEAKS_FOR_REFERENCE=8
//A gap must clear the noise to be read as a population split. Kept in step with
//MIN_GAP_OVER_NOISE in antiradio.rs.
const MIN_GAP_OVER_NOISE=8

//WorkerPool: keeps a set of module workers alive and dispatches compute
//tasks to them, so heavy kernels never run on the main thread.
/* Le réseau de mesures, comme dans le worker: `forest.js` n'a AUCUNE dépendance,
   donc l'importer ici n'ajoute rien au graphe de dépendances du thread
   principal. C'est ce qui autorise le repli local à être le VRAI calcul et non
   une approximation. */
import {growForest} from "./forest.js"
class WorkerPool{
    constructor(size){
        this.size=Math.max(1,Math.min(size??((navigator.hardwareConcurrency||2)-1),4))
        this.workers=[]
        this.queue=[]
        this.counter=0
    }
    spawn(){
        const worker=new Worker(new URL("./kernelWorker.js",import.meta.url),{type:"module"})
        worker.poolTasks=new Map()
        worker.addEventListener("message",e=>{
            const {id,ok,result,error}=e.data
            const task=worker.poolTasks.get(id)
            if(!task){
                return
            }
            worker.poolTasks.delete(id)
            if(ok){
                task.resolve(result)
            }else{
                task.reject(new Error(error))
            }
            this.dispatch()
        })
        worker.addEventListener("error",e=>{
            for(const task of worker.poolTasks.values()){
                task.reject(new Error(e.message||"worker error"))
            }
            worker.poolTasks.clear()
            const index=this.workers.indexOf(worker)
            if(index!==-1){
                this.workers.splice(index,1)
            }
            this.dispatch()
        })
        this.workers.push(worker)
        return worker
    }
    dispatch(){
        while(this.queue.length){
            const worker=this.workers.find(w=>w.poolTasks.size===0)
            if(!worker){
                return
            }
            const task=this.queue.shift()
            worker.poolTasks.set(task.id,task)
            worker.postMessage({id:task.id,kernel:task.kernel,payload:task.payload},task.transfer)
        }
    }
    run(kernel,payload={},transfer=[]){
        if(typeof Worker==="undefined"){
            return Promise.resolve(runKernelLocally(kernel,payload))
        }
        return new Promise((resolve,reject)=>{
            const id=`${++this.counter}-${Date.now()}`
            this.queue.push({id,kernel,payload,transfer,resolve,reject})
            if(!this.workers.length){
                this.spawn()
            }
            this.dispatch()
        })
    }
}

//JS fallback used when workers are not available at all: same semantics as
//the addScalar kernel of kernelWorker.js
function runKernelLocally(kernel,payload){
    if(kernel==="fkmd"){
        //same two steps as fkmd.rs, same order: the defect reads the NEW x
        const {core,params}=payload
        const mz=params?.mz??0
        if(!Number.isFinite(mz)||mz<=0) return {core:new Float64Array(0)}
        const reference=Math.round(mz)
        if(!(reference>0)) return {core:new Float64Array(0)}
        const factor=reference/mz
        const n=Math.floor((core?.length??0)/2)
        const result=new Float64Array(n*2)
        for(let i=0;i<n;i++){
            const scaled=core[i]*factor
            result[i]=scaled
            result[n+i]=scaled-Math.round(scaled)
        }
        return {core:result}
    }
    if(kernel==="vankrevelen"){
        const {core,params}=payload
        const scale_x=params?.scale_x??1.0
        const scale_y=params?.scale_y??1.0
        const offset_x=params?.offset_x??0.0
        const offset_y=params?.offset_y??0.0
        if(!core||core.length<3) return {core:new Float64Array(0)}
        const n_formulas=Math.floor(core.length/3)
        const xs=[]
        const ys=[]
        for(let i=0;i<n_formulas;i++){
            const c=core[i*3]
            const h=core[i*3+1]
            const o=core[i*3+2]
            if(c>0){
                xs.push(o/c*scale_x+offset_x)
                ys.push(h/c*scale_y+offset_y)
            }
        }
        const n=xs.length
        const result=new Float64Array(n*2)
        result.set(xs,0)
        result.set(ys,n)
        return {core:result}
    }
    if(kernel==="addScalar"){
        const {core,params}=payload
        const scalar=params?.scalar??1
        const result=new Float64Array(core.length)
        for(let k=0;k<core.length;k++){
            result[k]=core[k]+scalar
        }
        //same shape as the worker kernels: {core: Float64Array}
        return {core:result}
    }
    if(kernel==="legacyPersistentHomology0D"){
        const {core,params}=payload
        const mode=params?.mode??"sublevel"
        const n=core.length
        if(n===0) return {pairs:new Float64Array(0)}
        const isSuperlevel=mode==="superlevel"
        const parent=new Uint32Array(n)
        const birthVal=new Float64Array(n)
        const birthIdx=new Uint32Array(n)
        for(let i=0;i<n;i++){
            parent[i]=i
            birthVal[i]=core[i]
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
            const w=isSuperlevel?Math.min(core[i],core[i+1]):Math.max(core[i],core[i+1])
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
                    ?(core[edge.u]<=core[edge.v]?edge.u:edge.v)
                    :(core[edge.u]>=core[edge.v]?edge.u:edge.v)
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
                if(core[i]>core[maximumIdx]) maximumIdx=i
            }
            births.push(core[maximumIdx])
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
        return {pairs:result}
    }
    if(kernel==="persistentHomology0D"){
        return runPersistenceAnalysisLocal(payload)
    }
    if(kernel==="classifyPersistence0D"){
        return runPersistenceClassificationLocal(payload)
    }
    if(kernel==="antiRadioFilter"){
        return runAntiRadioFilterLocal(payload)
    }
    if(kernel==="antiRadioGuessZ"){
        return runAntiRadioGuessZLocal(payload)
    }
    if(kernel==="trimGuess"){
        return runTrimGuessLocal(payload)
    }
    if(kernel==="trimApply"){
        return runTrimApplyLocal(payload)
    }
    if(kernel==="trimHistogram"){
        return runTrimHistogramLocal(payload)
    }
    if(kernel==="attributionCriblemixed"){
        /* PAS DE WORKER, donc pas de WASM ICI: on rend `rows: null` et le NŒUD
           repasse par `attributeSpectrum`, qui est le même crible. Le recalculer
           dans ce worker local dupliquerait la physique en JS pour rien. */
        return {rows:null,fallback:"pas de worker: le repli JS fait le crible"}
    }
    if(kernel==="attributionForest"){
        /* ICI LE REPLI EST FAIT ICI, et la raison est l'INVERSE du crible.

           Le crible melange la chimie (une formule par lecture) et la
           combinatoire, donc le renvoyer au nœud réutilise `attributeSpectrum`
           au lieu de le réécrire. Le réseau, lui, ne connaît que des NOMBRES:
           il n'a aucune chimie à refaire, et rendre `null` obligerait le thread
           principal à recalculer un arbre qu'un worker déjà présent savait
           calculer. C'est le même résultat par le même code — `growForest` est
           l'ORACLE du test de parité — donc rien n'est approximé. */
        const {params={}}=payload
        return {forest:growForest(params),fallback:"pas de worker: le repli JS fait l'arbre"}
    }
    if(kernel==="calibrationFit"){
        return runCalibrationFitLocal(payload)
    }
    if(kernel==="calibrationApply"){
        return runCalibrationApplyLocal(payload)
    }
    if(kernel==="calibrationFit2D"){
        return runCalibrationFit2DLocal(payload)
    }
    if(kernel==="calibrationApply2D"){
        return runCalibrationApply2DLocal(payload)
    }
    throw new Error(`unknown kernel "${kernel}"`)
}

//Same semantics as trim.rs trim_guess / trim_apply, mirrored here so the flow
//still resolves on a browser with no Worker at all.
function runTrimGuessLocal({core,params={}}){
    const stride=params.stride??1
    const n=Math.floor(core.length/stride)
    const y=stride===2?core.subarray(n):core
    const method=params.method??"passthrough"
    const k=params.k??5
    const window=(Number.isFinite(params.window)&&params.window>=3)?Math.round(params.window):9
    const threshold=params.threshold??0.1
    if(method==="madResidual"){
        //relative: baseline + k*sigma, never the absolute k*sigma
        return localBaselineLevel(y)+localResidualSigma(y,window)*k
    }
    if(method==="intensityThreshold") return threshold
    //passthrough, and any unknown name: nothing is cut
    return -Infinity
}
function runTrimApplyLocal({core,params={}}){
    const stride=params.stride??1
    const n=Math.floor(core.length/stride)
    const y=stride===2?core.subarray(n):core
    //a non-finite bound means "no cut on that side"
    const low=Number.isFinite(params.lowBound)?params.lowBound:-Infinity
    const high=Number.isFinite(params.highBound)?params.highBound:Infinity
    const xs=[],ys=[],indices=[]
    for(let i=0;i<n;i++){
        const value=y[i]
        //a NaN compares false against every bound: filter it explicitly
        if(Number.isNaN(value)) continue
        if(value<low||(Number.isFinite(high)&&value>high)) continue
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
        lowBound:low,
        highBound:high
    }
}
function localResidualSigma(y,window){
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
function localBaselineLevel(y){
    const values=Array.from(y).filter(v=>!Number.isNaN(v)).sort((a,b)=>a-b)
    if(!values.length) return 0
    return values.length%2===1
        ?values[(values.length-1)/2]
        :0.5*(values[values.length/2-1]+values[values.length/2])
}
function runTrimHistogramLocal({core,params={}}){
    const stride=params.stride??1
    const bins=Math.max(1,params.bins??64)
    const scale=params.scale==="log"?"log":"linear"
    const n=Math.floor(core.length/stride)
    const y=stride===2?core.subarray(n):core
    if(!n) return {centres:new Float64Array(0),counts:new Float64Array(0),min:0,max:0,dropped:0}
    if(scale==="log") return localLogHistogram(y,bins)
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
        counts[width>0?Math.min(bins-1,Math.max(0,Math.floor((v-min)/width))):0]+=1
    }
    const step=width>0?width:1
    const centres=new Float64Array(bins)
    for(let i=0;i<bins;i++) centres[i]=min+(i+0.5)*step
    return {centres,counts,min,max,dropped:0}
}
//Evenly spaced bins in log10(value), mirroring log_histogram in trim.rs: the
//centres are GEOMETRIC means, because the value axis is log-scaled and only a
//geometric mean lands at the centre of its slot.
function localLogHistogram(y,bins){
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

function runPersistenceAnalysisLocal({core,params={}}){
    const stride=params.stride??1, mode=params.mode??"sublevel", n=Math.floor(core.length/stride)
    const y=stride===2?core.subarray(n):core
    const raw=runKernelLocallyOldH0(y,mode), count=raw.length/4
    const rows=Array.from({length:count},(_,i)=>{const idx=Math.round(raw[count*2+i]);return{x:stride===2?core[idx]:idx,birth:raw[i],death:raw[count+i],idx}})
    rows.sort((a,b)=>a.x-b.x||a.idx-b.idx)
    const births=new Float64Array(count),deaths=new Float64Array(count),pointsX=new Float64Array(count),pointsY=new Float64Array(count),birthIndices=new Float64Array(count)
    let sumBirth=0,sumDeath=0
    rows.forEach((p,i)=>{births[i]=p.birth;deaths[i]=p.death;pointsX[i]=p.x;pointsY[i]=y[p.idx];birthIndices[i]=p.idx;sumBirth+=p.birth;sumDeath+=p.death})
    const slope=sumBirth>0&&Number.isFinite(sumDeath/sumBirth)?Math.min(1-1e-12,Math.max(1e-9,sumDeath/sumBirth)):1-1e-12
    return {births,deaths,pointsX,pointsY,birthIndices,slope}
}
function runKernelLocallyOldH0(data,mode){
    const n=data.length
    if(!n) return new Float64Array(0)
    const superlevel=mode==="superlevel", parent=Array.from({length:n},(_,i)=>i), birthIdx=Array.from({length:n},(_,i)=>i), births=[],deaths=[],bIdx=[],dIdx=[]
    const find=i=>{let r=i;while(r!==parent[r])r=parent[r];while(i!==r){const p=parent[i];parent[i]=r;i=p}return r}
    const edges=Array.from({length:Math.max(0,n-1)},(_,i)=>({u:i,v:i+1,w:superlevel?Math.min(data[i],data[i+1]):Math.max(data[i],data[i+1])}))
    edges.sort((a,b)=>superlevel?b.w-a.w:a.w-b.w)
    for(const e of edges){const ru=find(e.u),rv=find(e.v);if(ru===rv)continue;const bu=data[birthIdx[ru]],bv=data[birthIdx[rv]],older=superlevel?(bu>bv||(bu===bv&&ru<rv)):(bu<bv||(bu===bv&&ru<rv));const death=e.w,di=superlevel?(data[e.u]<=data[e.v]?e.u:e.v):(data[e.u]>=data[e.v]?e.u:e.v);if(older){births.push(bv);deaths.push(death);bIdx.push(birthIdx[rv]);dIdx.push(di);parent[rv]=ru}else{births.push(bu);deaths.push(death);bIdx.push(birthIdx[ru]);dIdx.push(di);parent[ru]=rv}}
    if(superlevel){let mi=0;for(let i=1;i<n;i++)if(data[i]>data[mi])mi=i;births.push(data[mi]);deaths.push(0);bIdx.push(mi);dIdx.push(mi)}
    const c=births.length,out=new Float64Array(c*4);births.forEach((v,i)=>{out[i]=v;out[c+i]=deaths[i];out[2*c+i]=bIdx[i];out[3*c+i]=dIdx[i]});return out
}
function runPersistenceClassificationLocal({births,deaths,pointsX,pointsY,pointsIndex,params={}}){
    const count=births.length,keptBirths=new Float64Array(count),keptDeaths=new Float64Array(count),keptPointsX=new Float64Array(count),keptPointsY=new Float64Array(count),keptIndices=new Float64Array(count),discardedBirths=new Float64Array(count),discardedDeaths=new Float64Array(count);let kept=0,discarded=0
    for(let i=0;i<count;i++){const pass=deaths[i]<=params.slope*births[i]||deaths[i]<=params.slope*births[i]+1e-9*Math.max(1,Math.abs(births[i]));if(pass){keptBirths[kept]=births[i];keptDeaths[kept]=deaths[i];keptPointsX[kept]=pointsX[i];keptPointsY[kept]=pointsY[i];keptIndices[kept]=pointsIndex?.[i]??NaN;kept++}else{discardedBirths[discarded]=births[i];discardedDeaths[discarded]=deaths[i];discarded++}}
    return {keptBirths:keptBirths.subarray(0,kept),keptDeaths:keptDeaths.subarray(0,kept),keptPointsX:keptPointsX.subarray(0,kept),keptPointsY:keptPointsY.subarray(0,kept),keptIndices:keptIndices.subarray(0,kept),discardedBirths:discardedBirths.subarray(0,discarded),discardedDeaths:discardedDeaths.subarray(0,discarded),keptCount:kept}
}
//Mirrors antiradio.rs anti_radio_filter. Same reason as the constants above:
//no Worker must not mean no filtering, and a browser without one still has to
//behave like the wasm path rather than quietly passing every peak through.
//Mirrors antiradio.rs anti_radio_guess_z. Returns ONE number, like trim_guess:
//the shell only needs the z, and rebuilding the whole width list to read one
//value off it is the allocation the trimmer comment warns about.
function runAntiRadioGuessZLocal({core,pointsIndex,params={}}){
    const stride=params.stride??2
    const n=Math.floor(core.length/stride)
    const x=stride===2?core.subarray(0,n):null
    const y=stride===2?core.subarray(n):core
    if(!x) return 3
    const measured=[]
    for(let i=0;i<(pointsIndex?.length??0);i++){
        const idx=pointsIndex[i]
        if(!Number.isFinite(idx)) continue
        const w=localWidthPpm(x,y,Math.round(idx))
        if(Number.isFinite(w)&&w>0) measured.push(w)
    }
    if(measured.length<MIN_PEAKS_FOR_REFERENCE) return 3
    measured.sort((a,b)=>a-b)
    const reference=localMedian(measured)
    const spread=MAD_TO_SIGMA*localMedian(measured.map(w=>Math.abs(w-reference)))
    if(!(spread>0)) return 3
    const steps=[]
    for(let i=1;i<measured.length;i++) steps.push((measured[i]-measured[i-1])/spread)
    if(!steps.length) return 3
    const bestGap=Math.max(...steps)
    if(!(bestGap>MIN_GAP_OVER_NOISE*localMedian(steps))) return 3
    const z=bestGap/2
    return Number.isFinite(z)&&z>0?z:3
}
function runAntiRadioFilterLocal({core,pointsX,pointsY,pointsIndex,params={}}){
    const stride=params.stride??2,z=params.z??3
    const n=Math.floor(core.length/stride)
    const x=stride===2?core.subarray(0,n):null
    const y=stride===2?core.subarray(n):core
    const count=pointsX.length
    const widths=new Float64Array(count)
    for(let i=0;i<count;i++){
        const idx=pointsIndex?.[i]
        widths[i]=Number.isFinite(idx)?localWidthPpm(x,y,Math.round(idx)):NaN
    }
    const measured=Array.from(widths).filter(w=>Number.isFinite(w)&&w>0)
    let reference=NaN,threshold=Infinity
    if(measured.length>=MIN_PEAKS_FOR_REFERENCE){
        reference=localMedian(measured)
        const spread=MAD_TO_SIGMA*localMedian(measured.map(w=>Math.abs(w-reference)))
        threshold=reference+(Number.isFinite(z)?z:3)*spread
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
function localWidthPpm(x,y,peak){
    const n=y.length
    if(peak<0||peak>=n||!x) return NaN
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
function localMedian(values){
    if(!values.length) return NaN
    const sorted=Array.from(values).sort((a,b)=>a-b),n=sorted.length
    return n%2===1?sorted[n/2]:0.5*(sorted[n/2-1]+sorted[n/2])
}

function runCalibrationFitLocal({refX,refY,mode}){
    const n=refX.length
    if(n<2) return {coeffs:[1,0],rmse:0}
    if(mode==="linear"){
        let sumX=0,sumY=0,sumXY=0,sumXX=0
        for(let i=0;i<n;i++){
            sumX+=refX[i]
            sumY+=refY[i]
            sumXY+=refX[i]*refY[i]
            sumXX+=refX[i]*refX[i]
        }
        const denom=n*sumXX-sumX*sumX
        if(!Number.isFinite(denom) || denom===0) return {coeffs:[1,0],rmse:0}
        const a=(n*sumXY-sumX*sumY)/denom
        const b=(sumY*sumXX-sumX*sumXY)/denom
        let rmse=0
        for(let i=0;i<n;i++){
            const pred=a*refX[i]+b
            rmse+=(pred-refY[i])**2
        }
        rmse=Math.sqrt(rmse/n)
        return {coeffs:[a,b],rmse}
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
        const coeffs=solveNormalEqs(XT,Y,3)
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
        const coeffs=solveNormalEqs(XT,Y,4)
        let rmse=0
        for(let i=0;i<n;i++){
            const pred=coeffs[0]*refX[i]*refX[i]*refX[i]+coeffs[1]*refX[i]*refX[i]+coeffs[2]*refX[i]+coeffs[3]
            rmse+=(pred-refY[i])**2
        }
        rmse=Math.sqrt(rmse/n)
        return {coeffs,rmse}
    }
    return {coeffs:[1,0],rmse:0}
}

function solveNormalEqs(XT,Y,k){
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
    return gaussianElimination(XTX,XTY,k)
}

function gaussianElimination(A,b,k){
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

function runCalibrationApplyLocal({x,coeffs,mode}){
    if(!coeffs || !coeffs.length) return {x}
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

function runCalibrationFit2DLocal({measuredMz,intensity,errorPpm,mode}){
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

    const coeffs=solveNormalEqs2DLocal(design,errorPpm,k)
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

function runCalibrationApply2DLocal({x,y,coeffs,mode}){
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

function solveNormalEqs2DLocal(design,target,k){
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
    return gaussianElimination2DLocal(xtx,xty,k)
}

function gaussianElimination2DLocal(a,b,k){
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

export const computePool=new WorkerPool()
