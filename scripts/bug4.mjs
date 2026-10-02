/* -------------------------------------------------------------------------
   bug4.mjs — LES DEUX RÉGLAGES QUI NE FONT RIEN.

       `Best matches to keep (per peak)` et `Match window (ppm)` passent par
       `commitNumber`, qui appelle `markStale` — donc le nœud devrait se mettre
       en sale et le bouton s'allumer. On le vérifie à l'écran, parce que
       « il ne fait rien » et « il attend un clic » ne se ressemblent pas.

           node scripts/bug4.mjs
   ------------------------------------------------------------------------- */
import {open,readState,log,shutdown} from "./harness.mjs"
import {PEAKS} from "./fixture.mjs"

const {browser,page,server,seen}=await open()

await page.evaluate(`(async()=>{
    const {Wave}=await import("./scripts/formats.js")
    dispatchEvent(new CustomEvent("createNode",{
        detail:{msg:{title:"Attribution",type:"attribution"}}
    }))
    await new Promise(r=>setTimeout(r,120))
    const flow=globalThis.Attributor.channel.get("mainFlow")
    const node=[...flow.nodeSet].find(n=>n.constructor.name==="AttributionNode")
    node.inputs[0]=new Map()
    node.inputs[0].set("fixture",[[Wave.fromPairs(${JSON.stringify(PEAKS)}.map((mz,i)=>[mz,1000-i]),{title:"fixture"})]])
    await node.startResolve()
    globalThis.node=node
})()`)

const state=()=>page.evaluate(`(()=>{
    const node=globalThis.node
    const result=node.attributions?.[0]
    return {
        readings:result?.entries?.length??-1,
        kept:result?.keptMatches??null,
        candidates:result?.candidates??null,
        paramBest:node.parameters.bestMatches,
        paramPpm:node.parameters.ppm,
        needsResolve:node.needsResolve,
        button:node.resolveButton.textContent,
        readout:node.readout.textContent
    }
})()`)

/* On agit par le DOM, comme un utilisateur: focus, taper, Enter. */
const typeInto=(title,value)=>page.evaluate(`(()=>{
    const node=globalThis.node
    const box=[...node.accordion.DOMelt.content.querySelectorAll("input[type=number]")]
        .find(i=>i.title.includes(${JSON.stringify(title)}))
    box.focus()
    box.value=${JSON.stringify(value)}
    box.dispatchEvent(new KeyboardEvent("keydown",{key:"Enter",bubbles:true,cancelable:true}))
})()`)

for(const [label,title,from,to] of [
    ["BEST MATCHES","How many readings",3,1],
    ["MATCH WINDOW","measured offset",10,40]
]){
    log(`\n${"=".repeat(60)}\n${label}: ${from} -> ${to}`)
    const before=await state()
    log(`   AVANT : lectures=${before.readings} kept=${before.kept} `+
        `param=${before.paramBest}/${before.paramPpm} needsResolve=${before.needsResolve}`)
    await typeInto(title,String(to))
    await new Promise(r=>setTimeout(r,250))
    const marked=await state()
    log(`   APRES ENTREE (sans clic) : lectures=${marked.readings} kept=${marked.kept} `+
        `param=${marked.paramBest}/${marked.paramPpm} needsResolve=${marked.needsResolve} `+
        `bouton="${marked.button}"`)
    log(`   >>> LE LECTEUR A-T-IL CHANGE SANS CLIC ? ${before.readings!==marked.readings}`)
    await page.evaluate(`globalThis.node.resolveButton.click()`)
    await new Promise(r=>setTimeout(r,1500))
    const after=await state()
    log(`   APRES CLIC RESOLVE : lectures=${after.readings} kept=${after.kept} `+
        `candidates=${after.candidates} bouton="${after.button}"`)
    log(`   >>> LE CLIC CHANGE-T-IL ? ${marked.readings!==after.readings}`)
    log(`   readout :\n${after.readout}`)
}

log("\n--- console du navigateur ---")
for(const line of seen.slice(0,20)) log(line)

await shutdown({browser,server})