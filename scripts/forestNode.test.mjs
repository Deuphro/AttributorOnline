/* ===========================================================================
   forestNode.test.mjs — LE CONTRAT DU NŒUD, sans DOM.

   Ce que ce fichier vérifie n'est pas une physique: ce sont les NOMS. Le
   programme a déjà payé deux fois le prix d'un réglage qui existe d'un côté et
   pas de l'autre — un champ affiché, un paramètre lu, deux listes qui divergent
   en silence. Aucun de ces défauts ne se voit dans un calcul: ils se voient
   quand l'utilisateur agit et que rien ne bouge.

   La technique est celle de `collectionReader.test.mjs`: slicer le fichier entre
   deux ancres, vérifier que les DEUX ancres ont été trouvées, puis regarder la
   tranche. On n'évalue jamais le fichier entier — il importe d3 depuis un CDN.
   =========================================================================== */
import {test} from "node:test"
import assert from "node:assert/strict"
import {readFileSync} from "node:fs"

const INTERFACE=readFileSync(new URL("./interface.js",import.meta.url),"utf8")
const WORKER=readFileSync(new URL("./kernelWorker.js",import.meta.url),"utf8")
const POOL=readFileSync(new URL("./workerPool.js",import.meta.url),"utf8")
const SERVER=readFileSync(new URL("../index.js",import.meta.url),"utf8")
const FOREST=readFileSync(new URL("./forest.js",import.meta.url),"utf8")

/* LA TRANCHE, entre deux ancres, et les deux sont vérifiées: une ancre
   manquante donnerait une tranche vide, et un test qui passe sur une tranche
   vide est un test qui ne teste rien. C'est le piège le plus facile à tomber
   ici, et il ne se voit pas. */
const slice=(text,from,to,what)=>{
    const start=text.indexOf(from)
    assert.ok(start>=0,`anchor not found: ${what} start`)
    const end=text.indexOf(to,start+from.length)
    assert.ok(end>start,`anchor not found: ${what} end`)
    return text.slice(start,end)
}

const NODE=slice(
    INTERFACE,
    "class AttributionNode extends NodeWithAccordion{",
    "class PeakPickingNode extends NodeWithAccordion{",
    "the attribution node"
)

const SETTINGS=["forestTolerance","forestDegreeMax","forestCharge"]

test("the node class is BRACED, so its methods are methods",()=>{
    /* Le fichier COMPILAIT avec une accolade manquante: la méthode suivante
       devenait un LABEL suivi d'un bloc, donc du code mort — et le nœud aurait
       eu un `suicide` qui ne tuait pas son panneau, et pas de réseau du tout.
       Aucune des autres assertions ne l'aurait vu: elles lisaient du TEXTE, et
       le texte était là.

       L equilibrage des accolades est donc vérifié, et il se lit sur la tranche
       de la classe entière: profondeur 0 à la fin, et jamais négative — une
       accolade qui se ferme avant de s'ouvrir est le symptôme exact. */
    let depth=0
    for(const char of NODE){
        if(char==="{") depth++
        else if(char==="}") depth--
        assert.ok(depth>=0,"a closing brace appears before its opening one")
    }
    assert.equal(depth,0,"the node class does not close: a method swallowed the next one")
})

test("each network method is DEFINED, not merely mentioned",()=>{
    /* Un appel à une méthode absente est un `TypeError` AU CLIC, pas au
       chargement: le nœud s'affiche, se règle, et casse quand on presse le
       bouton. Et un test qui lit du texte voit la mention sans voir la
       définition — donc on exige les DEUX. */
    for(const name of ["buildForestPlan","refreshForestPlan","growForestAsync",
        "startForest","renderForestButton","setupForestPanel","commitForestNumber",
        "renderForest","forestForestOf","renderForestList","forestRow"]){
        assert.ok(NODE.includes(`${name}(`),
            `${name} is never called on the node`)
        assert.ok(NODE.includes(`    ${name}(`)||NODE.includes(`    async ${name}(`),
            `${name} is called but never DEFINED at class level: it would throw on click`)
    }
})

test("the three network settings exist, with Igor's own defaults",()=>{
    assert.match(NODE,/this\.parameters\.forestTolerance=DEFAULT_LINK_TOLERANCE/)
    /* 0 = aucun plafond: c'est le `degmax=inf` de `GrowForest`, le mode par
       défaut de l'oracle. Un 2 par défaut changerait la NATURE du réseau sans
       que l'utilisateur l'ait demandé. */
    assert.match(NODE,/this\.parameters\.forestDegreeMax=0/)
    /* 0 = la charge du plan, donc l'oracle jusqu'à preuve du contraire. */
    assert.match(NODE,/this\.parameters\.forestCharge=0/)
})

test("the three settings cross every place a setting has to cross",()=>{
    const serialised=slice(NODE,"    serializeState(){","    restoreState(","serializeState")
    const restored=slice(NODE,"    restoreState(state){","    syncUI(){","restoreState")
    const synced=slice(NODE,"    syncUI(){","    registered(e){","syncUI")
    for(const name of SETTINGS){
        assert.ok(serialised.includes(name),
            `${name} is not serialised: it would not survive a session`)
        assert.ok(restored.includes(`"${name}"`),
            `${name} is not in restoreState's list: a session would show the defaults`)
        assert.ok(synced.includes(name),
            `${name} is not in syncUI: the field would show the default while the network used the restored value`)
    }
})

test("the panel builds a field and a button for each of them",()=>{
    const panel=slice(NODE,"    setupForestPanel(){","    commitForestNumber(","setupForestPanel")
    for(const name of SETTINGS){
        assert.ok(panel.includes(`this.${name}Input`),
            `${name} has no input, so syncUI has nothing to write into`)
    }
    /* ET LE BOUTON, parce qu'un réseau qui se lancerait tout seul au resolve
       attacherait deux questions distinctes: le crible produit des formules,
       le réseau produit des liens, et l'un ne dépend pas de l'autre. */
    assert.match(panel,/this\.forestButton=CE\("button"/)
    assert.match(panel,/addEventListener\("click",\(\)=>this\.startForest\(\)\)/)
})

test("the three steps of Igor's oracle are all here",()=>{
    /* `formatStds` → la liste de références, `GrowForest` → l'arbre,
       `CompteTribue` → la liste des composantes. */
    assert.match(NODE,/buildForestPlan\(\)\{/)
    assert.match(NODE,/growForestAsync\(wave,standards\)\{/)
    assert.match(NODE,/forestComponents\(forest,standards\)/)
    /* ET LE CALCUL VA DANS LE WORKER, pas sur le thread principal: c'est la
       raison d'être du noyau Rust. Une régression ici ne se verrait qu'à la
       fluidité, donc elle est affirmée par un test. */
    assert.match(NODE,/computePool\.run\("attributionForest"/)
})

test("the node falls back on the SAME calculation, and says so",()=>{
    const method=slice(NODE,"    async growForestAsync(wave,standards){","    /* TEMPS 3","growForestAsync")
    /* Un repli « approché » laisserait deux physiques dans le programme, et celle
       qui répondrait serait celle qu'on ne testerait pas. */
    assert.match(method,/growForest\(payload\.params\)/)
    assert.match(method,/console\.warn\("\[network\] kernel unavailable, JS fallback:"/)
    /* Et le repli ne se déclenche que sur un NOYAU INDISPONIBLE, jamais sur un
       résultat: un arbre vide est un résultat, pas une panne. */
    assert.match(method,/if\(!forest\) throw new Error/)
})

test("the network never repaints the NODE status",()=>{
    /* Le statut du nœud raconte l'ATTRIBUTION. Le repeindre après un réseau
       donnerait un nœud vert au-dessus d'un readout d'attributions vide, alors
       que l'attribution n'a peut-être jamais été lancée. */
    const method=slice(NODE,"    async startForest(){","    renderForestButton(busy){","startForest")
    assert.ok(!/setStatus\(/.test(method),
        "startForest must not set the node status: that status belongs to the attribution")
    /* L'attente se lit sur le bouton, qui appartient au panneau qui travaille. */
    assert.match(method,/this\.renderForestButton\(true\)/)
    assert.match(method,/this\.renderForestButton\(false\)/)
})

test("the network panel is created, registered AND killed with the node",()=>{
    assert.match(NODE,/this\.forestAccordion=new Accordion\(/)
    assert.match(NODE,/`\$\{registrationName\}:network`/)
    /* Un panneau de droite que `suicide` ne tue pas reste à l'écran, avec des
       résultats que plus rien ne produit. */
    assert.match(NODE,/this\.forestAccordion\?\.suicide\(\)/)
})

test("the reference list is rebuilt from the plan, never beside it",()=>{
    /* Une liste de références rafraîchie à la main finit périmée: le panneau se
       remplit à l'ouverture, au resolve et à chaque changement de groupe, et
       trois appels manuels sont trois occasions d'en oublier un. */
    assert.match(NODE,/this\.refreshForestPlan\(\)/)
    const refresh=slice(NODE,"    refreshForestPlan(){","    /* Every XY wave","refreshForestPlan")
    assert.match(refresh,/this\.buildForestPlan\(\)/)
    assert.match(refresh,/this\.renderForest\(\)/)
})

test("the module is served: an import nothing serves is a 404 at the click",()=>{
    assert.match(SERVER,/"\/scripts\/forest\.js":"scripts\/forest\.js"/)
    /* Et il est importé par les TROIS consommateurs, dont le worker — c'est le
       seul moyen que le repli y soit disponible sans chimie. */
    assert.match(INTERFACE,/from "\.\/forest\.js"/)
    assert.match(WORKER,/from "\.\/forest\.js"/)
    assert.match(POOL,/from "\.\/forest\.js"/)
})

test("the reference list refuses adducts, and says that it does",()=>{
    /* C'est une DÉCISION, pas un oubli: un adduit porte une charge, pas un
       incrément de masse. Comparé aux écarts de m/z il produirait des liens
       sans signification, et le dire est la moitié du travail. */
    /* L'ancre de fin est le BLOC SUIVANT, pas une accolade: une accolade ferme
       le premier `if` de la fonction et la tranche ne dirait rien du refus des
       adductions — un test qui passe sur une tranche tronquée. */
    const standards=slice(FOREST,"export function forestStandards(","/* LA RÉFÉRENCE LA PLUS PROCHE","forestStandards")
    assert.match(standards,/kind==="combining"/)
    assert.match(standards,/adducts are not used as references/)
})