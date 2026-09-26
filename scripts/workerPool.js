//Log-histogram bar density, kept in step with LOG_BINS_PER_DECADE in trim.rs
const LOG_BINS_PER_DECADE=6
const MIN_LOG_BINS=8

//WorkerPool: keeps a set of module workers alive and dispatches compute
//tasks to them, so heavy kernels never run on the main thread.
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
    if(kernel==="trimWave"){
        return runTrimWaveLocal(payload)
    }
    if(kernel==="trimHistogram"){
        return runTrimHistogramLocal(payload)
    }
    throw new Error(`unknown kernel "${kernel}"`)
}

//Same semantics as trim.rs trim_wave, mirrored here so the flow still resolves
//on a browser with no Worker at all.
function runTrimWaveLocal({core,params={}}){
    const stride=params.stride??1
    const n=Math.floor(core.length/stride)
    const y=stride===2?core.subarray(n):core
    const method=params.method??"passthrough"
    const k=params.k??5
    const window=(Number.isFinite(params.window)&&params.window>=3)?Math.round(params.window):9
    const threshold=params.threshold??0.1
    const lowCursor=Number.isFinite(params.lowBound)?params.lowBound:NaN
    const highCursor=Number.isFinite(params.highBound)?params.highBound:NaN
    const sigma=method==="madResidual"?localResidualSigma(y,window):0
    //relative test: baseline + k*sigma, mirroring baseline_level in trim.rs
    const methodLow=method==="madResidual"?localBaselineLevel(y)+sigma*k:(method==="intensityThreshold"?threshold:-Infinity)
    //a FINITE cursor is authoritative: the method only seeds an absent one, it
    //is not a floor. max() here would make the guessed threshold impossible to
    //drag past, which is the whole point of the cursors
    const low=Number.isFinite(lowCursor)?lowCursor:methodLow
    const xs=[],ys=[],indices=[]
    for(let i=0;i<n;i++){
        const value=y[i]
        if(Number.isNaN(value)) continue
        if(value<low||(Number.isFinite(highCursor)&&value>highCursor)) continue
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
function runPersistenceClassificationLocal({births,deaths,pointsX,pointsY,params={}}){
    const count=births.length,keptBirths=new Float64Array(count),keptDeaths=new Float64Array(count),keptPointsX=new Float64Array(count),keptPointsY=new Float64Array(count),discardedBirths=new Float64Array(count),discardedDeaths=new Float64Array(count);let kept=0,discarded=0
    for(let i=0;i<count;i++){const pass=deaths[i]<=params.slope*births[i]||deaths[i]<=params.slope*births[i]+1e-9*Math.max(1,Math.abs(births[i]));if(pass){keptBirths[kept]=births[i];keptDeaths[kept]=deaths[i];keptPointsX[kept]=pointsX[i];keptPointsY[kept]=pointsY[i];kept++}else{discardedBirths[discarded]=births[i];discardedDeaths[discarded]=deaths[i];discarded++}}
    return {keptBirths:keptBirths.subarray(0,kept),keptDeaths:keptDeaths.subarray(0,kept),keptPointsX:keptPointsX.subarray(0,kept),keptPointsY:keptPointsY.subarray(0,kept),discardedBirths:discardedBirths.subarray(0,discarded),discardedDeaths:discardedDeaths.subarray(0,discarded),keptCount:kept}
}

export const computePool=new WorkerPool()
