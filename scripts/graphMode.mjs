import {open,log,shutdown} from "./harness.mjs"

/* -------------------------------------------------------------------------
   graphMode.mjs — LE GRAPHE PAR DÉFAUT, dans une vraie page.

   node scripts/graphMode.mjs

   Les tests unitaires-slice-ont la méthode et l'appellent sur un faux graphe:
   cela prouve la LOGIQUE, pas ce que l'utilisateur voit. Un graphe peut être
   correct en interne et absent à l'écran — un label d'axe qui ne se pose pas, un
   toggle qui ne se peint pas, un panneau absent parce que le nœud n'a jamais été
   enregistré. Ici on lit le DOM d'une page qui a vraiment démarré.
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

    /* Une collection avec des pics DÉCALÉS en ppm. C'est le choix qui compte:
       sur des erreurs nulles, un graphique cassé et un graphiqueexact se
       ressemblent. Ici le nuage doit s'étaler, donc on le voit. */
    const {FormulaCollection}=await import("./scripts/chemistry.js")
    const table=await globalThis.Attributor.tableReady
    const collection=new FormulaCollection({name:"Fixture",table,ppm:20})
    collection.local=true
    for(const text of ["C","CH4","C6H12O6"]) collection.add(text)
    collection.setPoints(collection.entries.flatMap((entry,i)=>[1,-1].map(k=>({
        mz:entry.mz*(1+(i===2?12:-3)*k*1e-6),
        intensity:1000-i*100
    }))))
    node.collections=[collection]
    node.parameters.collectionState={
        Fixture:{inOutput:true,inGraphs:true,notes:{},open:true}
    }
    node.parameters.current="Fixture"
    node.refreshGraph()
    globalThis.node=node
})()`)

/* Ce qu'on lit, c'est ce qui est dans le DOM — les libellés d'axes, les
   boutons, le readout — et non ce que le paramètre déclare. */
const read=()=>page.evaluate(`(()=>{
    const node=globalThis.node
    const graph=node.graph
    return {
        mode:node.parameters.graphMode,
        axisBottom:graph.parameters.axis.bottom.label,
        axisLeft:graph.parameters.axis.left.label,
        axisLeftScale:graph.parameters.axis.left.scale,
        traces:graph.traces.map(t=>({
            id:t.id,
            mode:t.options.mode,
            points:t.wave.dims[0],
            /* les paires, comme elles sont dessinées */
            pairs:t.wave.toPairs().map(([x,y])=>[x,y])
        })),
        buttons:[...node.graphOptions.querySelectorAll("button")].map(b=>b.textContent),
        readout:node.graphReadout.textContent,
        readoutTitle:node.graphReadout.title
    }
})()`)

const show=(label,state)=>{
    log(`\n${label}`)
    log(`  mode        ${state.mode}`)
    log(`  axes        ${state.axisBottom} × ${state.axisLeft}   (échelle gauche : ${state.axisLeftScale})`)
    for(const t of state.traces){
        log(`  trace       ${t.id}  mode="${t.mode}"  ${t.points} points`)
        for(const [x,y] of t.pairs.slice(0,4)) log(`              ${x.toFixed(5)} , ${y.toFixed(3)}`)
    }
    log(`  boutons     ${state.buttons.join(" | ")}`)
    log(`  readout     ${state.readout}`)
}

show("PAR DÉFAUT, sans rien toucher :",await read())

log("\nAPRÈS UN CLIC SUR « Intensity » :")
await page.evaluate(`(()=>{
    const node=globalThis.node
    ;[...node.graphOptions.querySelectorAll("button")]
        .find(b=>b.textContent==="Intensity").click()
})()`)
const switched=await read()
show("",switched)

log("\nPUIS UN CLIC SUR « Error » — le retour doit être EXACT :")
await page.evaluate(`(()=>{
    const node=globalThis.node
    ;[...node.graphOptions.querySelectorAll("button")]
        .find(b=>b.textContent==="Error").click()
})()`)
const back=await read()
log(`  mode        ${back.mode}`)
log(`  axe gauche  ${back.axisLeft}`)
log(`  traces      ${back.traces.map(t=>`${t.id}="${t.mode}"`).join(", ")}`)

/* LE MODE DOIT VOYAGER AVEC LA SESSION: c'est un choix de lecture, et un
   fichier qui rouvrait sur l'autre vue ferait perdre la comparaison d'un
   enregistrement à l'autre. */
const saved=await page.evaluate(`(()=>{
    const state=JSON.parse(JSON.stringify(globalThis.node.serializeState()))
    return state.graphMode
})()`)
log(`\nSESSION      graphMode=${saved}`)

/* ET UN MODE INCONNU NE DOIT PAS VIDER LE GRAPHE. */
const unknown=await page.evaluate(`(()=>{
    const node=globalThis.node
    node.parameters.graphMode="unModeDUneAutreVersion"
    node.refreshGraph()
    return {
        traces:node.graph.traces.length,
        axisLeft:node.graph.parameters.axis.left.label
    }
})()`)
log(`INCONNU      ${unknown.traces} trace(s), axe « ${unknown.axisLeft} » (le défaut a repris la main)`)

const errors=seen.filter(line=>line.startsWith("pageerror")||line.startsWith("error:"))
if(errors.length){
    log(`\nERREURS DE PAGE (${errors.length}) :`)
    for(const e of errors.slice(0,10)) log("  "+e)
}else{
    log("\nAUCUNE ERREUR DE PAGE")
}
await shutdown({browser,server})