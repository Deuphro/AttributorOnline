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
    if(kernel==="persistentHomology0D"){
        const {core,params}=payload
        const mode=params?.mode??"sublevel"
        const n=core.length
        if(n<2) return {pairs:new Float64Array(0)}
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
        const res=[]
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
                    res.push(bv,death,birthIdx[rv],deathIdx)
                    parent[rv]=ru
                }else{
                    res.push(bu,death,birthIdx[ru],deathIdx)
                    parent[ru]=rv
                }
            }
        }
        return {pairs:new Float64Array(res)}
    }
    throw new Error(`unknown kernel "${kernel}"`)
}

export const computePool=new WorkerPool()