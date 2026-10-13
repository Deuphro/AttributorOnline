import {open,log,shutdown} from "./harness.mjs"

/* Diagnostic: pourquoi computeClustering reste-t-il bloqué en barycentric ? */

const {browser,page,server,seen}=await open()

await page.evaluate(`(async()=>{
    dispatchEvent(new CustomEvent("createNode",{
        detail:{msg:{title:"Formula collections",type:"formulaCollection"}}
    }))
    await new Promise(r=>setTimeout(r,200))
    const flow=globalThis.Attributor.channel.get("mainFlow")
    const node=[...flow.nodeSet].find(n=>n.constructor.name==="FormulaCollectionNode")
    const {FormulaCollection}=await import("./scripts/chemistry.js")
    const table=await globalThis.Attributor.tableReady
    const collection=new FormulaCollection({name:"Fixture",table,ppm:20})
    collection.local=true
    for(const text of ["C","CH4","CH6O","C6H12O6","C5H5N","C4H4S"]) collection.add(text)
    collection.setPoints(collection.entries.flatMap((entry,i)=>[1,-1].map(k=>({
        mz:entry.mz*(1+(i%4-1)*7*k*1e-6),
        intensity:1000-i*120,
        errorPpm:(i%4-1)*7*k
    }))))
    node.collections=[collection]
    node.parameters.collectionState={Fixture:{inOutput:true,inGraphs:true,notes:{},open:true}}
    node.parameters.current="Fixture"
    node.syncCurrentCollection()
    await node.refreshGraph()
    node.parameters.clustering.enabled=true
    node.parameters.clustering.nClusters=2
    node.parameters.clustering.dataSource="graph"
    globalThis.node=node
    globalThis.calls=[]
    const mod=await import("./scripts/workerPool.js")
    const orig=mod.computePool.run.bind(mod.computePool)
    mod.computePool.run=(name,payload)=>{
        globalThis.calls.push(name)
        return orig(name,payload)
    }
    globalThis.origRun=orig
})()`)

const diag=()=>page.evaluate(`(()=>{
    const n=globalThis.node
    return {
        busy:!!n.clusteringBusy, pending:!!n.clusteringPending,
        calls:globalThis.calls.slice(-12), readout:n.clustReadout?.textContent??""
    }
})()`)

for(const mode of ["error","vankrevelen","barycentric"]){
    await page.evaluate(`(async()=>{ globalThis.calls=[]; await globalThis.node.setGraphMode("${mode}") })()`)
    for(let i=0;i<40;i++){
        await new Promise(r=>setTimeout(r,250))
        const d=await diag()
        if(!d.busy) break
    }
    const d=await diag()
    log(`\n--- ${mode} ---`)
    log(`  busy=${d.busy} pending=${d.pending} readout="${d.readout}"`)
    log(`  pool calls: ${d.calls.join(" -> ")||"(none)"}`)
}

const errors=seen.filter(l=>l.startsWith("pageerror")||/error/i.test(l))
log(`\nCONSOLE (${errors.length}):`)
for(const e of errors.slice(0,14)) log("  "+e)
await shutdown({browser,server})
