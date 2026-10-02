/* -------------------------------------------------------------------------
   ui.mjs — L'INTERFACE RENDUE, ET CE QU'ON Y LIT.

   Les trois retouches demandées sont des-affichages, donc elles ne se vérifient
   dans aucun test de moteur: elles se vérifient en lisant le DOM.

       node scripts/ui.mjs [--shots]
   ------------------------------------------------------------------------- */
import {open,log,shutdown} from "./harness.mjs"
import {PEAKS} from "./fixture.mjs"
import path from "path"
import {fileURLToPath} from "url"

const ROOT=path.resolve(path.dirname(fileURLToPath(import.meta.url)),"..")
const {browser,page,server,seen}=await open()

await page.evaluate(`(async()=>{
    const {Wave}=await import("./scripts/formats.js")
    dispatchEvent(new CustomEvent("createNode",{
        detail:{msg:{title:"Attribution",type:"attribution"}}
    }))
    await new Promise(r=>setTimeout(r,150))
    const flow=globalThis.Attributor.channel.get("mainFlow")
    const node=[...flow.nodeSet].find(n=>n.constructor.name==="AttributionNode")
    node.inputs[0]=new Map()
    node.inputs[0].set("fixture",[[Wave.fromPairs(
        ${JSON.stringify(PEAKS)}.map((mz,i)=>[mz,1000-i]),{title:"fixture"})]])
    await node.startResolve()
    globalThis.node=node
})()`)

const read=()=>page.evaluate(`(()=>{
    const node=globalThis.node
    const content=node.accordion.DOMelt.content
    const order=[]
    for(const child of content.children){
        const caption=child.querySelector?.(".an-caption")
        order.push({
            cls:child.className||child.tagName,
            caption:caption?.textContent??"",
            /* la position d'un bloc se lit par son offsetTop: c'est ce que
               l'oeil suit, pas l'ordre du DOM abstrait */
            top:child.offsetTop
        })
    }
    const row=[...content.querySelectorAll(".an-row")][0]
    const rowInputs=row?[...row.querySelectorAll("input")].map(i=>i.title):[]
    const probe=node.massInput
    return {
        order,
        rowCaptions:row?[...row.querySelectorAll(".an-caption")].map(c=>c.textContent):[],
        rowInputs,
        rowCount:content.querySelectorAll(".an-row").length,
        probeLabel:[...content.querySelectorAll(".an-caption")]
            .map(c=>c.textContent).find(t=>t==="Probe")??"(absent)",
        probeStep:probe?.getAttribute("step"),
        probeNoSpin:probe?.classList.contains("no-spin"),
        probeBackground:probe?getComputedStyle(probe).backgroundColor:"",
        /* La règle est mesurée DANS LE HEAD, où elle vit: elle accompagne la session
       entière et ne dépend pas du panneau, que replaceChildren() vide. Le
       compte doit être 1, jamais plus — une balise par appel de setupUI
       s'empilerait à chaque reconstruction de tableau. */
        styleCount:document.head.querySelectorAll("style[data-an-ui]").length,
        spinnerHidden:(()=>{
            const probe=globalThis.node.massInput
            if(!probe) return null
            const applied=getComputedStyle(probe,"::-webkit-inner-spin-button")
            return applied.webkitAppearance==="none"
                || getComputedStyle(probe).appearance==="textfield"
        })(),
        contentHeight:content.offsetHeight
    }
})()`)

const state=await read()

log("1. L'ORDRE DES BLOCS — le champ est-il AU-DESSUS de sa liste ?")
for(const row of state.order){
    if(!row.caption&&row.cls==="an-row"){
        log(`   [grille] ${JSON.stringify(state.rowCaptions)}`)
        continue
    }
    log(`   ${String(row.top).padStart(4)}px  ${(row.cls||"").padEnd(16)} ${row.caption}`)
}

log("\n2. LA RANGÉE DES DEUX RÉGLAGES")
log(`   nombre de grilles : ${state.rowCount}`)
log(`   libellés          : ${JSON.stringify(state.rowCaptions)}`)
log(`   les deux cases y sont : ${state.rowInputs.length===2}`)

log("\n3. LA SONDE")
log(`   libellé       : "${state.probeLabel}"`)
log(`   step          : ${state.probeStep}`)
log(`   sans flèches  : ${state.probeNoSpin}`)
log(`   fond          : ${state.probeBackground}`)
log(`   règle CSS dans le head : ${state.styleCount} (1 = posée une seule fois)`)
log(`   spinner masqué (calculé): ${state.spinnerHidden}`)
log(`   hauteur du panneau : ${state.contentHeight}px`)

/* UN VRAI CLIC SUR LA ZONE OU SERAIT LA FLECHE. C'est la seule mesure qui
   vaut: getComputedStyle sur une pseudo-classe interne n'est pas fiable, et un
   attribut posé par le script ne prouve rien du rendu. Si la flèche existe, ce
   clic CHANGE la valeur; s'il n'y a pas de flèche, il ne se passe rien. */
    const NEEDLE2="Type one m/z"
    await page.evaluate(`(()=>{
        const box=[...globalThis.node.accordion.DOMelt.content
            .querySelectorAll("input")].find(i=>i.title.includes(${JSON.stringify(NEEDLE2)}))
        globalThis.probeBox=box
    })()`)
    const probeRect=await page.evaluate(`(()=>{
        const r=globalThis.probeBox.getBoundingClientRect()
        return {x:r.x,y:r.y,w:r.width,h:r.height}
    })()`)
    const probeBefore=await page.evaluate(`globalThis.probeBox.value`)
    /* le spinner, quand il existe, occupe les derniers pixels de droite */
    await page.mouse.click(probeRect.x+probeRect.w-6,probeRect.y+probeRect.h*0.3)
    await new Promise(r=>setTimeout(r,250))
    const probeAfter=await page.evaluate(`globalThis.probeBox.value`)
    log("\n4. LA FLECHE, PAR UN VRAI CLIC")
    log(`   valeur avant : ${probeBefore}`)
    log(`   valeur apres : ${probeAfter}`)
    log(`   >>> LES FLECHES SONT-ELLES DISPARUES ? ${probeBefore===probeAfter}`)

    /* ET LA SONDE DOIT ENCORE MARCHER: on saisit une masse et on la lit. */
    await page.evaluate(`(()=>{
        const box=globalThis.probeBox
        box.focus()
        box.value="46.04186"
        box.dispatchEvent(new KeyboardEvent("keydown",{key:"Enter",bubbles:true,cancelable:true}))
    })()`)
    await new Promise(r=>setTimeout(r,300))
    const probeText=await page.evaluate(`globalThis.node.probeOutput.textContent`)
    log("\n5. LA SONDE MARCHE TOUJOURS")
    for(const line of probeText.split("\n").slice(0,2)) log(`   ${line}`)

    if(process.argv.includes("--shots")){
    const clip=await page.evaluate(`(()=>{
        const r=globalThis.node.accordion.DOMelt.content.getBoundingClientRect()
        return {x:r.x,y:r.y,width:r.width,height:r.height}
    })()`)
    await page.screenshot({path:path.join(ROOT,"shots","panel.png"),clip})
    log("\ncapture : shots/panel.png")
}

log("\n--- console ---")
for(const line of seen.slice(0,10)) log(line)

await shutdown({browser,server})