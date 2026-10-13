import {open,log,shutdown} from "./harness.mjs"

/* SEED SESSION: drop a FormulaCollection node directly into the flow, then feed
   it a parent-collected collection WITHOUT setting parameters.current, so we see
   whether the FIRST collection is selected by default (the "dark pattern" the
   user asked to remove). */
const {browser,page,server,seen}=await open()

await page.evaluate(`(async()=>{
    dispatchEvent(new CustomEvent("createNode",{
        detail:{msg:{title:"Formula collections",type:"formulaCollection"}}
    }))
    await new Promise(r=>setTimeout(r,200))
    const flow=globalThis.Attributor.channel.get("mainFlow")
    const node=[...flow.nodeSet].find(n=>n.constructor.name==="FormulaCollectionNode")
    if(!node) throw new Error("no node")

    const {FormulaCollection}=await import("./scripts/chemistry.js")
    const table=await globalThis.Attributor.tableReady
    // TWO collections, so "first" is a real choice, not an only-one accident
    const a=new FormulaCollection({name:"Alpha",table,ppm:20}); a.local=true; a.add("CH4"); a.setPoints([{mz:16.0313,intensity:100,errorPpm:-1}])
    const b=new FormulaCollection({name:"Beta",table,ppm:20}); b.local=true; b.add("C6H12O6"); b.setPoints([{mz:180.0634,intensity:80,errorPpm:2}])

    /* Feed them as a PARENT would: through inputs[0] (a Map), which is what
       readCollections() actually rebuilds this.collections from — setting
       node.collections directly gets wiped by the resolve, so it proves nothing.
       One output = an array of the two collections, exactly like a producer. */
    const parent={events:{registrationName:"Parent"},title:"Parent"}
    node.inputs[0]=new Map([[parent,[[a,b]]]])
    node.parameters.current=null
    await node.startResolve()
    globalThis.node=node
})()`)

const state=await page.evaluate(`(()=>{
    const node=globalThis.node
    const rows=[...document.querySelectorAll(".fc-collection")]
    const cb=node.clustEnableToggle
    return {
        current:node.parameters.current,
        currentName:node.currentCollection?.name??null,
        highlighted:[...rows].filter(r=>r.classList.contains("current")).map(r=>r.textContent.trim().slice(0,20)),
        graphTraces:node.graph.traces.map(t=>t.id),
        clustDisabled:cb?cb.disabled:"no-cb",
        clustLabel:cb&&cb.nextElementSibling?cb.nextElementSibling.textContent:"?"
    }
})()`)
log(`parameters.current      ${JSON.stringify(state.current)}`)
log(`currentCollection       ${JSON.stringify(state.currentName)}`)
log(`highlighted row(s)      ${JSON.stringify(state.highlighted)}`)
log(`graph traces            ${JSON.stringify(state.graphTraces)}`)
log(`clustering checkbox     disabled=${state.clustDisabled}  label="${state.clustLabel}"`)

const errs=seen.filter(l=>l.startsWith("pageerror")||l.startsWith("error:"))
log(`\nPAGE ERRORS: ${errs.length?errs.slice(0,5).join(" | "):"none"}`)

await shutdown({browser,server})
