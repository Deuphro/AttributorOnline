//Kernel worker: loads its own instance of the attribrustor WASM module and
//executes compute kernels off the main thread, so the UI never blocks.
import init,* as rust from "../XOP/rust-extension/pkg/attribrustor.js"

let wasmReady=null
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
                slope:analysis.slope
            }
        }catch(err){
            console.warn("[kernelWorker] rust H0 unavailable, JS fallback:",err)
            result=analysePersistence0DJS(core,stride,mode)
        }
        return result
    },
    async classifyPersistence0D({births,deaths,pointsX,pointsY,params}){
        const slope=params?.slope
        if(!Number.isFinite(slope)) throw new Error("classification requires a finite slope")
        let result
        try{
            await ensureWasm()
            if(typeof rust.classify_persistence_0d!=="function"){
                throw new Error("rust classify_persistence_0d is missing (stale pkg build?)")
            }
            const classification=rust.classify_persistence_0d(births,deaths,pointsX,pointsY,slope)
            result={
                keptBirths:toFloat64(classification.kept_births),
                keptDeaths:toFloat64(classification.kept_deaths),
                keptPointsX:toFloat64(classification.kept_points_x),
                keptPointsY:toFloat64(classification.kept_points_y),
                discardedBirths:toFloat64(classification.discarded_births),
                discardedDeaths:toFloat64(classification.discarded_deaths),
                keptCount:classification.kept_count
            }
        }catch(err){
            console.warn("[kernelWorker] rust classification unavailable, JS fallback:",err)
            result=classifyPersistence0DJS(births,deaths,pointsX,pointsY,slope)
        }
        return result
    },
    async trimWave({core,params}){
        const method=params?.method??"passthrough"
        const stride=params?.stride??1
        //a null/undefined bound means "the method decides": NaN is what crosses
        //the wasm boundary for that, and the kernel reads it back as such
        const low=Number.isFinite(params?.lowBound)?params.lowBound:NaN
        const high=Number.isFinite(params?.highBound)?params.highBound:NaN
        const k=params?.k??5
        const window=params?.window??9
        const threshold=params?.threshold??0.1
        let result
        try{
            await ensureWasm()
            if(typeof rust.trim_wave!=="function"){
                throw new Error("rust trim_wave is missing (stale pkg build?)")
            }
            const trimmed=rust.trim_wave(core,stride,method,low,high,k,window,threshold)
            //wasm-bindgen exposes the #[wasm_bindgen(getter)] fields as plain
            //properties here, exactly like PersistenceAnalysis.births
            result={
                pointsX:toFloat64(trimmed.points_x),
                pointsY:toFloat64(trimmed.points_y),
                keptIndices:toFloat64(trimmed.kept_indices),
                keptCount:trimmed.kept_count,
                totalCount:trimmed.total_count,
                lowBound:trimmed.low_bound,
                sigma:trimmed.sigma
            }
        }catch(err){
            console.warn("[kernelWorker] rust trim unavailable, JS fallback:",err)
            result=trimWaveJS(core,stride,method,low,high,k,window,threshold)
        }
        return result
    },
    async trimHistogram({core,params}){
        const stride=params?.stride??1
        const bins=Math.max(1,params?.bins??64)
        let result
        try{
            await ensureWasm()
            if(typeof rust.trim_histogram!=="function"){
                throw new Error("rust trim_histogram is missing (stale pkg build?)")
            }
            const histogram=rust.trim_histogram(core,stride,bins)
            result={
                centres:toFloat64(histogram.centres),
                counts:toFloat64(histogram.counts),
                min:histogram.min,
                max:histogram.max
            }
        }catch(err){
            console.warn("[kernelWorker] rust histogram unavailable, JS fallback:",err)
            result=trimHistogramJS(core,stride,bins)
        }
        return result
    }
}

function toFloat64(value){
    return value instanceof Float64Array?value:new Float64Array(value)
}

//Same semantics as trim.rs trim_wave, so a stale or failed wasm build still
//resolves the flow instead of breaking it.
function trimWaveJS(core,stride,method,lowBound,highBound,k,window,threshold){
    const n=Math.floor(core.length/stride)
    const y=stride===2?core.subarray(n):core
    const kSafe=Number.isFinite(k)?k:5
    const windowSafe=Number.isFinite(window)&&window>=3?Math.round(window):9
    const thresholdSafe=Number.isFinite(threshold)?threshold:0.1
    const sigma=method==="madResidual"?residualSigmaJS(y,windowSafe):0
    //relative test: baseline + k*sigma, mirroring baseline_level in trim.rs
    const methodLow=method==="madResidual"?baselineLevelJS(y)+sigma*kSafe
        :(method==="intensityThreshold"?thresholdSafe:-Infinity)
    //a FINITE cursor is authoritative: the method only seeds an absent one, it
    //is not a floor. max() here would make the guessed threshold impossible to
    //drag past, which is the whole point of the cursors
    const low=Number.isFinite(lowBound)?lowBound:methodLow
    const xs=[],ys=[],indices=[]
    for(let i=0;i<n;i++){
        const value=y[i]
        if(Number.isNaN(value)) continue
        if(value<low||(Number.isFinite(highBound)&&value>highBound)) continue
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
        sigma
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
function trimHistogramJS(core,stride,bins){
    const n=Math.floor(core.length/stride)
    const y=stride===2?core.subarray(n):core
    if(!n) return {centres:new Float64Array(0),counts:new Float64Array(0),min:0,max:0}
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
    return {centres,counts,min,max}
}

function analysePersistence0DJS(core,stride=1,mode="sublevel"){
    const n=Math.floor(core.length/stride), offset=stride===2?n:0
    const y=stride===2?core.subarray(offset):core
    const raw=computePersistentHomology0D_JS(y,mode),count=raw.length/4
    const rows=Array.from({length:count},(_,i)=>{const idx=Math.round(raw[count*2+i]);return{x:stride===2?core[idx]:idx,birth:raw[i],death:raw[count+i],idx}})
    rows.sort((a,b)=>a.x-b.x||a.idx-b.idx)
    const births=new Float64Array(count),deaths=new Float64Array(count),pointsX=new Float64Array(count),pointsY=new Float64Array(count),birthIndices=new Float64Array(count)
    let sumBirth=0,sumDeath=0
    rows.forEach((p,i)=>{births[i]=p.birth;deaths[i]=p.death;pointsX[i]=p.x;pointsY[i]=y[p.idx];birthIndices[i]=p.idx;sumBirth+=p.birth;sumDeath+=p.death})
    const slope=sumBirth>0&&Number.isFinite(sumDeath/sumBirth)?clampJS(sumDeath/sumBirth):clampJS(keepAllSlopeJS(births,deaths))
    return {births,deaths,pointsX,pointsY,birthIndices,slope}
}
function classifyPersistence0DJS(births,deaths,pointsX,pointsY,slope){
    const count=births.length
    const keptBirths=new Float64Array(count),keptDeaths=new Float64Array(count),keptPointsX=new Float64Array(count),keptPointsY=new Float64Array(count),discardedBirths=new Float64Array(count),discardedDeaths=new Float64Array(count)
    let kept=0,discarded=0
    for(let i=0;i<count;i++){
        if(deaths[i]<=slope*births[i]||deaths[i]<=slope*births[i]+1e-9*Math.max(1,Math.abs(births[i]))){
            keptBirths[kept]=births[i];keptDeaths[kept]=deaths[i];keptPointsX[kept]=pointsX[i];keptPointsY[kept]=pointsY[i];kept++
        }else{discardedBirths[discarded]=births[i];discardedDeaths[discarded]=deaths[i];discarded++}
    }
    return {keptBirths:keptBirths.subarray(0,kept),keptDeaths:keptDeaths.subarray(0,kept),keptPointsX:keptPointsX.subarray(0,kept),keptPointsY:keptPointsY.subarray(0,kept),discardedBirths:discardedBirths.subarray(0,discarded),discardedDeaths:discardedDeaths.subarray(0,discarded),keptCount:kept}
}
function clampJS(v){return Number.isFinite(v)?Math.min(1-1e-12,Math.max(1e-9,v)):1-1e-12}
function keepAllSlopeJS(births,deaths){let r=0;for(let i=0;i<births.length;i++)if(births[i]>0)r=Math.max(r,deaths[i]/births[i]);return r}

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
