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
/* LA FEUILLE DE STYLE, pour une seule chose: que les couleurs du graphique
   soient LUES dans la palette du programme plutôt que recopiées dans le test.
   Une constante dupliquée finit toujours par diverger de celle qu'elle vérifie,
   et le test continue de passer en vérifiant l'ancienne. */
const MAIN_CSS=readFileSync(new URL("../styles/main.css",import.meta.url),"utf8")

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

/* UNE TRANCHE DE MÉTHODE, et elle s'accroche sur le NOM, pas sur la signature.

   Les ancres littérales `growForestAsync(wave,standards){` se sont cassées le
   jour où la méthode a gagné un paramètre — et le test a échoué pour avoir eu
   raison de ce qui arrive au programme. Une ancre de test doit survivre aux
   changements de paramètres, donc elle s'arrête au nom.

   `async` fait partie de l'ancre parce que la ligne doit commencer par quatre
   espaces SUIVIS du mot-clé: sans cela, une ancre sur `growForestAsync(` ne
   matcherait jamais la ligne `async growForestAsync(`, et le test échouerait
   pour une raison qui n'a rien à voir avec ce qu'il vérifie. */
const method=(name,upTo)=>slice(
    NODE,
    `    ${name}(`,
    `    ${upTo}(`,
    `${name}…${upTo}`
)

const SETTINGS=["forestTolerance","forestDegreeMax","forestCharge"]

test("no method is DEFINED TWICE in the node",()=>{
    /* Une méthode écrite deux fois est un bug SILENCIEUX: la seconde écrase la
       première, le fichier compile, et le symptôme n'apparaît qu'à l'écran —
       ici, le stub de `renderForest` avait effacé tout le readout et ne
       manquait qu'un rapport muet. Aucun des autres tests ne l'aurait vu: ils
       lisaient du texte, et le texte du stub était là.

       On compte donc les définitions de niveau classe — quatre espaces, un nom,
       une parenthèse — et on refuse qu'un nom revienne. */
    const definitions=[...NODE.matchAll(/^ {4}(?:async )?([A-Za-z_$][\w$]*)\s*\(/gm)].map(m=>m[1])
    const seen=new Map()
    for(const name of definitions) seen.set(name,(seen.get(name)??0)+1)
    const twice=[...seen.entries()].filter(([,count])=>count>1).map(([name])=>name)
    assert.deepEqual(twice,[],
        `these methods are defined more than once, and the last one silently wins: ${twice.join(", ")}`)
})

test("the LINK list is its own, and is not the attribution plan",()=>{
    /* L'AUTONOMIE EST LE MOTIF DE LA DEMANDE: relier sur CH2 seul tout en
       attribuant avec CH2/NH/O/C. Elle se vérifie ici de deux façons — la liste
       existe comme paramètre, et le plan de LIAISON se construit SUR ELLE, pas
       sur `this.plan`.

       Si `buildForestPlan` reprenait `this.plan`, le code passerait tous les
       tests voisins et le réseau relierait avec les groupes de gauche: le bug
       serait « ça marche, et c'est faux ». */
    assert.match(NODE,/this\.parameters\.forestGroups=\[\{group:"CH2"\}\]/,
        "the link list must exist as its own parameter, defaulting to CH2 alone")
    const builder=method("buildForestPlan","async growForestAsync")
    /* AUCUN ADDUCT DANS LE PLAN DE LIAISON: un adduit porte une charge, pas un
       incrément de masse, donc le comparer à des écarts de m/z ne veut rien
       dire. */
    assert.match(builder,/ionising:\[\]/)
    assert.match(builder,/chargeAuto:false/)
    /* ET IL SE BATIT SUR LA LISTE DE LIAISON, pas sur le plan d'attribution. */
    assert.match(builder,/combining:groups/)
    assert.ok(!/combining:this\.groupList/.test(builder),
        "the link plan must not read the attribution group list")
})

test("the link list crosses every place a setting has to cross",()=>{
    const serialised=slice(NODE,"    serializeState(){","    restoreState(","serializeState")
    const restored=slice(NODE,"    restoreState(state){","    syncUI(){","restoreState")
    assert.ok(serialised.includes("forestGroups"),
        "forestGroups is not serialised: a session would lose the groups it linked on")
    assert.ok(restored.includes(`"forestGroups"`),
        "forestGroups is not in restoreState's list: a session would fall back to CH2")
})

test("the link list sits ABOVE the window and the degree cap",()=>{
    /* L'ORDRE EST L'ORDRE DES QUESTIONS: quoi relier, à quelle précision,
       combien de liens. C'est ce qui a été demandé, et c'est ce qui se lit. */
    const panel=slice(NODE,"    setupForestPanel(){","    commitForestNumber(","setupForestPanel")
    const list=panel.indexOf(`forestLinkTable(content,"Groups to link")`)
    const windowField=panel.indexOf("Link window (Da)")
    const degree=panel.indexOf("Max degree")
    assert.ok(list>=0,"the link list is missing from the panel")
    assert.ok(windowField>list,"the link list must come before the link window")
    assert.ok(degree>windowField,"the window and the degree cap stay side by side")
})

test("the link row has NO min, max or ratio",()=>{
    /* Trois colonnes qui n'ont aucun effet sur le calcul sont trois cases qui
       mentent sur le rôle de la ligne. Une borne « au moins deux occurrences »
       n'a pas de sens quand une référence sert à comparer des ÉCARTS. */
    const row=method("drawForestGroupRow","forestIsotopeBlocks")
    for(const dead of ["boundCell","\"min\"","\"max\"","\"ratio\""]){
        assert.ok(!row.includes(dead),
            `the link row still offers ${dead}: it would have no effect on the tree`)
    }
    /* Et elle garde ce qui, lui, informe: les blocs isotopiques du groupe. */
    assert.match(row,/forestIsotopeBlocks\(index\)/)
})

test("the curve is drawn in the app's own colours, by ROLE",()=>{
    /* LE DESSIN EST EXÉCUTÉ, PAS LU.

       Un test qui vérifierait `forestColors` ne prouverait rien: il dirait que la
       palette est écrite, pas que le tracé s'en sert. Alors on ÉVALUE
       `drawForestCurve` — la méthode est découpée du fichier et appelée sur un
       faux nœud dont le contexte 2D enregistre ce qu'on lui demande.

       C'est la technique de `collectionReader.test.mjs` appliquée au dessin:
       on prouve la couleur EMPLOYÉE, pas la couleur DÉCLARÉE. */
    const source=method("drawForestCurve","drawForestMarks")
    /* LES COULEURS VIENNENT DE LA PALETTE DU PROGRAMME, lue dans la feuille de
       style — pas recopiées ici: une constante dupliquée dans un test finit par
       diverger de celle qu'elle vérifie. */
    const accent=/--accent:\s*(#[0-9a-f]{6})/i.exec(MAIN_CSS)?.[1]
    const text=/--text:\s*(#[0-9a-f]{6})/i.exec(MAIN_CSS)?.[1]
    assert.ok(accent&&text,"the palette variables must be readable from main.css")
    assert.match(NODE,new RegExp(`curve:"${accent}"`),
        `the curve must use the app accent ${accent}`)
    assert.match(NODE,new RegExp(`suggestion:"${text}"`),
        `the suggestion circle must use the app text colour ${text}`)
    assert.match(NODE,/cut:"#78b4ff"/,
        "the cut line must use the blue the ionising lists already use")
    assert.match(NODE,/discarded:"#d9534f"/)

    /* ET LE DESSIN EST EXÉCUTÉ POUR DE VRAI. `window` est un paramètre de la
       FABRIQUE, pas de la méthode: celle-ci s'appelle avec le nœud en `this` et
       son premier argument — le rang qu'on fait glisser, absent ici. */
    const evaluate=(name,upTo)=>new Function("window",
        "return "+method(name,upTo).replace(/^(\s*)/,"$1function "))({devicePixelRatio:1})
    const calls=[]
    const context={
        lineWidth:1,font:"",textAlign:"",
        strokeStyle:"#000",fillStyle:"#000",
        setTransform(){},clearRect(){},fillRect(){},beginPath(){},moveTo(){},lineTo(){},
        arc(x,y,r){ calls.push({op:"arc",color:this.strokeStyle,x,y,r}) },
        stroke(){ calls.push({op:"stroke",color:this.strokeStyle}) },
        fillText(){}
    }
    const canvas={
        width:0,height:0,
        getContext:()=>context,
        getBoundingClientRect:()=>({left:0,top:0,width:300,height:150})
    }
    /* LE NŒUD MINIMAL. On n'en fournit rien de plus: toute dépendance
       supplémentaire serait un candidat à faire vibrer la méthode. */
    const node={
        forestCanvas:canvas,
        forestColors:{
            curve:accent,suggestion:text,cut:"#78b4ff",
            discarded:"#d9534f",wash:"rgba(217,83,79,0.10)"
        },
        forestWeights:Array.from({length:20},(_,i)=>0.01+i*0.001),
        forestSuggestion:{index:8,reason:"first step"},
        forestPlotLeft:0.10,forestPlotRight:0.01,
        forestCut:8,forestDrawCut:null,
        drawForestMarks(){ calls.push({op:"marks"}) }
    }
    evaluate("drawForestCurve","drawForestMarks").call(node,null)
    const stroked=calls.filter(call=>call.op==="stroke").map(call=>call.color)
    assert.ok(stroked.includes(accent),`the kept links must be drawn in ${accent}`)
    assert.ok(stroked.includes("#d9534f"),"the discarded links must be drawn in red")
    assert.ok(calls.some(call=>call.op==="marks"))

    /* ET LES MARQUES, qui sont le CONTRÔLE: le cercle sur la suggestion, le trait
       sur la coupure. Deux couleurs, deux rôles, et ils ne doivent jamais se
       confondre — c'est la seule chose que le panneau demande à voir. */
    const marks=evaluate("drawForestMarks","forestGroupList")
    marks.call(node,context,{
        xOf:rank=>10+rank*14, yOf:()=>80, width:300, height:150, left:30, usable:250
    })
    const arcs=calls.filter(call=>call.op==="arc")
    assert.equal(arcs.length,1,"exactly one circle: the suggestion")
    assert.equal(arcs[0].color,text,`the suggestion circle must be ${text}`)
    const blue=calls.filter(call=>call.op==="stroke"&&call.color==="#78b4ff")
    assert.equal(blue.length,1,"exactly one blue line: the applied cut")
})

test("the suggested cut is applied on its own, like Igor did",()=>{
    /* SANS ÇA, LE PREMIER RÉSEAU GARDE TOUT. Le noyau rend toute la courbe tant
       qu'aucune coupure n'est posée, donc un vrai spectre — où presque toute
       paire de pics tombe près d'une référence — donne un composant unique.
       C'est ce que faisait Igor: son critère statistique ARRÊTAIT la
       construction, et la marche expliquait l'arrêt au lieu de le provoquer. */
    const auto=method("async autoApplyForestCut","renderForestButton")
    /* ELLE NE S'APPLIQUE QU'UNE FOIS, sinon elle bouclerait: le second passage
       est marqué `keepCut`, et c'est cette garde qui l'en empêche. */
    assert.match(auto,/if\(keepCut\) return false/)
    assert.match(auto,/keepCut:true/)
    /* ET SEULEMENT SI LE DÉTECTEUR A TROUVÉ UNE VRAIE MARCHE: « aucune marche
       saillante » et « pas assez de liens » rendent le compte entier, donc la
       borne les écarte d'elle-même. Sans elle, une courbe plate serait coupée à
       un rang arbitraire. */
    assert.match(auto,/suggestion\.index>0&&\s*suggestion\.index<weights\.length/)
    /* ET ELLE SE DÉCLENCHE AVANT LA PUBLICATION, sinon l'écran montre un instant
       l'arbre non coupé. */
    const grown=method("async startForest","async autoApplyForestCut")
    const at=grown.indexOf("autoApplyForestCut")
    const publish=grown.indexOf("this.forests=forests")
    assert.ok(at>=0&&publish>=0)
    assert.ok(at<publish,"the automatic cut must happen BEFORE the results are published")
})

test("the legend says WHO cut, because the cut arrives by itself",()=>{
    /* LA COUPURE APPARAÎT TOUTE SEULE au premier calcul. Si la légende disait
       simplement « cut at the detected step », l'utilisateur lirait qu'il a
       choisi — et il vient de le voir apparaître. Un panneau qui affirme une
       décision que personne n'a prise est pire qu'un panneau muet. */
    const legend=method("renderForestCurveLine","forestForestOf")
    assert.match(legend,/forestCutAutomatic/,
        "the legend must distinguish an automatic cut from a manual one")
    /* ET LE DOUBLON NE COMPTE PAS COMME UN CHOIX: reprendre la suggestion d'un
       double-clic, c'est encore l'utilisateur qui agit. */
    assert.match(method("async setForestCut","applySuggestedCut"),
        /forestCutAutomatic=false/)
    assert.match(method("async autoApplyForestCut","renderForestButton"),
        /forestCutAutomatic=true/)
})

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
    assert.match(NODE,/growForestAsync\(wave,standards/)
    assert.match(NODE,/forestComponents\(forest,standards\)/)
    /* ET LE CALCUL VA DANS LE WORKER, pas sur le thread principal: c'est la
       raison d'être du noyau Rust. Une régression ici ne se verrait qu'à la
       fluidité, donc elle est affirmée par un test. */
    assert.match(NODE,/computePool\.run\("attributionForest"/)
})

test("the node falls back on the SAME calculation, and says so",()=>{
    const grown=method("async growForestAsync","async startForest")
    /* Un repli « approché » laisserait deux physiques dans le programme, et celle
       qui répondrait serait celle qu'on ne testerait pas. */
    assert.match(grown,/growForest\(payload\.params\)/)
    assert.match(grown,/console\.warn\("\[network\] kernel unavailable, JS fallback:"/)
    /* Et le repli ne se déclenche que sur un NOYAU INDISPONIBLE, jamais sur un
       résultat: un arbre vide est un résultat, pas une panne. */
    assert.match(grown,/if\(!forest\) throw new Error/)
})

test("the network never repaints the NODE status",()=>{
    /* Le statut du nœud raconte l'ATTRIBUTION. Le repeindre après un réseau
       donnerait un nœud vert au-dessus d'un readout d'attributions vide, alors
       que l'attribution n'a peut-être jamais été lancée. */
    const grown=method("async startForest","renderForestButton")
    assert.ok(!/setStatus\(/.test(grown),
        "startForest must not set the node status: that status belongs to the attribution")
    /* L'attente se lit sur le bouton, qui appartient au panneau qui travaille. */
    assert.match(grown,/this\.renderForestButton\(true\)/)
    assert.match(grown,/this\.renderForestButton\(false\)/)
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