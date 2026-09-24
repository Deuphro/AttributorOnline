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
        let pairs=null
        try{
            await ensureWasm()
            if(typeof rust.persistent_homology_0d!=="function"){
                throw new Error("rust persistent_homology_0d is missing (stale pkg build?)")
            }
            const res=rust.persistent_homology_0d(core,mode)
            pairs=res instanceof Float64Array?res:new Float64Array(res)
        }catch(err){
            console.warn("[kernelWorker] rust persistent_homology_0d unavailable, JS fallback:",err)
            pairs=computePersistentHomology0D_JS(core,mode)
        }
        return {pairs}
    }
}

function computePersistentHomology0D_JS(data,mode="sublevel"){
    const n=data.length
    if(n<2) return new Float64Array(0)
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
        const transfer=[]
        if(result?.core?.buffer) transfer.push(result.core.buffer)
        if(result?.pairs?.buffer) transfer.push(result.pairs.buffer)
        self.postMessage({id,ok:true,result},transfer)
    }catch(err){
        self.postMessage({id,ok:false,error:err?.message??String(err)})
    }
})