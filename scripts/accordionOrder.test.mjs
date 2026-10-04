/* -------------------------------------------------------------------------
   Test — node scripts/accordionOrder.test.mjs

   Le rangement des panneaux d'une colonne, dans un vrai Chromium.

   CE QUI EST TESTÉ, et où: les cinq événements du glisser sont envoyés sur la
   VRAIE poignée, et l'ordre est relu sur le VRAI panneau. Un test qui lirait
   une liste parallèle verrait qu'elle se met à jour — il ne verrait pas que
   l'utilisateur voit le panneau bouger, et c'est le seul qui compte.

   Pourquoi des événements forgés plutôt qu'un glisser de Puppeteer: le geste
   de l'utilisateur est « je vise le haut OU le bas de cette ligne ». Un
   glisser piloté par le navigateur ne dit pas quelle moitié on vise, alors
   que c'est précisément ce que ces deux branches décident. On envoie donc les
   événements, avec un clientY choisi — ce qui est le même chemin de code que
   celui que l'application exécute.

   La persistance se mesure après un VRAI rechargement de la page: le
   squelette est écrit par l'autosave que le déplacement a annoncé, et une
   écriture simulée ne prouverait que ce qu'on a simulé.
   ------------------------------------------------------------------------- */
import {open,shutdown,log} from "./harness.mjs"

let passed=0
const failures=[]
const test=(name,fn)=>{
    try{ fn(); passed++; console.log(`  ok   ${name}`) }
    catch(e){ failures.push(name); console.log(`  FAIL ${name}\n       ${e.message}`) }
}
const eq=(a,b,msg)=>{ if(a!==b) throw new Error(`${msg??`${JSON.stringify(a)} != ${JSON.stringify(b)}`}`) }

/* La colonne, lue DEPUIS L'ÉCRAN: les titres dans l'ordre où les panneaux
   sont vraiment empilés. */
const readColumn=page=>page.evaluate(`(()=>{
    const panel=globalThis.Attributor.main.querySelector(".vertical.left.content")
    return [...panel.querySelectorAll(":scope > .accordion.container")]
        .map(box=>box.querySelector(".accordion.handler.label").textContent)
})()`)

/* Un glisser, sur la vraie poignée, visant la moitié demandée de la ligne
   visée. `half` vaut 0.2 pour le haut, 0.8 pour le bas. */
const dragGrip=(page,fromTitle,ontoTitle,half)=>page.evaluate(`(()=>{
    const rows=[...document.querySelectorAll(".vertical.left.content > .accordion.container")]
    const gripOf=title=>rows.find(r=>r.querySelector(".accordion.handler.label").textContent===title)
        .querySelector(".accordion.handler.menu")
    const from=gripOf(${JSON.stringify(fromTitle)})
    const onto=gripOf(${JSON.stringify(ontoTitle)})
    const box=onto.closest(".accordion.container").getBoundingClientRect()
    const y=box.top+box.height*(${half})
    const at={bubbles:true,cancelable:true,clientY:y,clientX:box.left+5}
    const transfer=new DataTransfer()
    from.dispatchEvent(new DragEvent("dragstart",{bubbles:true,dataTransfer:transfer}))
    onto.dispatchEvent(new DragEvent("dragover",{...at,dataTransfer:transfer}))
    onto.dispatchEvent(new DragEvent("drop",{...at,dataTransfer:transfer}))
    from.dispatchEvent(new DragEvent("dragend",{bubbles:true,dataTransfer:transfer}))
})()`)

/* Les panneaux, créés par la MÊME VOIE que le menu — un CustomEvent
   createNode, dispatché sur globalThis exactement comme le fait le menu.
   Un panneau fabriqué à la main testerait un objet qui n'existe pas dans
   l'application: le contrôle est dans le fait que c'est le même Accordion,
   construit par le même constructeur, branché sur la même colonne. */
const makePanels=page=>page.evaluate(`(async()=>{
    for(const title of ["alpha","beta","gamma"]){
        dispatchEvent(new CustomEvent("createNode",{
            detail:{msg:{title,type:"trimmer"}}
        }))
        await new Promise(r=>setTimeout(r,120))
    }
})()`)
const {browser,page,server,seen}=await open()
try{
    await makePanels(page)
    const before=await readColumn(page)
    test("three panels stand in the left column",()=>{
        eq(before.length,3,`the column holds ${JSON.stringify(before)}`)
    })

    await dragGrip(page,"gamma","alpha",0.2)
    const above=await readColumn(page)
    test("a panel dropped on the TOP half of another goes above it",()=>{
        eq(JSON.stringify(above),JSON.stringify(["gamma","alpha","beta"]))
    })

    await dragGrip(page,"gamma","beta",0.8)
    const below=await readColumn(page)
    test("the BOTTOM half puts it below instead",()=>{
        eq(JSON.stringify(below),JSON.stringify(["alpha","beta","gamma"]))
    })

    await dragGrip(page,"gamma","alpha",0.2)
    const again=await readColumn(page)
    test("the same move can be done again",()=>{
        eq(JSON.stringify(again),JSON.stringify(["gamma","alpha","beta"]))
    })

    const noop=await page.evaluate(`(()=>{
        const rows=[...document.querySelectorAll(".vertical.left.content > .accordion.container")]
        const from=rows[0].querySelector(".accordion.handler.menu")
        const onto=rows[1]
        const box=onto.getBoundingClientRect()
        const transfer=new DataTransfer()
        from.dispatchEvent(new DragEvent("dragstart",{bubbles:true,dataTransfer:transfer}))
        onto.dispatchEvent(new DragEvent("drop",{bubbles:true,cancelable:true,dataTransfer:transfer,
            clientY:box.top+1,clientX:box.left+5}))
        from.dispatchEvent(new DragEvent("dragend",{bubbles:true,dataTransfer:transfer}))
        return [...document.querySelectorAll(".vertical.left.content > .accordion.container")]
            .map(r=>r.querySelector(".accordion.handler.label").textContent).join(",")
    })()`)
    test("dropping a panel where it already is changes nothing",()=>{
        eq(noop,"gamma,alpha,beta")
    })

    /* LE CLAVIER: la poignée est focusable et le panneau suit les flèches. */
    const keys=await page.evaluate(`(()=>{
        const rows=[...document.querySelectorAll(".vertical.left.content > .accordion.container")]
        const grip=rows[0].querySelector(".accordion.handler.menu")
        grip.focus()
        const press=key=>document.activeElement.dispatchEvent(
            new KeyboardEvent("keydown",{key,bubbles:true,cancelable:true}))
        press("ArrowDown")
        press("ArrowDown")
        press("ArrowUp")
        return {
            order:[...document.querySelectorAll(".vertical.left.content > .accordion.container")]
                .map(r=>r.querySelector(".accordion.handler.label").textContent).join(","),
            stillFocused:document.activeElement===grip
        }
    })()`)
    test("the arrows move the focused panel, up and down",()=>{
        eq(keys.order,"alpha,gamma,beta")
    })
    test("and the grip KEEPS the focus, so the move can be repeated",()=>{
        eq(keys.stillFocused,true,"the focus left the grip after the first arrow")
    })

    /* LA MARQUE: sur la moitié visée, et disparue après le dépôt. */
    const mark=await page.evaluate(`(()=>{
        const rows=[...document.querySelectorAll(".vertical.left.content > .accordion.container")]
        const from=rows[0].querySelector(".accordion.handler.menu")
        const onto=rows[2]
        const box=onto.getBoundingClientRect()
        const transfer=new DataTransfer()
        from.dispatchEvent(new DragEvent("dragstart",{bubbles:true,dataTransfer:transfer}))
        onto.dispatchEvent(new DragEvent("dragover",{bubbles:true,cancelable:true,dataTransfer:transfer,
            clientY:box.top+1,clientX:box.left+5}))
        const lit=[...document.querySelectorAll(".reorder-above,.reorder-below")]
        const during=lit.map(el=>el.classList.contains("reorder-above")?"above":"below")
        const dragging=document.querySelectorAll(".reordering").length
        from.dispatchEvent(new DragEvent("dragend",{bubbles:true,dataTransfer:transfer}))
        return {during,dragging,left:document.querySelectorAll(".reorder-above,.reorder-below").length}
    })()`)
    test("the hovered panel is marked on the half being aimed at",()=>{
        eq(JSON.stringify(mark.during),JSON.stringify(["above"]))
    })
    test("the dragged panel is dimmed while it travels",()=>{
        eq(mark.dragging,1)
    })
    test("the mark is gone once the drag ends",()=>{
        eq(mark.left,0,"a lit line outlived the drag")
    })

    /* UN GLISSER ÉTRANGER doit rester au navigateur: la colonne ne peut pas
       avaler le dépôt d'un fichier venu du bureau. */
    const foreign=await page.evaluate(`(()=>{
        const rows=[...document.querySelectorAll(".vertical.left.content > .accordion.container")]
        const box=rows[1].getBoundingClientRect()
        const event=new DragEvent("dragover",{bubbles:true,cancelable:true,
            clientY:box.top+2,clientX:box.left+5})
        rows[1].dispatchEvent(event)
        return event.defaultPrevented
    })()`)
    test("a drag that is NOT a panel is left to the browser",()=>{
        eq(foreign,false,"the column refused a foreign drag and would eat the file drop")
    })

    /* LA PERSISTANCE, mesurée après un VRAI rechargement. */
    const ranks=await page.evaluate(`(()=>[...document.querySelectorAll(
        ".vertical.left.content > .accordion.container")].map(r=>r.accordion.panelOrder()))()`)
    test("each panel reads its own rank off the DOM",()=>{
        eq(JSON.stringify(ranks),JSON.stringify([0,1,2]))
    })
    const inFile=await page.evaluate(`(()=>{
        globalThis.Attributor.saveSessionSoon.flush()
        const stored=JSON.parse(sessionStorage.getItem("attributor:session"))
        return stored.flows[0].nodes.map(n=>({title:n.title,rank:n.panelOrder}))
    })()`)
    test("the ranks are what the skeleton carries",()=>{
        /* The file lists the nodes in CREATION order, whatever their rank: the
           ranks say where each panel STANDS, so this compares the mapping read
           node by node against the screen. Comparing the list with itself would
           pass even if both were wrong. */
        const byTitle=Object.fromEntries(inFile.map(entry=>[entry.title,entry.rank]))
        eq(byTitle.alpha,0,`alpha is ranked ${byTitle.alpha}`)
        eq(byTitle.gamma,1,`gamma is ranked ${byTitle.gamma}`)
        eq(byTitle.beta,2,`beta is ranked ${byTitle.beta}`)
    })
    await page.reload({waitUntil:"networkidle2"})
    await page.waitForFunction("globalThis.Attributor!==undefined",{timeout:30000})
    const reloaded=await readColumn(page)
    test("the arrangement survives a reload",()=>{
        eq(JSON.stringify(reloaded),JSON.stringify(["alpha","gamma","beta"]))
    })
    test("no page error was raised along the way",()=>{
        eq(seen.filter(l=>l.startsWith("pageerror")).join(" | "),"")
    })
}finally{
    await shutdown({browser,server})
}
log(`${passed} passed, ${failures.length} failed`)
if(failures.length){
    process.exitCode=1
}