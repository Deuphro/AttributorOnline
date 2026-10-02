/* -------------------------------------------------------------------------
   bug1.mjs — le bouton « Resolve », sur un nœud qui AFFICHE des résultats.

   Un premier essai a montré qu'un nœud neuf ne calcule rien — mais ce nœud
   n'avait jamais été résolu parce que le harnais n'a pas câblé de vrai. Ce
   fichier teste donc le geste décrit: des résultats sont à l'écran, on change
   un réglage, on clique, et on regarde.
   ------------------------------------------------------------------------- */
import {open,readState,log,shutdown,FIND_NODE} from "./harness.mjs"
import {PEAKS} from "./fixture.mjs"

const {browser,page,server,seen}=await open()

await page.evaluate(`(async()=>{
    const {Wave}=await import("./scripts/formats.js")
    dispatchEvent(new CustomEvent("createNode",{
        detail:{msg:{title:"Attribution",type:"attribution"}}
    }))
    await new Promise(r=>setTimeout(r,80))
    const flow=globalThis.Attributor.channel.get("mainFlow")
    const node=[...flow.nodeSet].find(n=>n.constructor.name==="AttributionNode")
    node.inputs[0]=new Map()
    node.inputs[0].set("fixture",[[Wave.fromPairs(${JSON.stringify(PEAKS)}.map((mz,i)=>[mz,1000-i]),{title:"fixture"})]])
    await node.startResolve()
    globalThis.node=node
})()`)

const state=()=>readState(page)

log("A. le nœud affiche des résultats")
let st=await state()
log(`   ${st.attributions?.[0]?.n} lectures, bouton "${st.button}"`)
log(`   readout: ${JSON.stringify(st.readout)}`)

/* Les gestes que l'écran propose, un par un. Pour chacun: l'affichage AVANT le
   clic, puis APRÈS. Un bouton qui ne fait rien laisse les deux identiques. */
const CASES=[
    ["le isotope du groupe CH2 passe de 1 à 0.01",
        `const row=node.combiningTable.rows.children[0];const cell=row.children[3]
         cell.focus();cell.value="0.01"
         cell.dispatchEvent(new KeyboardEvent("keydown",{key:"Enter",bubbles:true,cancelable:true}))`],
    ["le max du groupe O passe à 1",
        `const row=[...node.combiningTable.rows.children].find(r=>r.children[0].textContent==="O")
         const cell=row.children[2]
         cell.focus();cell.value="1"
         cell.dispatchEvent(new KeyboardEvent("keydown",{key:"Enter",bubbles:true,cancelable:true}))`],
    ["la fenêtre ppm passe à 40",
        `const box=[...node.accordion.DOMelt.content.querySelectorAll("input[type=number]")]
            .find(i=>i.title.includes("measured offset"))
         box.focus();box.value="40"
         box.dispatchEvent(new KeyboardEvent("keydown",{key:"Enter",bubbles:true,cancelable:true}))`],
    ["le min de l'adduit [H+] passe à 0",
        `const cell=node.ionisingTable.rows.children[0].children[1]
         cell.focus();cell.value="0"
         cell.dispatchEvent(new KeyboardEvent("keydown",{key:"Enter",bubbles:true,cancelable:true}))`]
]

for(const [label,body] of CASES){
    log(`\nB. ${label}`)
    await page.evaluate(`(()=>{const node=${FIND_NODE};${body}})()`)
    await new Promise(r=>setTimeout(r,200))
    const marked=await state()
    log(`   marqué : needsResolve=${marked.needsResolve} bouton="${marked.button}" `+
        `lectures=${marked.attributions?.[0]?.n}`)
    log(`   readout affiché PENDANT ce temps:\n${marked.readout}`)
    await page.evaluate(`globalThis.node.resolveButton.click()`)
    await new Promise(r=>setTimeout(r,1500))
    const after=await state()
    log(`   clic    : needsResolve=${after.needsResolve} bouton="${after.button}" `+
        `lectures=${after.attributions?.[0]?.n}`)
    log(`   readout APRÈS:\n${after.readout}`)
    log(`   >>> LE CLIC A-T-IL CHANGÉ L'AFFICHAGE ? ${marked.readout!==after.readout}`)
    /* on remet le réglage, pour que le cas suivant parte de la même base */
    await page.evaluate(`(()=>{const n=${FIND_NODE}
        n.parameters.combining=[
            {group:"CH2",min:0,max:Infinity,ratio:1},
            {group:"NH",min:0,max:Infinity,ratio:1},
            {group:"O",min:0,max:Infinity,ratio:1},
            {group:"C",min:0,max:Infinity,ratio:1}]
        n.parameters.ionising=[{group:"[H+]",min:1,max:1,ratio:1}]
        n.parameters.ppm=10
        n.needsResolve=false
        n.renderGroupTables();n.syncUI();n.renderResolveButton()
    })()`)
    await new Promise(r=>setTimeout(r,100))
}

/* --- D. LE NŒUD NEUF, et l'ordre des évidences ------------------------ */
log("\nD. un nœud neuf, une liste de pics branchée, et un clic")
/* Une seconde page contre le MÊME serveur: c'est la même application, et
   ouvrir un second serveur sur le même port serait une erreur de port. */
const freshPage=await browser.newPage()
await freshPage.goto(`http://localhost:${server.address().port}/index.html`,
    {waitUntil:"networkidle2",timeout:60000})
await freshPage.waitForFunction("globalThis.Attributor!==undefined",{timeout:30000})
await freshPage.evaluate(()=>globalThis.Attributor.tableReady)
await freshPage.evaluate(`(async()=>{
    const {Wave}=await import("./scripts/formats.js")
    dispatchEvent(new CustomEvent("createNode",{
        detail:{msg:{title:"Attribution",type:"attribution"}}
    }))
    await new Promise(r=>setTimeout(r,80))
    const flow=globalThis.Attributor.channel.get("mainFlow")
    const node=[...flow.nodeSet].find(n=>n.constructor.name==="AttributionNode")
    node.inputs[0]=new Map()
    node.inputs[0].set("fixture",[[Wave.fromPairs(${JSON.stringify(PEAKS)}.map((mz,i)=>[mz,1000-i]),{title:"fixture"})]])
    globalThis.node=node
})()`)
const freshRead=()=>freshPage.evaluate(`({
    button:globalThis.node.resolveButton.textContent,
    disabled:globalThis.node.resolveButton.disabled,
    plan:!!globalThis.node.plan,
    needsResolve:globalThis.node.needsResolve,
    attributions:globalThis.node.attributions.length,
    readout:globalThis.node.readout.textContent
})`)
/* LE TEST DOIT ÉCHOUER SUR LE CODE BUGGÉ. `bugged` rétablit la faute du
   défaut 1 — le test `!this.needsResolve` seul, qui faisait sortir un nœud
   jamais calculé sans rien faire — et le cas D doit alors échouer. C'est ce
   qui distingue un test d'une démonstration. */
const withBug=(broken)=>freshPage.evaluate(`(async()=>{
    const broken=${JSON.stringify(broken)}
    const node=globalThis.node
    if(broken){
        node.resolveNow=function(){
            if(!this.needsResolve){ this.renderReadout(); return Promise.resolve() }
            return this.startResolve().then(()=>this.resolveChildren())
        }
    }
    /* un nœud neuf: ni plan, ni résultat */
    node.plan=null
    node.attributions=[]
    node.needsResolve=false
    node.resolveButton.click()
    await new Promise(r=>setTimeout(r,1500))
    return {
        attributions:node.attributions.length,
        readout:node.readout.textContent
    }
})()`)

const resetFresh=()=>freshPage.evaluate(`(()=>{
    const node=globalThis.node
    /* on remet le vrai resolveNow: il vit sur le prototype, donc supprimer la
       copie suffit a retrouver le original. */
    delete node.resolveNow
    node.plan=null
    node.attributions=[]
    node.needsResolve=false
})()`)

log("\nE. le test echoue-t-il sur le code BUGGE ?")
const broken=await withBug(true)
log(`   code bugge : ${broken.attributions} attribution(s), `+
    `readout ${JSON.stringify(broken.readout)}`)
log(`   >>> CA ECHOUE ? ${broken.attributions===0}`)
await resetFresh()
const fixed=await withBug(false)
log(`   code corrige : ${fixed.attributions} attribution(s)`)
log(`   >>> CA PASSE ? ${fixed.attributions>0}`)

await freshPage.close()

/* --- F. LA SONDE, ET C'EST L'USAGE QUI A MOTIVÉ LA DEMANDE ----------- */
log("\nF. la sonde de masse sur un neutre, sans ajouter le proton de tête")
const probePage=await browser.newPage()
await probePage.goto(`http://localhost:${server.address().port}/index.html`,
    {waitUntil:"networkidle2",timeout:60000})
await probePage.waitForFunction("globalThis.Attributor!==undefined",{timeout:30000})
await probePage.evaluate(()=>globalThis.Attributor.tableReady)
await probePage.evaluate(`(async()=>{
    dispatchEvent(new CustomEvent("createNode",{
        detail:{msg:{title:"Attribution",type:"attribution"}}
    }))
    await new Promise(r=>setTimeout(r,120))
    const flow=globalThis.Attributor.channel.get("mainFlow")
    const node=[...flow.nodeSet].find(n=>n.constructor.name==="AttributionNode")
    /* la liste IONISANTE EST VIDE: l'utilisateur veut des masses neutres */
    node.parameters.ionising=[]
    node.parameters.combining=[
        {group:"C",min:0,max:Infinity,ratio:1},
        {group:"H",min:0,max:Infinity,ratio:1},
        {group:"O",min:0,max:Infinity,ratio:1}
    ]
    await node.startResolve()
    globalThis.node=node
})()`)
for(const mass of ["46.04186","47.04914"]){
    await probePage.evaluate(`(()=>{globalThis.node.probeMass(${JSON.stringify(mass)})})()`)
    const shown=await probePage.evaluate(`({
        output:globalThis.node.probeOutput.textContent,
        charges:globalThis.node.chargeLabel.textContent
    })`)
    log(`   sonde ${mass} ->\n${shown.output}`)
    log(`      ${shown.charges}`)
}
await probePage.close()

await shutdown({browser,server})