/* -------------------------------------------------------------------------
   menuLayout.mjs — LE SOUS-MENU DU FLUX DOIT FLOTTER, SANS BOUGER LA FENÊTRE.

   Le bug qu'il traque: `body.menu-open` passe #mainInterface, #top,
   #topContent et .flow.workspace en overflow:visible pour que la liste
   déroulée ne soit plus coupée. overflow:visible supprime le « minimum à
   zéro » d'un conteneur de défilement, donc la rangée `1fr` de .app se met
   à grow sur le min-content de #mainInterface — c'est-à-dire sur la hauteur
   du panneau gauche — et le panneau bot sort de la fenêtre.

   Les deux choses sont mesurées, parce qu'il en faut deux pour savoir que
   le correctif n'a pas cassé ce qu'il répare:
     1. la géométrie (mainInterface / mid / bot ne bougent pas);
     2. la LISTE EST ENCORE ATTEIGNABLE — un élément coupé par un
        overflow:hidden ne reçoit plus les événements de pointage, alors
        elementFromPoint ment sur ce qui est réellement cliquable.

   node scripts/menuLayout.mjs [largeur] [hauteur]
   ------------------------------------------------------------------------- */
import {open,log,shutdown} from "./harness.mjs"

const {browser,page,server,seen}=await open()
await page.setViewport({width:Number(process.argv[2]??1600),height:Number(process.argv[3]??700)})
await new Promise(r=>setTimeout(r,200))

/* un panneau gauche garni: sans contenu, le plancher de la rangée est petit
   et le bug ne se voit pas. C'est ce que tu avais en ouvrant "Random and
   test" après avoir_TEST_ un nœud à accordéon. */
await page.evaluate(`(async()=>{
    dispatchEvent(new CustomEvent("createNode",{detail:{msg:{title:"Attribution",type:"attribution"}}}))
    await new Promise(r=>setTimeout(r,900))
    for(const [title,type] of [["Trimmer","trimmer"],["Peak picking","peakPicking"],
                              ["F-KMD","fkmd"],["Operation +1","operation"]]){
        dispatchEvent(new CustomEvent("createNode",{detail:{msg:{title,type}}}))
        await new Promise(r=>setTimeout(r,250))
    }
    await new Promise(r=>setTimeout(r,400))
})()`)

const probe=()=>page.evaluate(`(()=>{
    const box=id=>{
        const el=document.getElementById(id)
        const r=el.getBoundingClientRect()
        return {top:Math.round(r.top),bottom:Math.round(r.bottom),h:Math.round(r.height)}
    }
    const lc=document.querySelector(".vertical.left.content")
    const open=[...document.querySelectorAll(".flow.workspace .parent.open")]
    /* le pointage, lui, dit ce qui est RÉELLEMENT atteignable */
    const reach=open.map(parent=>{
        const items=[...parent.querySelectorAll(".parent")]
        return items.map(item=>{
            const r=item.getBoundingClientRect()
            const hit=document.elementFromPoint(r.x+r.width/2,r.y+r.height/2)
            return {
                label:item.textContent,
                inside:r.bottom<=innerHeight&&r.top>=0,
                hittable:!!hit&&(hit===item||item.contains(hit))
            }
        })
    })
    return {
        win:innerHeight,
        mainInterface:box("mainInterface"),
        mid:box("mid"),
        bot:box("bot"),
        leftContentScrolls:lc.scrollHeight>lc.clientHeight+1,
        leftContentOverflow:lc.scrollHeight-lc.clientHeight,
        docScrollH:document.documentElement.scrollHeight,
        bodyClass:document.body.className,
        items:reach.flat()
    }
})()`)

const before=await probe()
const click=await page.evaluate(`(()=>{
    const items=[...document.querySelectorAll(".flow.workspace .menu > div > .parent")]
    const target=items.find(i=>i.textContent.startsWith("Random and test"))
    if(!target) return {found:false,items:items.map(i=>i.textContent)}
    target.click()
    return {found:true}
})()`)
await new Promise(r=>setTimeout(r,600))
const after=await probe()

const failures=[]
const ok=(condition,label)=>{
    log(`   ${condition?"OK  ":"ECHEC"}  ${label}`)
    if(!condition) failures.push(label)
}

log("1. LE SOUS-MENU S'EST OUVERT")
ok(click.found,"le bouton \"Random and test\" est dans le menu de flux")
ok(after.bodyClass==="menu-open","body.menu-open est posé")
ok(after.items.length===4,`la liste a ses 4 entrées (${after.items.length})`)

log("\n2. LA FENÊTRE N'A PAS BOUGÉ")
for(const id of ["mainInterface","mid","bot"]){
    ok(JSON.stringify(before[id])===JSON.stringify(after[id]),
        `${id} est resté ${JSON.stringify(after[id])}`)
}
ok(after.docScrollH===after.win,
    `la page ne défile pas (scrollHeight ${after.docScrollH} = fenêtre ${after.win})`)

log("\n3. LE PANNEAU GAUCHE SCROLLE TOUJOURS")
ok(after.leftContentScrolls,`le contenu du panneau gauche défile de ${after.leftContentOverflow}px`)

log("\n4. LA LISTE EST ENCORE ATTEIGNABLE (pas coupée)")
for(const item of after.items){
    ok(item.inside&&item.hittable,`"${item.label}" est visible et cliquable`)
}

/* Le même chemin, mais APRÈS que le JS a écrit la rangée en style en ligne.
   foldTop/resizeHeightBot recopient `grid-template-rows` sur #mainInterface, et
   le style en ligne gagne sur la feuille de style: un `1fr` nu laissé là-bas
   ne réapparaît qu'après un glissement de septum ou une session restaurée,
   ce qui est la pire façon de tomber sur un bug de mise en page. */
log("\n5. LE MÊME CHEMIN, APRÈS UN REDIMENSIONNEMENT DE PANNEAU")
/* un simple bascule du même bouton: il referme d'abord, il rouvre ensuite */
const flowButton=`(()=>{
    const items=[...document.querySelectorAll(".flow.workspace .menu > div > .parent")]
    const target=items.find(i=>i.textContent.startsWith("Random and test"))
    target.click()
    return !!target
})()`
await page.evaluate(flowButton)
await new Promise(r=>setTimeout(r,500))
await page.evaluate(`(()=>{
    globalThis.Attributor.resizeHeightTop(150)
    globalThis.Attributor.resizeHeightBot(140)
})()`)
await new Promise(r=>setTimeout(r,500))
const resized=await probe()
ok(resized.bodyClass==="","le sous-menu est refermé")
await page.evaluate(flowButton)
await new Promise(r=>setTimeout(r,600))
const resizedOpen=await probe()
ok(resizedOpen.bot.bottom===resizedOpen.win,
    `le panneau bot touche toujours le bas de la fenêtre (${resizedOpen.bot.bottom} = ${resizedOpen.win})`)
ok(JSON.stringify(resized.mainInterface)===JSON.stringify(resizedOpen.mainInterface),
    `#mainInterface n'a pas bougé: ${JSON.stringify(resizedOpen.mainInterface)}`)
ok(resizedOpen.leftContentScrolls,
    `le panneau gauche défile toujours (${resizedOpen.leftContentOverflow}px)`)
for(const item of resizedOpen.items){
    ok(item.inside&&item.hittable,`"${item.label}" est toujours atteignable`)
}

log("\n--- console ---")
for(const line of seen.slice(0,6)) log(line)

await shutdown({browser,server})
if(failures.length){
    log(`\n${failures.length} ECHEC(S)`)
    process.exitCode=1
}else{
    log("\nTOUT PASSE")
}