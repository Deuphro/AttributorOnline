/* -------------------------------------------------------------------------
   repro.mjs — les trois défauts, DANS LE NAVIGATEUR.

       node scripts/repro.mjs

   Un seul geste par défaut, pour que la sortie soit lisible: le pas 1
   (Resolve) peut être isolé avec `node scripts/repro.mjs 1`.
   ------------------------------------------------------------------------- */
import {open,readState,dump,log,shutdown,FIND_NODE} from "./harness.mjs"
import {PEAKS} from "./fixture.mjs"

const only=process.argv[2]?Number(process.argv[2]):null
const want=n=>!only||only===n

const {browser,page,server,seen}=await open()

/* Le nœud, créé par le MENU — donc par le même événement que le clic de
   l'utilisateur, et non par un `new` qui passerait à côté de l'enregistrement
   sur le canal. */
await page.evaluate(`(async()=>{
    const {Wave}=await import("./scripts/formats.js")
    dispatchEvent(new CustomEvent("createNode",{
        detail:{msg:{title:"Attribution",type:"attribution"}}
    }))
    await new Promise(r=>setTimeout(r,80))
    const flow=globalThis.Attributor.channel.get("mainFlow")
    const node=[...flow.nodeSet].find(n=>n.constructor.name==="AttributionNode")
    if(!node) throw new Error("the Attribution node was not created by the menu event")
    const wave=Wave.fromPairs(${JSON.stringify(PEAKS)}.map((mz,i)=>[mz,1000-i]),{title:"fixture"})
    /* the shape a synapse leaves: Map<parent, Array<Array<Wave>>>. The
       constructor leaves a bare [[]], so the Map is what parentSynapse installs
       when the flow resolves — we install it by hand because we are not linking
       two real nodes here. */
    node.inputs[0]=new Map()
    node.inputs[0].set("fixture",[[wave]])
    return true
})()`)
await page.evaluate(`(async()=>{await ${FIND_NODE}.startResolve()})()`)
await new Promise(r=>setTimeout(r,200))

if(want(1)){
    log("\n########## BUG 1 — le bouton Resolve ##########")
    await dump("état de départ",await readState(page))
    /* LE GESTE: changer une case et valider, puis cliquer le bouton. */
    await page.evaluate(`(()=>{
        const node=${FIND_NODE}
        const box=[...node.accordion.DOMelt.content.querySelectorAll("input")]
            .find(i=>i.type==="number"&&i.title.includes("measured offset"))
        box.value="40"
        box.dispatchEvent(new KeyboardEvent("keydown",{key:"Enter",bubbles:true}))
    })()`)
    const marked=await readState(page)
    await dump("après ppm=40 + Enter (réglage marqué)",marked)
    await page.evaluate(`(()=>{${FIND_NODE}.resolveButton.click()})()`)
    await new Promise(r=>setTimeout(r,600))
    const clicked=await readState(page)
    await dump("après le CLIC sur Resolve",clicked)
    log(`\nle readout a-t-il changé ?      ${marked.readout!==clicked.readout}`)
    log(`les attributions ont-elles changé ? ${
        JSON.stringify(marked.attributions)!==JSON.stringify(clicked.attributions)}`)
}

if(want(2)){
    log("\n########## BUG 2 — un adduit à min:0 ##########")
    await page.evaluate(`(async()=>{
        const node=${FIND_NODE}
        node.parameters.ionising=[{group:"[H+]",min:0,max:1,ratio:1}]
        node.markStale("fixture: ionising min=0")
        await node.resolveNow()
    })()`)
    await new Promise(r=>setTimeout(r,400))
    await dump("[H+] avec min:0, max:1",await readState(page))
}

if(want(3)){
    log("\n########## BUG 3 — le 13C forcé ##########")
    await page.evaluate(`(async()=>{
        const node=${FIND_NODE}
        node.parameters.ionising=[{group:"[H+]",min:1,max:1,ratio:1}]
        node.parameters.combining=[
            {group:"CH2",min:0,max:Infinity,ratio:1},
            {group:"NH",min:0,max:Infinity,ratio:1},
            {group:"O",min:0,max:Infinity,ratio:1},
            {group:"C",min:0,max:Infinity,ratio:1},
            {group:"13C",min:1,max:1,ratio:1}
        ]
        node.markStale("fixture: forced 13C")
        await node.resolveNow()
    })()`)
    await new Promise(r=>setTimeout(r,600))
    const state=await readState(page)
    await dump("avec un groupe 13C min:1 max:1",state)
    const notations=(state.attributions??[]).flatMap(a=>a.notations)
    log(`\nnotations contenant 13C : ${
        JSON.stringify(notations.filter(n=>/13/.test(n)))}`)
}

log("\n--- console du navigateur ---")
for(const line of seen.slice(0,30)) log(line)

await shutdown({browser,server})