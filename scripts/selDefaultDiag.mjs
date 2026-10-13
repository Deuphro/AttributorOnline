import {open,log,shutdown} from "./harness.mjs"

/* selDefaultDiag.mjs — LA SÉLECTION PAR DÉFAUT, SANS Y TOUCHER.
   On crée le nœud, on pousse une collection PARENTE par l'entrée (comme le
   ferait un nœud en amont), on résout SANS jamais poser parameters.current, et
   on lit ce que l'utilisateur voit: quelle collection est courante, si une
   ligne est surlignée `.current`, et si le graphe a des traces. Le point:
   « je n'ai pas à cliquer pour voir ma collection ». */

const {browser,page,server,seen}=await open()

await page.evaluate(`(async()=>{
    dispatchEvent(new CustomEvent("createNode",{
        detail:{msg:{title:"Formula collections",type:"formulaCollection"}}
    }))
    await new Promise(r=>setTimeout(r,200))
    const flow=globalThis.Attributor.channel.get("mainFlow")
    const node=[...flow.nodeSet].find(n=>n.constructor.name==="FormulaCollectionNode")
    if(!node) throw new Error("le lecteur n'a pas été créé")

    const {FormulaCollection}=await import("./scripts/chemistry.js")
    const table=await globalThis.Attributor.tableReady
    /* DEUX collections parentes: la question « la PREMIÈRE est-elle choisie? »
       n'a de sens que s'il y en a plusieurs. */
    const make=(name,n)=>new FormulaCollection({name,table,ppm:20})
    const a=make("Alpha",3); a.local=false
    for(const t of ["C","CH4","C6H12O6"]) a.add(t)
    a.setPoints(a.entries.flatMap((e,i)=>[1,-1].map(k=>({mz:e.mz*(1+i*k*5e-6),intensity:900-i*200}))))
    const b=make("Beta",2); b.local=false
    for(const t of ["CH6O","C5H5N"]) b.add(t)
    b.setPoints(b.entries.flatMap((e,i)=>[1,-1].map(k=>({mz:e.mz*(1+i*k*6e-6),intensity:800-i*150}))))

    /* On ne touche NI current NI collectionState: c'est le nœud qui doit décider. */
    node.inputs[0]=new Map([[{events:{registrationName:"Parent"},title:"Parent"},[[a],[b]]]])
    await node.startResolve()
    globalThis.node=node
})()`)

const read=()=>page.evaluate(`(()=>{
    const node=globalThis.node
    const rows=[...document.querySelectorAll(".fc-collection")]
    const currentRow=rows.find(r=>r.className.includes("current"))
    return {
        current:node.parameters.current,
        currentCollection:node.currentCollection?.name??null,
        traces:node.graph.traces.map(t=>t.id),
        rowCount:rows.length,
        currentRowText:currentRow?currentRow.textContent.trim():null,
        readout:node.graphReadout?.textContent
    }
})()`)

const s=await read()
log("APRÈS UNE RÉSOLUTION NATURELLE (sans poser current):")
log(`  parameters.current   ${s.current}`)
log(`  currentCollection    ${s.currentCollection}`)
log(`  lignes               ${s.rowCount}, ligne .current = ${s.currentRowText?JSON.stringify(s.currentRowText.slice(0,40)):"AUCUNE"}`)
log(`  traces du graphe     ${s.traces.join(", ")||"(vide)"}`)
log(`  readout              ${s.readout}`)

const errors=seen.filter(l=>l.startsWith("pageerror")||l.startsWith("error:"))
if(errors.length){ log(`\nERREURS (${errors.length}):`); for(const e of errors.slice(0,8)) log("  "+e) }
else log("\nAUCUNE ERREUR DE PAGE")

await shutdown({browser,server})
