/* -------------------------------------------------------------------------
   chain.mjs — LA CHAÎNE ENTIÈRE: attribution -> lecteur.

   C'est ici que se joue le défaut décrit: `Best matches` change, et la liste
   de formules du LECTEUR ne change pas. Toute ma vérification précédente
   lisait `node.attributions` — l'état INTERNE du nœud — alors que l'utilisateur
   regarde le FormulaCollectionNode en aval. Les deux peuvent être d'accord
   sur l'interne et désaccorder sur ce qui est affiché.

       node scripts/chain.mjs
   ------------------------------------------------------------------------- */
import {open,log,shutdown} from "./harness.mjs"
import {PEAKS} from "./fixture.mjs"

const {browser,page,server,seen}=await open()

/* On construit le VRAI pipeline: une source, l'attribution, le lecteur, et
   les câbles entre eux — pas deux nœuds câblés à la main. */
await page.evaluate(`(async()=>{
    const {Wave}=await import("./scripts/formats.js")
    const app=globalThis.Attributor
    const flow=app.channel.get("mainFlow")

    dispatchEvent(new CustomEvent("createNode",{
        detail:{msg:{title:"Attribution",type:"attribution"}}
    }))
    await new Promise(r=>setTimeout(r,100))
    dispatchEvent(new CustomEvent("createNode",{
        detail:{msg:{title:"Formula collections",type:"formulaCollection"}}
    }))
    await new Promise(r=>setTimeout(r,100))

    const nodes=[...flow.nodeSet]
    const attribution=nodes.find(n=>n.constructor.name==="AttributionNode")
    const reader=nodes.find(n=>n.constructor.name==="FormulaCollectionNode")
    if(!attribution||!reader){
        throw new Error("both nodes must exist: "+
            nodes.map(n=>n.constructor.name).join(", "))
    }

    /* LA SOURCE, et un vrai câble via le graphe si possible; sinon on écrit
       l'entrée à la main, ce qui reproduit ce que parentSynapse fait. */
    attribution.inputs[0]=new Map()
    attribution.inputs[0].set("source",[[Wave.fromPairs(
        ${JSON.stringify(PEAKS)}.map((mz,i)=>[mz,1000-i]),{title:"fixture"})]])

    await attribution.startResolve()
    /* le câble sortie -> lecteur, avec la FORME que parentSynapse installe */
    reader.inputs[0]=new Map()
    reader.inputs[0].set(attribution,[[attribution.outputs[0]]])
    await reader.startResolve()

    globalThis.attribution=attribution
    globalThis.reader=reader
})()`)

const read=()=>page.evaluate(`(()=>{
    const a=globalThis.attribution
    const r=globalThis.reader
    const collections=r.collections??[]
    return {
        /* ce que le noeud d'attribution CALCULE */
        internal:a.attributions?.[0]?.entries?.length??-1,
        published:(a.outputs[0]??[]).map(c=>c.entries?.length??-1),
        /* ce que le LECTEUR montre */
        shown:collections.map(c=>c.entries?.length??-1),
        collectionCount:collections.length,
        collectionNames:collections.map(c=>c.name),
        readout:r.readout?.textContent?.slice(0,200)??"(pas de readout)",
        readerStatus:r.status,
        diagnostics:(r.diagnostics??[]).slice(0,4)
    }
})()`)

const typeInto=(title,value)=>page.evaluate(`(()=>{
    const node=globalThis.attribution
    const box=[...node.accordion.DOMelt.content.querySelectorAll("input[type=number]")]
        .find(i=>i.title.includes(${JSON.stringify(title)}))
    box.focus()
    box.value=${JSON.stringify(value)}
    box.dispatchEvent(new KeyboardEvent("keydown",{key:"Enter",bubbles:true,cancelable:true}))
})()`)

log("ÉTAT INITIAL")
const initial=await read()
log(`   interne (attribution) : ${initial.internal}`)
log(`   publié  (outputs[0])  : ${JSON.stringify(initial.published)}`)
log(`   AFFICHÉ (lecteur)     : ${JSON.stringify(initial.shown)} ${JSON.stringify(initial.collectionNames)}`)
log(`   statut lecteur        : ${initial.readerStatus}`)

for(const [label,title,from,to] of [
    ["BEST MATCHES","How many readings",3,1],
    ["MATCH WINDOW","measured offset",10,40]
]){
    log(`\n${"=".repeat(60)}\n${label}: ${from} -> ${to}`)
    await typeInto(title,String(to))
    await new Promise(r=>setTimeout(r,1200))
    const after=await read()
    log(`   interne : ${after.internal}`)
    log(`   publié  : ${JSON.stringify(after.published)}`)
    log(`   AFFICHÉ : ${JSON.stringify(after.shown)}`)
    log(`   >>> LE LECTEUR A-T-IL CHANGÉ ? ${JSON.stringify(initial.shown)!==JSON.stringify(after.shown)}`)
    log(`   >>> L'INTERNE A-T-IL CHANGÉ ? ${initial.internal!==after.internal}`)
    log(`   statut  : ${after.readerStatus}   diagnostics: ${JSON.stringify(after.diagnostics)}`)
    Object.assign(initial,{internal:after.internal,shown:after.shown})
}

/* --- LE VRAI DOUTEUT: UN AUTRE MIN/MAX DE GROUPE ----------------------- */
log("\nG. le même geste sur un min de GROUPE (l'autre type de case)")
const beforeGroup=await read()
await page.evaluate(`(()=>{
    const node=globalThis.attribution
    const row=node.combiningTable.rows.children[0]
    const cell=row.children[1]
    cell.focus()
    cell.value="2"
    cell.dispatchEvent(new KeyboardEvent("keydown",{key:"Enter",bubbles:true,cancelable:true}))
})()`)
await new Promise(r=>setTimeout(r,600))
const markedGroup=await read()
log(`   après Enter : bouton="${await page.evaluate('globalThis.attribution.resolveButton.textContent')}"`)
log(`   AFFICHÉ     : ${JSON.stringify(markedGroup.shown)}`)
log(`   >>> A-T-IL CHANGÉ SANS CLIC ? ${JSON.stringify(beforeGroup.shown)!==JSON.stringify(markedGroup.shown)}`)
await page.evaluate(`globalThis.attribution.resolveButton.click()`)
await new Promise(r=>setTimeout(r,1500))
const afterGroup=await read()
log(`   après clic   : AFFICHÉ ${JSON.stringify(afterGroup.shown)}`)
log(`   >>> LE CLIC CHANGE-T-IL ? ${JSON.stringify(markedGroup.shown)!==JSON.stringify(afterGroup.shown)}`)

/* --- LA FLÈCHE DU SPINNER, ET CE QUE LE BROWSER ENVOIE ---------------- */
log("\nH. la fleche du spinner d'un input[type=number]")
const NEEDLE="How many readings"
await page.evaluate(`(()=>{
    const node=globalThis.attribution
    const box=[...node.accordion.DOMelt.content.querySelectorAll("input[type=number]")]
        .find(i=>i.title.includes(${JSON.stringify(NEEDLE)}))
    globalThis.spinnerBox=box
})()`)
/* UN VRAI CLIC, sur la flèche, avec un vrai pointeur. `stepUp()` par le script
   ne déclenche PAS `change` — le navigateur ne le fait que pour une
   interaction utilisateur — donc la première version de ce test conclut à tort
   qu'aucun événement ne partait. C'est exactement le piège qu'on reproche aux
   tests : ils simulaient un geste que le doigt ne fait pas. */
const box=await page.$("input[type=number]")
const rect=await page.evaluate(`(()=>{
    const r=globalThis.spinnerBox.getBoundingClientRect()
    return {x:r.x,y:r.y,w:r.width,h:r.height}
})()`)
log(`   case : ${JSON.stringify(rect)}`)
/* le spinner occupe les ~12 derniers pixels de hauteur, moitie haute */
const spinnerX=rect.x+rect.w-7
const spinnerY=rect.y+rect.h*0.28
await page.mouse.click(spinnerX,spinnerY)
await new Promise(r=>setTimeout(r,600))
const spinnerRead=await page.evaluate(`({
    value:globalThis.spinnerBox.value,
    shown:(globalThis.reader.collections??[]).map(c=>c.entries?.length??-1)
})`)
log(`   valeur apres un VRAI clic sur la fleche : ${spinnerRead.value}`)
log(`   AFFICHE : ${JSON.stringify(spinnerRead.shown)}`)
log(`   >>> LA FLECHE A-T-ELLE APPLIQUE ? ${
    JSON.stringify(spinnerRead.shown)!==JSON.stringify(afterGroup.shown)}`)

log("\n--- console ---")
for(const line of seen.slice(0,25)) log(line)

await shutdown({browser,server})