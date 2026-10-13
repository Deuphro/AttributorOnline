import {open,log,shutdown} from "./harness.mjs"

/* -------------------------------------------------------------------------
   clusterModeRedraw.mjs — LE MODE ET LE CLUSTERING, SUR UNE VRAIE PAGE.

   Trois gestes que l'utilisateur fait et qui doivent être exacts:
     A. en van Krevelen, changer la formule X ou Y doit redessiner la
        partition (points colorés + moyennes) SANS faire un aller-retour par
        un autre mode;
     B. van Krevelen -> barycentric: le nuage van Krevelen ne doit PAS
        perdurer, ni exiger un dé/re-cochage de « clustering »;
     C. error/intensity -> barycentric: barycentric doit se dessiner.

   On lit le DOM (les traces réellement posées), pas ce que déclare le
   paramètre — un test qui lit le paramètre ne verrait pas un graphe vide.
   ------------------------------------------------------------------------- */

const {browser,page,server,seen}=await open()

await page.evaluate(`(async()=>{
    dispatchEvent(new CustomEvent("createNode",{
        detail:{msg:{title:"Formula collections",type:"formulaCollection"}}
    }))
    await new Promise(r=>setTimeout(r,200))
    const flow=globalThis.Attributor.channel.get("mainFlow")
    const node=[...flow.nodeSet].find(n=>n.constructor.name==="FormulaCollectionNode")
    if(!node) throw new Error("the reader was not created")

    const {FormulaCollection}=await import("./scripts/chemistry.js")
    const table=await globalThis.Attributor.tableReady
    const collection=new FormulaCollection({name:"Fixture",table,ppm:20})
    collection.local=true
    /* C, H, O, N, S: assez d'éléments pour le barycentric (k>=3). */
    for(const text of ["C","CH4","CH6O","C6H12O6","C5H5N","C4H4S"]) collection.add(text)
    collection.setPoints(collection.entries.flatMap((entry,i)=>[1,-1].map(k=>({
        mz:entry.mz*(1+(i%4-1)*7*k*1e-6),
        intensity:1000-i*120,
        errorPpm:(i%4-1)*7*k
    }))))
    node.collections=[collection]
    node.parameters.collectionState={
        Fixture:{inOutput:true,inGraphs:true,notes:{},open:true}
    }
    node.parameters.current="Fixture"
    node.syncCurrentCollection()
    await node.refreshGraph()
    node.parameters.clustering.enabled=true
    node.parameters.clustering.nClusters=2
    node.parameters.clustering.dataSource="graph"
    globalThis.node=node
    /* PREMIER RUN, comme le fait la case « clustering » du panneau. */
    await node.computeClustering()
    globalThis.__log=[]
    globalThis.step=(label)=>new Promise(r=>setTimeout(()=>{
        globalThis.__log.push(label+" :: "+
            node.graph.traces.map(t=>t.id+"["+t.wave.dims[0]+"]").join(" ")||"(no traces)")
        r()
    },700))
    globalThis.__log=[]
})()`)

const state=()=>page.evaluate(`(()=>{
    const node=globalThis.node
    const clust=node.parameters.clustering
    return {
        mode:node.parameters.graphMode,
        traces:node.graph.traces.map(t=>({id:t.id,n:t.wave.dims[0]})),
        resultMode:clust.results?.graphMode??null,
        resultSource:clust.results?.dataSource??null,
        nClusters:clust.results?.nClusters??null,
        assignments:clust.results?.assignments??null,
        readout:node.clustReadout?.textContent??"",
        busy:!!node.clusteringBusy
    }
})()`)

/* ATTENDRE QUE LE RUN ATTERRISSE. Le pool tourne dans un worker: lire juste
   après un clic donne « Computing... » et des résultats à moitié posés, ce qui
   n'est pas un défaut du code mais une lecture trop tôt. */
const settle=async()=>{
    for(let i=0;i<60;i++){
        const s=await state()
        if(!s.busy&&!/Computing/.test(s.readout)) return s
        await new Promise(r=>setTimeout(r,250))
    }
    return state()
}

const show=(label)=>{
    return label
}

log("=== B. ERROR -> VAN KREVELEN -> BARYCENTRIC ===")
for(const mode of ["error","vankrevelen","barycentric"]){
    await page.evaluate(`(async()=>{
        await globalThis.node.setGraphMode("${mode}")
    })()`)
    const s=await settle()
    log(`\nmode=${s.mode}  result.graphMode=${s.resultMode}  nClusters=${s.nClusters}`)
    log(`  readout : ${s.readout}`)
    for(const t of s.traces) log(`  trace   ${t.id}  ${t.n} pts`)
}

log("\n=== C. BARYCENTRIC DIRECTEMENT DEPUIS INTENSITY ===")
await page.evaluate(`(async()=>{ await globalThis.node.setGraphMode("intensity") })()`)
await page.evaluate(`(async()=>{ await globalThis.node.setGraphMode("barycentric") })()`)
const direct=await settle()
log(`mode=${direct.mode}  traces=${direct.traces.length}`)
for(const t of direct.traces) log(`  trace   ${t.id}  ${t.n} pts`)

log("\n=== A. VAN KREVELEN, CHANGEMENT DE LA FORMULE X ===")
await page.evaluate(`(async()=>{ await globalThis.node.setGraphMode("vankrevelen") })()`)
const before=await settle()
await page.evaluate(`(()=>{
    const node=globalThis.node
    node.vkXFormula.value="N/C"
    node.vkXFormula.dispatchEvent(new Event("change",{bubbles:true}))
})()`)
const after=await settle()
log(`avant : result.graphMode=${before.resultMode} assignments=${JSON.stringify(before.assignments)}`)
log(`après : result.graphMode=${after.resultMode} assignments=${JSON.stringify(after.assignments)}`)
log(`après : mode=${after.mode} traces=${after.traces.map(t=>t.id).join(", ")}`)

const errors=seen.filter(l=>l.startsWith("pageerror")||l.startsWith("error:"))
if(errors.length){
    log(`\nERREURS DE PAGE (${errors.length}) :`)
    for(const e of errors.slice(0,10)) log("  "+e)
}else{
    log("\nAUCUNE ERREUR DE PAGE")
}
await shutdown({browser,server})
