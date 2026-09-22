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
    }
}

self.addEventListener("message",async e=>{
    const {id,kernel,payload}=e.data
    try{
        const kernelFn=kernels[kernel]
        if(!kernelFn){
            throw new Error(`unknown kernel "${kernel}"`)
        }
        const result=await kernelFn(payload)
        const transfer=result?.core?.buffer?[result.core.buffer]:[]
        self.postMessage({id,ok:true,result},transfer)
    }catch(err){
        self.postMessage({id,ok:false,error:err?.message??String(err)})
    }
})