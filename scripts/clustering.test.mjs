/* -------------------------------------------------------------------------
   Test — node scripts/clustering.test.mjs

   THE CLAIMS UNDER TEST
   The clustering pipeline (PCA -> k-means / spectral partitioning) was
   written in three places — Rust kernels, JS fallbacks, node UI — and the
   pieces were not joined: nothing in kernelWorker.js answered to the names
   the node calls, so every run failed with `unknown kernel`. Three things
   therefore have to hold, and this file pins all three:

     1. the worker ANSWERS to "pca", "kmeans" and "spectral";
     2. the JS fallback and the Rust kernel give the SAME answer — a stale
        pkg build must degrade to identical arithmetic, not to a different
        partition, which only means something if it is checked;
     3. spectral partitioning reads the BOTTOM of the Laplacian spectrum.
        Power iteration converges to the largest eigenvalue it is handed, so
        the matrix it is handed has to be the normalized affinity M, where
        the largest eigenvalues carry the smallest of L = I - M. Two
        concentric rings are the shape that tells the two apart: the raw
        features (and the top of the spectrum) cut straight through both
        rings, only the bottom separates inner from outer.

   The Rust runs for real through the built wasm (pkg/), the JS functions are
   harvested out of kernelWorker.js rather than retyped — a copy would defeat
   the point, since the drift caught here is a copy going stale.
   ------------------------------------------------------------------------- */
import {readFileSync} from "fs"
import {fileURLToPath} from "url"
import {dirname, join} from "path"
import init,* as rust from "../XOP/rust-extension/pkg/attribrustor.js"

const here=dirname(fileURLToPath(import.meta.url))
/* --target web fetches the .wasm over a URL node cannot read from file://;
   handing init the bytes is the same module doing the same work. */
await init(readFileSync(join(here,"../XOP/rust-extension/pkg/attribrustor_bg.wasm")))

let passed=0
const failures=[]
const test=(name,fn)=>{
    try{ fn(); passed++; console.log(`  ok   ${name}`) }
    catch(e){ failures.push(name); console.log(`  FAIL ${name}\n       ${e.message}`) }
}
const ok=(value,msg)=>{ if(!value) throw new Error(msg??"expected a truthy value") }

/* The JS fallbacks, lifted OUT of kernelWorker.js. */
const workerSource=readFileSync(join(here,"kernelWorker.js"),"utf8")
function harvest(name){
    const start=workerSource.indexOf(`function ${name}(`)
    if(start<0) throw new Error(`${name} is no longer in kernelWorker.js`)
    let depth=0,began=false
    for(let i=workerSource.indexOf("{",start);i<workerSource.length;i++){
        if(workerSource[i]==="{"){depth++;began=true}
        else if(workerSource[i]==="}"){
            depth--
            if(began&&depth===0) return workerSource.slice(start,i+1)
        }
    }
    throw new Error(`${name} is not balanced in kernelWorker.js`)
}
const fallbacks=["pcaJS","kmeansJS","spectralJS","kmeansOnEmbeddingJS","estimateSigmaJS","quickselectPairs"]
    .map(harvest).join("\n")
const {pcaJS,kmeansJS,spectralJS}=new Function(
    `${fallbacks}; return {pcaJS,kmeansJS,spectralJS}`
)()

/* --- the data: shapes whose correct answer is not in doubt --------------- */
/* Two blobs, six points each, offsets fixed so the run is the same run
   everywhere. Blob identity is the index: i<6 is A, i>=6 is B. */
function blobs(){
    const off=[[0,0],[0.3,0.2],[-0.2,0.4],[0.1,-0.3],[-0.4,-0.1],[0.2,0.3]]
    const flat=[]
    for(const [dx,dy] of off) flat.push(dx,dy)
    for(const [dx,dy] of off) flat.push(10+dx,10+dy)
    return Float64Array.from(flat)   //12 samples, 2 features
}
/* Two CONCENTRIC rings: k-means and the top of the spectrum both cut through
   the rings (a radius is not a cluster), the bottom of the spectrum does not.
   Ring identity again is the index: i<16 inner, i>=16 outer. */
function rings(){
    const inner=16,outer=16,flat=[]
    for(let i=0;i<inner;i++){
        const t=2*Math.PI*i/inner
        flat.push(Math.cos(t),Math.sin(t))
    }
    for(let i=0;i<outer;i++){
        const t=2*Math.PI*(i+0.5)/outer
        flat.push(3*Math.cos(t),3*Math.sin(t))
    }
    return Float64Array.from(flat)   //32 samples, 2 features
}
/* Three correlated features, so the PCA has a direction worth finding. */
function correlated(){
    const flat=[]
    for(let i=0;i<8;i++){
        const t=i-3.5
        flat.push(t+0.1*Math.sin(i),2*t+0.2*Math.cos(i),0.5*t+(i%2?0.3:-0.3))
    }
    return Float64Array.from(flat)   //8 samples, 3 features
}

const unpackKmeans=(flat,n,f,k)=>({
    assignments:flat.slice(0,n),
    counts:flat.slice(n+3*k*f)
})
const unpackSpectral=(flat,n,f,k)=>({
    assignments:flat.slice(0,n),
    counts:flat.slice(n+n*k+k*f)
})
/* The same partition, whatever the labels are called. */
function samePartition(a,b){
    if(a.length!==b.length) return false
    const map=new Map()
    for(let i=0;i<a.length;i++){
        if(!map.has(a[i])) map.set(a[i],b[i])
        else if(map.get(a[i])!==b[i]) return false
    }
    return new Set(map.values()).size===map.size
}
const splitsByRing=(assignments)=>{
    const inner=new Set(assignments.slice(0,16))
    const outer=new Set(assignments.slice(16))
    return inner.size===1&&outer.size===1&&inner.has(outer.values().next().value)===false
}

/* --- 1. the pipeline is joined ------------------------------------------ */
console.log("the clustering pipeline is joined end to end")
test("kernelWorker.js answers to the pca, kmeans and spectral kernel names",()=>{
    for(const signature of ["async pca(","async kmeans(","async spectral("]){
        ok(workerSource.includes(signature),
            `kernelWorker.js has no ${signature.slice(6,-1)} handler — computePool.run would answer 'unknown kernel' and every run would fail`)
    }
})
test("the node keys colours to the POINTS, not to their position",()=>{
    const nodeSource=readFileSync(join(here,"nodes/FormulaCollectionNode.js"),"utf8")
    ok(nodeSource.includes("pointKeys"),
        "the node no longer stores a key per assignment — the graph is back to indexing colours by position")
    ok(nodeSource.includes("results.collectionName===collection.name"),
        "the graph no longer scopes results to their collection — other collections would wear its clusters")
    ok(nodeSource.includes("entryAssignments=results.entryAssignments"),
        "selectClusterInList is back to indexing entries with a point count")
    ok(/async partitionCollectionByClusters/.test(nodeSource),
        "partition is no longer awaited — the sub-collections would race for whatever is current")
    ok(!nodeSource.includes("this.addFormulaToLocal(entry.notation)"),
        "partition adds one formula at a time again — one full resolve per formula")
})

/* --- 2. the kernels answer, and both ways answer the same --------------- */
console.log("PCA decorrelates the same way in Rust and in JS")
test("pca_project returns the documented layout, all finite",()=>{
    const data=correlated(),n=8,f=3,k=2
    const flat=rust.pca_project(data,n,f,k)
    ok(flat.length===n*k+f*k+k+f,`expected ${n*k+f*k+k+f} values, got ${flat.length}`)
    for(const v of flat) ok(Number.isFinite(v),`PCA reported ${v}`)
    //the means block IS the column means of the input
    const means=flat.slice(n*k+f*k+k)
    for(let j=0;j<f;j++){
        let sum=0
        for(let i=0;i<n;i++) sum+=data[i*f+j]
        ok(Math.abs(means[j]-sum/n)<1e-12,`mean ${j}: ${means[j]} against ${sum/n}`)
    }
})
test("the first component explains more than the second",()=>{
    const flat=rust.pca_project(correlated(),8,3,2)
    const variance=flat.slice(8*2+3*2,8*2+3*2+2)
    ok(variance[0]>=variance[1],`eigenvalues out of order: ${variance[0]} < ${variance[1]}`)
})
test("the JS fallback projects the same points as the Rust",()=>{
    const data=correlated(),n=8,f=3,k=2
    const rustFlat=rust.pca_project(data,n,f,k)
    const js=pcaJS(data,n,f,k)
    ok(js.projected.length===n*k,`fallback projected ${js.projected.length} values`)
    for(let i=0;i<n*k;i++){
        const a=rustFlat[i],b=js.projected[i]
        ok(Math.abs(a-b)<=1e-9*Math.max(1,Math.abs(a)),`projected[${i}]: ${a} against ${b}`)
    }
    for(let c=0;c<k;c++){
        const a=rustFlat[n*k+f*k+c],b=js.explainedVariance[c]
        ok(Math.abs(a-b)<=1e-9*Math.max(1,Math.abs(a)),`variance[${c}]: ${a} against ${b}`)
    }
})

console.log("k-means finds the blobs, and both ways find the SAME blobs")
test("the Rust k-means splits the two blobs",()=>{
    const n=12,f=2,k=2
    const {assignments,counts}=unpackKmeans(rust.kmeans_cluster(blobs(),n,f,k,100,42n),n,f,k)
    for(let i=1;i<6;i++) ok(assignments[i]===assignments[0],
        `blob A is split: ${assignments[0]} against ${assignments[i]} at ${i}`)
    for(let i=7;i<n;i++) ok(assignments[i]===assignments[6],
        `blob B is split: ${assignments[6]} against ${assignments[i]} at ${i}`)
    ok(assignments[0]!==assignments[6],"the two blobs share a cluster")
    const total=counts.reduce((s,v)=>s+v,0)
    ok(total===n,`counts add to ${total}, not ${n}`)
})
test("the JS fallback and the Rust k-means agree on the same seed",()=>{
    const n=12,f=2,k=2
    const fromRust=unpackKmeans(rust.kmeans_cluster(blobs(),n,f,k,100,42n),n,f,k).assignments
    const fromJs=kmeansJS(blobs(),n,f,k,100,42).assignments
    for(let i=0;i<n;i++) ok(fromJs[i]===fromRust[i],
        `point ${i}: rust ${fromRust[i]} against js ${fromJs[i]} — the two RNGs have drifted apart`)
})

console.log("spectral partitioning reads the rings, not a radius")
test("the Rust spectral separates two concentric rings",()=>{
    const n=32,f=2,k=2
    const {assignments,counts}=unpackSpectral(rust.spectral_cluster(rings(),n,f,k,0.8,10),n,f,k)
    ok(splitsByRing(assignments),
        `the partition does not follow the rings: ${Array.from(assignments).join("")}`)
    const total=counts.reduce((s,v)=>s+v,0)
    ok(total===n,`counts add to ${total}, not ${n}`)
})
test("the JS fallback does the same, and the same as the Rust",()=>{
    const n=32,f=2,k=2
    const fromRust=unpackSpectral(rust.spectral_cluster(rings(),n,f,k,0.8,10),n,f,k).assignments
    const js=spectralJS(rings(),n,f,k,0.8,10)
    ok(js.assignments.length===n,`fallback returned ${js.assignments.length} assignments`)
    ok(js.embedding.length===n*k,`embedding is ${js.embedding.length}, expected ${n*k}`)
    ok(splitsByRing(js.assignments),
        `the fallback does not follow the rings: ${Array.from(js.assignments).join("")}`)
    ok(samePartition(fromRust,js.assignments),
        "the fallback and the Rust cut the rings differently — they are separate code pretending to be one kernel")
})
test("a spectral result carries the centers and counts the node reads",()=>{
    const n=32,f=2,k=2
    const flat=rust.spectral_cluster(rings(),n,f,k,0.8,10)
    ok(flat.length===n+n*k+k*f+k,`expected ${n+n*k+k*f+k} values, got ${flat.length}`)
    const js=spectralJS(rings(),n,f,k,0.8,10)
    ok(js.centers.length===k*f,`centers is ${js.centers.length}, expected ${k*f}`)
    ok(js.counts.reduce((s,v)=>s+v,0)===n,"the fallback counts do not add up to the points")
})

console.log(`\n${passed} passed, ${failures.length} failed`)
if(failures.length) process.exitCode=1
