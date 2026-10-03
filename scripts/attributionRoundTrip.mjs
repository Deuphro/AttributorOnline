/* -------------------------------------------------------------------------
   attributionRoundTrip.mjs — LE NŒUD D'ATTRIBUTION, APRÈS AVOIR ÉTÉ RECRÉÉ.

   Un nœud d'attribution n'est pas une boîte à réglages: il porte DEUX listes
   de groupes avec leurs bornes, une fenêtre de charge, et il produit UNE liste
   d'attributions PAR VAGUE ENTRÉE. Le chemin le plus long qui puisse lui
   arriver est donc un aller-retour complet, et c'est ce que ce fichier mesure.

   LES CHEMINS DE RECRÉATION, parce qu'ils ne passent pas tous par le même
   code:

     1. undo d'une suppression   → createNodeForHistory + flow.replacements
     2. redo puis undo            → le même, une seconde fois (l'idempotence)
     3. undo/redo d'une création  → le même, mais l'enregistrement a été fait
                                    par le menu, AVANT que les réglages
                                    n'existent: c'est l'état de NAISSANCE qui
                                    revient, pas l'état courant
     4. patron                    → buildNode + restoreState, sans données
     5. session (sauvegarde/relecture) → sessions.js, qui sérialise, encode
                                    et décode ses propres structures

   node scripts/attributionRoundTrip.mjs
   ------------------------------------------------------------------------- */
import {open,log,shutdown} from "./harness.mjs"
import {PEAKS} from "./fixture.mjs"

/* DEUX VAGUES, et non une: le nœud rend une liste par entrée, donc une seule
   ne prouverait rien du multiplexage — le nombre de listes rendues doit
   survivre à l'aller-retour, lui aussi. */
const PAIRS_A=PEAKS.map((mz,i)=>[mz,1000-i])
const PAIRS_B=PEAKS.map((mz,i)=>[mz,600-i*3])

const {browser,page,server,seen}=await open()

/* Les réglages distinctifs — et un piège que ce fichier a déjà payé cher.

   Une liste IMPRODUCTIVE ne casse rien: elle rend zéro formule, et tout le
   reste de l'aller-retour devient MOISI, parce qu'on ne compare plus que des
   réglages et des tableaux vides — et « tout est identique » veut alors dire
   « rien n'a été comparé ». D'où l'assertion sur la RÉFÉRENCE: si ses
   attributions tombent à zéro, le fichier le dit au lieu de passer au vert.

   Les groupes restent donc ceux de la liste par défaut — ils sont productifs
   sur cette fixture, c'est mesuré — et ce qui change, c'est ce qui n'avait
   jamais été exercé : une borne, un isotope, un second adduit, et les quatre
   nombres. */
const CUSTOM_STATE={
    combining:[
        {group:"CH2",min:0,max:Infinity,ratio:1},
        {group:"NH",min:0,max:3,ratio:1},
        {group:"O",min:0,max:2,ratio:1},
        {group:"C",min:0,max:Infinity,ratio:0.5}
    ],
    ionising:[
        {group:"[H+]",min:1,max:1,ratio:1},
        {group:"[Na+]",min:0,max:1,ratio:1}
    ],
    ratio:0.1,
    chargeMin:1,
    chargeMax:1,
    bestMatches:4,
    ppm:15,
    probeMass:46.04186
}
await page.evaluate(`(async()=>{
    const {Wave}=await import("./scripts/formats.js")
    const PAIRS_A=${JSON.stringify(PAIRS_A)}
    const PAIRS_B=${JSON.stringify(PAIRS_B)}
    /* Infinity ne survit pas à JSON: il y deviendrait null, et null se
       confondrait avec « pas de borne ». Il est nommé avant de sortir. */
    const inf=v=>typeof v==="number"&&!Number.isFinite(v)?(v>0?"inf":"-inf"):v
    const cleanGroups=list=>list.map(g=>({
        group:g.group,min:inf(g.min),max:inf(g.max),ratio:g.ratio
    }))
    const find=(title="Attribution")=>{
        const flow=globalThis.Attributor.channel.get("mainFlow")
        return [...flow.nodeSet]
            .find(n=>n.constructor.name==="AttributionNode"&&n.title===title)??null
    }
    /* LE MARQUEUR. Deux nœuds peuvent porter le MÊME titre — un patron reprend
       celui du nœud copié — et l'ordre d'un Set n'est pas un identifiant. Alors
       chaque nœud est étiqueté à l'endroit où on sait lequel c'est, et le
      snapshot se fait sur l'étiquette. Sans cela, la comparaison porte sur un
       nœud différent de celui de la référence, et « tout est identique » ne
       veut plus rien dire. */
    const tag=(node,name)=>{
        if(node) node.__rtTag=name
        return node
    }
    const byTag=name=>{
        const flow=globalThis.Attributor.channel.get("mainFlow")
        return [...flow.nodeSet].find(n=>n.__rtTag===name)??null
    }
    const untagged=()=>{
        const flow=globalThis.Attributor.channel.get("mainFlow")
        return [...flow.nodeSet]
            .find(n=>n.constructor.name==="AttributionNode"&&!n.__rtTag)??null
    }
    const feed=node=>{
        node.inputs[0]=new Map()
        node.inputs[0].set("vague A",[[Wave.fromPairs(PAIRS_A,{title:"A"})]])
        node.inputs[0].set("vague B",[[Wave.fromPairs(PAIRS_B,{title:"B"})]])
    }
    globalThis.__cleanGroups=cleanGroups
    globalThis.__inf=inf
    globalThis.__find=find
    globalThis.__tag=tag
    globalThis.__byTag=byTag
    globalThis.__untagged=untagged
    /* LES ÉTIQUETTES SUIVENT LES NOEUDS. Un undo fabrique d'autres
       instances: une étiquette posée sur l'ancienne ne dit plus rien. Le
       chemin est déjà lé: flow.replacements relie le mort au vivant. */
    const adopt=()=>{
        const flow=globalThis.Attributor.channel.get("mainFlow")
        for(const [dead,fresh] of flow.replacements){
            if(dead?.__rtTag){ fresh.__rtTag=dead.__rtTag }
        }
    }
    globalThis.__adopt=adopt
    globalThis.__feed=feed
})()`)
const SNAPSHOT=`(async({feedData=true,resolve=true,tag="ref"}={})=>{
    const inf=globalThis.__inf
    /* tag:null = « le seul nœud d'attribution qui reste », ce qui est le cas
       après une relecture: la session a reconstruit des instances neuves,
       sans nos étiquettes. */
    const node=tag===null
        ?(()=>{
            const flow=globalThis.Attributor.channel.get("mainFlow")
            const all=[...flow.nodeSet]
                .filter(n=>n.constructor.name==="AttributionNode")
            return all.length===1?all[0]:null
        })()
        :globalThis.__byTag(tag)
    if(!node) return {error:tag===null
        ?"la relecture n'a laissé aucun nœud d'attribution unique"
        :"no AttributionNode tagged "+tag}
    if(feedData) globalThis.__feed(node)
    if(resolve) await node.startResolve()
    const cleanGroups=globalThis.__cleanGroups
    const state=node.serializeState()
    const box=node.accordion?.DOMelt?.content
    return {
        serialized:{
            combining:cleanGroups(state.combining),
            ionising:cleanGroups(state.ionising),
            ratio:inf(state.ratio),
            chargeMin:inf(state.chargeMin),
            chargeMax:inf(state.chargeMax),
            bestMatches:state.bestMatches,
            ppm:state.ppm,
            probeMass:state.probeMass
        },
        parameters:{
            ratio:inf(node.parameters.ratio),
            chargeMin:inf(node.parameters.chargeMin),
            chargeMax:inf(node.parameters.chargeMax),
            bestMatches:node.parameters.bestMatches,
            ppm:node.parameters.ppm,
            probeMass:node.parameters.probeMass
        },
        lists:{combining:cleanGroups(node.groupList("combining")),
               ionising:cleanGroups(node.groupList("ionising"))},
        plan:node.plan?{
            combinables:node.plan.combinables.length,
            ionisers:node.plan.ionisers.length,
            chargeSet:[...node.plan.chargeSet],
            neutralPossible:!!node.plan.neutralPossible,
            diagnostics:[...node.plan.diagnostics]
        }:null,
        chargeLabel:node.chargeLabel?.textContent??"",
        /* L'ÉCRAN, pas les paramètres. C'est ce qui distingue « l'intention
           a survécu » de « l'utilisateur la voit encore ». */
        tables:[...(box?.querySelectorAll(".an-group-table")??[])].map(b=>({
            caption:b.querySelector(".an-caption")?.textContent??"",
            rows:[...b.querySelector(".an-group-rows").children].map(row=>({
                text:row.textContent,
                inputs:[...row.querySelectorAll("input")].map(i=>i.value)
            }))
        })),
        fields:{
            bestMatches:node.bestMatchesInput?.value??null,
            ppm:node.ppmInput?.value??null,
            probe:node.massInput?.value??null
        },
        readout:node.readout?.textContent??"",
        attributions:(node.attributions??[]).map(a=>({
            entries:a.entries.length,
            candidates:a.candidates,
            keptMatches:a.keptMatches,
            pointCount:a.pointCount,
            first:a.entries.slice(0,5).map(e=>e.notation)
        })),
        outputs:(node.outputs??[]).map(o=>Array.isArray(o)?o.length:-1),
        status:node.status,
        needsResolve:node.needsResolve
    }
})`

const snap=(options={})=>page.evaluate(`${SNAPSHOT}(${JSON.stringify(options)})`)
/* Une comparaison qui dit OÙ, sinon un échec de quarante lignes n'apprend
   rien. Douze différences au plus: au-delà, la liste n'est plus lisible. */
function diff(a,b,path="",out=[]){
    if(out.length>=12) return out
    if(JSON.stringify(a)===JSON.stringify(b)) return out
    const bothObjects=a&&b&&typeof a==="object"&&typeof b==="object"
    if(bothObjects&&Array.isArray(a)===Array.isArray(b)){
        for(const k of new Set([...Object.keys(a),...Object.keys(b)])){
            diff(a[k],b[k],`${path}.${k}`,out)
        }
        return out
    }
    out.push(`${path||"(racine)"}\n        attendu : ${JSON.stringify(a)}`+
             `\n        obtenu  : ${JSON.stringify(b)}`)
    return out
}

const failures=[]
const ok=(condition,label)=>{
    log(`   ${condition?"OK  ":"ECHEC"}  ${label}`)
    if(!condition) failures.push(label)
}
const sameAs=(reference,label,got,referenceName="référence")=>{
    const d=diff(reference,got)
    ok(d.length===0,`${label} — identique à la ${referenceName}`)
    for(const line of d) log(`      ${line}`)
}

const create=title=>page.evaluate(`(()=>{
    dispatchEvent(new CustomEvent("createNode",{detail:{msg:{
        title:${JSON.stringify(title)},type:"attribution"
    }}}))
})()`)
log("0. LE NŒUD NEUF, TEL QUE LE MENU LE POSE")
await create("Attribution")
await new Promise(r=>setTimeout(r,1500))
await page.evaluate(`(()=>{globalThis.__tag(globalThis.__find(),"ref")})()`)
const fresh=await snap()
ok(fresh.error===undefined,"le nœud existe")
ok(fresh.attributions?.length===2,
    `deux vagues en entrée → deux listes rendues (${fresh.attributions?.length})`)
ok((fresh.attributions??[]).every(a=>a.entries>0),
    `chaque vague a trouvé des formules (${(fresh.attributions??[]).map(a=>a.entries).join(", ")})`)

log("\n1. RÉFÉRENCE — DES RÉGLAGES DISTINCTIFS POSÉS À LA MAIN")
await page.evaluate(`(()=>{
    const node=globalThis.__find()
    node.restoreState(${JSON.stringify(CUSTOM_STATE)})
})()`)
const reference=await snap()
sameAs(reference,"le nœud de référence est stable",await snap())
ok(reference.lists.combining.length===4,"la liste combinante a bien 4 groupes")
ok(reference.lists.ionising.length===2,"la liste ionisante a bien 2 adduits")
/* LE GARDOU. Sans cette assertion, une fixture devenue improductive ferait
   passer le fichier au vert en ne comparant plus que du vide. */
ok((reference.attributions??[]).length===2
    &&reference.attributions.every(a=>a.entries>0),
    `la RÉFÉRENCE trouve des formules (${
        (reference.attributions??[]).map(a=>a.entries).join(", ")} entrées) — le reste compare`)
ok(reference.fields.probe==="46.04186",`la sonde affiche la masse saisie (${reference.fields.probe})`)
ok(reference.fields.ppm==="15",`le champ ppm affiche le réglage (${reference.fields.ppm})`)

/* LA TAILLE DE CE QUE CHAQUE PIÈCE PÈSE, parce que « ça n'a pas pu s'écrire »
   n'explique rien. Mesuré sur le nœud du PATRON, qui vient d'être nourri et
   résolu à l'instant: c'est le seul, à ce stade, dont les sorties sont
   réellement peuplées. */
const weight=await page.evaluate(`(()=>{
    const node=globalThis.__byTag("ref")
    const sizes={}
    const measure=(name,value)=>{
        try{ sizes[name]=JSON.stringify(value).length }
        catch(e){ sizes[name]=e.name+": "+e.message }
    }
    measure("state",node.serializeState())
    measure("outputs",node.outputs)
    sizes.attributions=(node.attributions??[]).map(a=>a.entries.length).join("+")
    sizes.collectionEntries=(node.outputs[0]??[]).map(c=>(c.entries??[]).length).join("+")
    sizes.collectionAttributionCount=(node.outputs[0]??[]).map(c=>c.attributionCount).join("+")
    const collections=node.outputs[0]
    if(Array.isArray(collections)&&collections[0]){
        measure("one collection",collections[0])
        measure("the periodic table",collections[0].table)
        const entries=collections[0].entries??[]
        measure("one entry",entries[0])
        sizes.collections=collections.length
        sizes.entriesPerCollection=collections.map(c=>(c.entries??[]).length).join("+")
        /* Ce qu'une session porterait SI les Formula sortaient par leur clé:
           c'est le plancher honnête, pas un espoir. */
        measure("keys only",collections.map(c=>({
            name:c.name,ppm:c.ppm,points:c.points,
            entries:(c.entries??[]).map(e=>e.key)
        })))
    }
    return sizes
})()`)
log("\n2. UNDO D'UNE SUPPRESSION (createNodeForHistory + flow.replacements)")
/* Un câble AVANT, pour que le chemin du recâblage soit armé: `suicide` le
   gérait déjà seul, et c'est lui qu'on a extrait pour le servir aussi à la
   suppression de groupe. Un refactor qui casse l'ancien caller doit se voir
   ici, pas dans le pas 8. */
await page.evaluate(`(()=>{
    const flow=globalThis.Attributor.channel.get("mainFlow")
    dispatchEvent(new CustomEvent("createNode",{detail:{msg:{
        title:"Amont",type:"delimitedText"
    }}}))
})()`)
await new Promise(r=>setTimeout(r,700))
await page.evaluate(`(()=>{
    const flow=globalThis.Attributor.channel.get("mainFlow")
    const source=[...flow.nodeSet]
        .find(n=>n.constructor.name==="DelimitedTextNode")
    globalThis.__tag(source,"amont")
    flow.createLink(source,0,globalThis.__byTag("ref"),0)
    globalThis.__cablesAvant=flow.linkList.length
})()`)
await page.evaluate(`(()=>{globalThis.__byTag("ref").suicide()})()`)
ok(await page.evaluate(`globalThis.__byTag("ref")===null`),"le nœud a bien disparu")
await page.evaluate(`(()=>{globalThis.Attributor.history.undo()})()`)
await page.evaluate(`(()=>{globalThis.__tag(globalThis.__untagged(),"ref")})()`)
sameAs(reference,"le nœud revenu par l'undo",await snap())
ok(await page.evaluate(`globalThis.Attributor.channel.get("mainFlow").linkList.length`)
    ===await page.evaluate(`globalThis.__cablesAvant`),
    "suicide() rebâtit toujours SON câble — le chemin extrait n'a rien perdu")

log("\n3. REDO PUIS UNDO — LE MÊME CHEMIN, UNE SECONDE FOIS")
await page.evaluate(`(()=>{globalThis.Attributor.history.redo()})()`)
ok(await page.evaluate(`globalThis.__byTag("ref")===null`),"le redo a bien supprimé le nœud")
await page.evaluate(`(()=>{globalThis.Attributor.history.undo()})()`)
await page.evaluate(`(()=>{globalThis.__tag(globalThis.__untagged(),"ref")})()`)
sameAs(reference,"le nœud revenu par le second undo",await snap())

log("\n4. UNDO/REDO D'UNE CRÉATION (l'état de NAISSANCE, pas l'état courant)")
await create("Attribution (2)")
await new Promise(r=>setTimeout(r,1500))
await page.evaluate(`(()=>{globalThis.__tag(globalThis.__untagged(),"birth")})()`)
sameAs(fresh,"un nœud juste créé est identique au premier",
    await snap({tag:"birth"}),"référence de naissance")
await page.evaluate(`(()=>{globalThis.Attributor.history.undo()})()`)
ok(await page.evaluate(`globalThis.__byTag("birth")===null`),
    "l'undo a supprimé la création")
await page.evaluate(`(()=>{globalThis.Attributor.history.redo()})()`)
await page.evaluate(`(()=>{globalThis.__tag(globalThis.__untagged(),"birth")})()`)
sameAs(fresh,"le nœud recréé par le redo",
    await snap({tag:"birth"}),"référence de naissance")

log("\n5. UN PATRON (buildNode + restoreState, sans données)")
await page.evaluate(`(()=>{
    const flow=globalThis.Attributor.channel.get("mainFlow")
    flow.selectOnly(globalThis.__byTag("ref"))
    flow.instantiatePattern(flow.patternFromSelection("patron"),{x:600,y:320})
})()`)
await new Promise(r=>setTimeout(r,800))
ok(await page.evaluate(`globalThis.__untagged()!==null`),"le patron a posé un nœud")
await page.evaluate(`(()=>{globalThis.__tag(globalThis.__untagged(),"pasted")})()`)
sameAs(reference,"le nœud posé par le patron",await snap({tag:"pasted"}))


/* LE CHEMIN DU SQUELETTE, qui est celui d'un RECHARGEMENT — le F5, « Save
   (local) ». Le squelette ne porte que la FORME et l'état, aucune donnée
   dérivée, donc il n'a rien à voir avec le poids mesuré plus bas. Il faut le
   vérifier quand même: c'est le chemin que prend un rechargement. */
const skeleton=await page.evaluate(`(async()=>{
    const {exportSkeleton,parseSkeleton}=await import("./scripts/sessionStore.js")
    try{
        const text=exportSkeleton(globalThis.Attributor)
        const document_=parseSkeleton(text)
        return {ok:!!document_,length:text.length}
    }catch(error){
        return {ok:false,error:error.name+": "+error.message}
    }
})()`)
ok(skeleton.ok,`le squelette s'écrit (${
    skeleton.length?`${Math.round(skeleton.length/1024)} Ko`:skeleton.error})`)

/* ---- LE POIDS DU GRAPHE, avant que quiconque ne l'écrive. ----

   Le squelette passe: il ne porte que la FORME et l'état, aucune donnée
   dérivée, donc rien de tout ce qui suit ne le concerne.

   La session COMPLÈTE, elle, encode les SORTIES résolues. Une entrée de
   FormulaCollection est une Formula COMPLÈTE, et une Formula transporte le
   tableau périodique — 124 Ko, le MÊME objet pour les 440 Formula du nœud.
   Additionné tel quel par `JSON.stringify`, cela donnait 85 Mo et « allocation
   size overflow ». Le graphe ci-dessous est donc la TAILLE DU GRAPHE, pas celle
   du fichier: ce que l'encodeur en écrit se mesure au pas 7. */
for(const [k,v] of Object.entries(weight)) log(`      ${k.padEnd(26)} ${v}`)

log("\n7. LA SESSION COMPLÈTE (File → Export session)")
/* La session COMPLÈTE encode aussi les ENTRÉES et les SORTIES résolues. Le
   champ contient encore les nœuds des étapes précédentes — on n'en garde qu'un,
   le nœud de référence — parce que « le nœud relu » n'a pas de sens s'il y en a
   trois du même titre, et parce qu'une session à un seul nœud est le cas
   minimal qui produisait l'échec.

   Le JSON reste DANS LA PAGE: le faire transiter par le protocole serait
   l'`Import session` du menu, pas une mesure. */
await page.evaluate(`(()=>{
    const flow=globalThis.Attributor.channel.get("mainFlow")
    const keep=globalThis.__byTag("ref")
    flow.selection.clear()
    for(const node of flow.nodeSet){
        if(node!==keep) flow.selection.add(node)
    }
    flow.deleteSelection()
    globalThis.__adopt()
})()`)
const saved=await page.evaluate(`(()=>{
    try{
        const json=globalThis.Attributor.saveSession({})
        globalThis.__json=json
        return {ok:true,length:json.length}
    }catch(error){
        return {ok:false,error:error.name+": "+error.message}
    }
})()`)
ok(saved.ok,`la session complète s'écrit (${
    saved.length?`${Math.round(saved.length/1024)} Ko`:saved.error})`)
if(saved.ok){
    await page.evaluate(`(async()=>{
        await globalThis.Attributor.importSession({json:globalThis.__json})
    })()`)
    await new Promise(r=>setTimeout(r,1500))
    /* La relecture remplace l'App ENTIÈREMENT: les étiquettes des étapes
       précédentes sont parties avec lui. Le nœud relu est le seul nœud
       d'attribution du champ, et il faut le savoir pour les étapes suivantes. */
    await page.evaluate(`(()=>{globalThis.__tag(globalThis.__untagged(),"ref")})()`)
    const imported=await snap({tag:null})
    ok(imported.error===undefined,"le nœud a bien été recréé par la relecture")
    sameAs(reference,"le nœud relu de la session",imported)
}

/* LA suppression D'UN GROUPE. `deleteSelection` enregistre UN SEUL geste pour
   N nœuds, et son `undo` les recrée par `createNodeForHistory`… sans jamais
   recâbler. `suicide` le fait, lui: il note les liens qu'il coupe et les
   rebâtit. Deux chemins pour le même acte, et l'un des deux oublie le câble. */
log("\n8. SUPPRESSION DE GROUPE : LE CÂBLE EST-IL REBÂTI ?")
await page.evaluate(`(async()=>{
    const {Wave}=await import("./scripts/formats.js")
    const flow=globalThis.Attributor.channel.get("mainFlow")
    dispatchEvent(new CustomEvent("createNode",{detail:{msg:{
        title:"Producteur",type:"delimitedText"
    }}}))
    await new Promise(r=>setTimeout(r,700))
    /* Un nœud de fichier se renomme tout seul: on le cherche donc par ce qu'il
       EST, pas par le titre qu'on lui a donné. */
    const source=[...flow.nodeSet]
        .find(n=>n.constructor.name==="DelimitedTextNode"&&n!==globalThis.__byTag("ref"))
    globalThis.__tag(source,"src")
    source.outputs[0]=[[Wave.fromPairs(${JSON.stringify(PAIRS_A)},{title:"A"})]]
    source.setStatus?.("resolved")
    flow.linkNodes({source,sourceIndex:0,target:globalThis.__byTag("ref"),
                    targetIndex:0,record:false,relayout:false})
})()`)
/* UN COMPTAGE, PAS UNE VALEUR: le champ traîne déjà des câbles d'autres
   étapes, et « il y en a deux à la fin » ne prouve rien. Ce qui compte, c'est
   le nombre AU MOMENT où le geste a eu lieu, comparé à celui d'après. */
const linked=await page.evaluate(`(()=>{
    const flow=globalThis.Attributor.channel.get("mainFlow")
    globalThis.__cablesSurRef=()=>flow.linkList
        .filter(l=>l.outputNode===globalThis.__byTag("ref")).length
    globalThis.__avant=globalThis.__cablesSurRef()
    return globalThis.__avant
})()`)
ok(linked>=1,`le cable est pose (${linked} cables sur le noeud)`)
const beforeDelete=await page.evaluate(`(()=>{
    const flow=globalThis.Attributor.channel.get("mainFlow")
    return {nodes:flow.nodeSet.size,links:flow.linkList.length}
})()`)
await page.evaluate(`(()=>{
    const flow=globalThis.Attributor.channel.get("mainFlow")
    flow.selection.clear()
    flow.selection.add(globalThis.__byTag("src"))
    flow.selection.add(globalThis.__byTag("ref"))
    flow.deleteSelection()
    globalThis.__adopt()
})()`)
ok(await page.evaluate(`globalThis.__byTag("src")===null`),
    "les deux nœuds ont bien disparu")
await page.evaluate(`(()=>{globalThis.Attributor.history.undo()})()`)
await new Promise(r=>setTimeout(r,400))
const relinked=await page.evaluate(`(()=>{
    const flow=globalThis.Attributor.channel.get("mainFlow")
    globalThis.__adopt()
    return {
        producer:!!globalThis.__byTag("src"),
        attribution:!!globalThis.__byTag("ref"),
        cables:globalThis.__cablesSurRef(),
        avant:globalThis.__avant
    }
})()`)
ok(relinked.producer&&relinked.attribution,
    "l'undo a bien ramené les deux nœuds")
ok(relinked.cables===relinked.avant,
    `le câble est rebâti par l'undo (${relinked.cables}, comme avant : ${relinked.avant})`)
ok(await page.evaluate(`globalThis.Attributor.channel.get("mainFlow").nodeSet.size`)
    ===beforeDelete.nodes,"le nombre de nœuds est rendu")

log("\n9. UN CÂBLE DONT LES DEUX EXTRÉMITÉS ÉTAIENT DANS LE GROUPE, ET LE REDO")
await page.evaluate(`(()=>{
    const flow=globalThis.Attributor.channel.get("mainFlow")
    flow.selection.clear()
    for(const node of flow.nodeSet){
        flow.selection.add(node)
    }
    flow.deleteSelection()
    globalThis.__adopt()
})()`)
ok(await page.evaluate(`globalThis.Attributor.channel.get("mainFlow").nodeSet.size`)===0,
    `tout le champ est vidé (${beforeDelete.nodes} nœuds d'un geste)`)
await page.evaluate(`(()=>{globalThis.Attributor.history.undo()})()`)
await new Promise(r=>setTimeout(r,600))
const afterUndo=await page.evaluate(`(()=>{
    const flow=globalThis.Attributor.channel.get("mainFlow")
    return {nodes:flow.nodeSet.size,links:flow.linkList.length}
})()`)
ok(afterUndo.nodes===beforeDelete.nodes,
    `tous les nœuds sont revenus (${afterUndo.nodes} sur ${beforeDelete.nodes})`)
ok(afterUndo.links===beforeDelete.links,
    `tous les câbles sont revenus, câux déjà liés entre eux compris (${afterUndo.links} sur ${beforeDelete.links})`)
await page.evaluate(`(()=>{globalThis.Attributor.history.redo()})()`)
await new Promise(r=>setTimeout(r,600))
const afterRedo=await page.evaluate(`(()=>{
    const flow=globalThis.Attributor.channel.get("mainFlow")
    return {nodes:flow.nodeSet.size,links:flow.linkList.length}
})()`)
ok(afterRedo.nodes===0,
    `le redo re-supprime le groupe (${afterRedo.nodes})`)
ok(afterRedo.links===0,
    `et ses câbles (${afterRedo.links}) — le redo existait avant cette correction`)

log("\n--- console ---")
for(const line of seen.slice(0,8)) log(line)

await shutdown({browser,server})
/* `process.exit` et non la sortie naturelle: le navigateur laisse parfois une
   requête en vol après la fermeture, et un fichier de vérification qui ne rend
   pas la main n'est plus un fichier de vérification. */
if(failures.length){
    log(`\n${failures.length} ECHEC(S)`)
    process.exit(1)
}
log("\nTOUT PASSE")
process.exit(0)
