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

const MODULAR_ATTRIBUTION=readFileSync(new URL("./nodes/AttributionNode.js",import.meta.url),"utf8")
const FOREST_METHODS=readFileSync(new URL("./nodes/AttributionForestMethods.js",import.meta.url),"utf8")
/* `interface.js` N'EXISTE PLUS: le refactor l'a éclaté en `nodes/AttributionNode.js`
   (le nœud, ses réglages, la sonde) et `nodes/AttributionForestMethods.js` (le
   réseau, mixin posé sur le nœud). Le test lisait l'ancien fichier et mourait sur
   un ENOENT AVANT la première assertion — donc AUCUNE des vérifications ci-dessous
   ne tournait, et personne ne le savait: un test qui ne démarre pas est
   indistinguable d'un test qui passe.

   On recompose le même TEXTE qu'avant, par concaténation, dans l'ordre où l'ancien
   fichier contenait les deux classes. Les ancres de tranche sont des indentations
   à quatre espaces, identiques dans les deux modules. */
const INTERFACE=MODULAR_ATTRIBUTION+FOREST_METHODS
const THERMO_RAW=readFileSync(new URL("./nodes/ThermoRawNode.js",import.meta.url),"utf8")
const PLOT_2D=readFileSync(new URL("./ui/Plot2D.js",import.meta.url),"utf8")
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

const NODE_START=INTERFACE.indexOf("class AttributionNode extends NodeWithAccordion{")
const NODE_END=INTERFACE.indexOf(
    "for(const name of Object.getOwnPropertyNames(AttributionForestMethods.prototype)){",
    NODE_START)
assert.ok(NODE_START>=0,"anchor not found: the attribution node class start")
assert.ok(NODE_END>NODE_START,"anchor not found: the attribution node mixin loop")
/* ET LA TRANCHE VA JUSQU'AU BOUT DU TEXTE, PAS JUSQU'À LA BOUCLE DE MIXIN.

   Avant le refactor, le réseau vivait DANS la classe du nœud: `startForest`,
   `forestRow`, `renderForest` étaient ses méthodes. Il vit maintenant dans
   `AttributionForestMethods`, un mixin posé juste APRÈS la boucle ci-dessus — donc
   s'arrêter à cette boucle exclurait précisément les méthodes que ce fichier
   vérifie, et chaque tranche serait vide. Un test qui passe sur une tranche vide
   est le piège que `slice` existe pour éviter; ici il fallait l'éviter du côté de
   la borne, pas du côté de l'assertion.

   `method()` ancre sur `    nom(` à quatre espaces, ce que les deux classes
   partagent — donc le découpage reste correct par-dessus la couture. */
const NODE=INTERFACE.slice(NODE_START)
void NODE_END

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
        /* ET ON IGNORE LES MOTS-CLÉS. `NODE` va maintenant jusqu'à la fin du texte,
           donc il contient AUSSI le code de niveau module qui suit les classes: la
           boucle de mixin, avec son `if(name==="constructor") continue`. `if` a
           quatre espaces d'indentation, donc il matche le motif autant qu'un nom de
           méthode, et le test rapportait `if` défini deux fois — une faute du TEST,
           pas du programme. Un `if` n'est pas une méthode: la liste est courte,
           close, et la nommer vaut mieux qu'un motif qui devine. */
    const KEYWORDS=new Set(["if","for","while","switch","catch","return","function","else","do"])
    const definitions=[...NODE.matchAll(/^ {4}(?:async )?([A-Za-z_$][\w$]*)\s*\(/gm)]
        .map(m=>m[1])
        .filter(name=>!KEYWORDS.has(name))
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
    /* LA GÉOMÉTRIE EST LEUR SOURCE COMMUNE, donc le nœud de test doit la
       fournir: `drawForestCurve` ne la recalcule plus tout seul — c'est
       précisément LE POINT du changement. Sans cette ligne la méthode lèverait
       `this.forestCurveGeometry is not a function`, ce qui serait un échec de
       harnais et non un défaut du programme. */
    node.forestCurveGeometry=evaluate("forestCurveGeometry","wireForestCursor")
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

/* LE CLIC EST SOUS LA SOURIS, ET ÇA SE MESURE.

   Ce test ne vérifie pas une couleur: il vérifie une INVARIANCE. Pour un point
   de la courbe, la position à laquelle le curseur serait DESSINÉ doit tomber
   sous ce point — c'est la définition même d'un curseur aligné.

   L'ERREUR QU'IL EMPÊCHE DE REVENIR. Dessiner et lire sont deux conversions
   inverses de la même chose, et elles ont été écrites chacune de leur côté:

     • le DESSIN posait la marge en pixels — `left = 0.10 * width`;
     • le CURSEUR mélangeait `box.width - forestPlotLeft`, où `forestPlotLeft`
       vaut 0.10 SANS UNITÉ. Le résultat ne mesurait rien, la somme se
       simplifiait en « à-peu-près toute la largeur », et la marge de gauche —
       le 10 % — n'était jamais soustraite.

   D'où le décalage OBSERVÉ: nul au bord droit, maximum au bord gauche, donc un
   décalage qui BOUGE avec la position. Un décalage constant se lirait comme un
   réglage; celui-ci se lit comme un bug — parce que c'en est un.

   La seconde cause, plus têtue: `getBoundingClientRect()` rend le BORDER box
   (bordure comprise) alors que le bitmap n'occupe que le CONTENT box. Un pixel
   d'écart à l'origine, deux de largeur — invisible à l'œil, mais c'est un
   pixel de trop, et il est à l'endroit exact où l'on mesure. */
test("the cursor lands under the mouse across the whole curve",()=>{
    const evaluate=(name,source)=>new Function("window",
        "return "+source.replace(/^(\s*)/,"$1function "))({devicePixelRatio:1})
    const listeners={}
    const canvas={
        width:0,height:0,
        /* LA ZONE DE FOND, ET PAS LE CADRE COMPLET: 300 de contenu, 302 de
           border box. C'est cet écart que la conversion doit connaître. */
        clientWidth:300,clientHeight:150,clientLeft:1,
        getContext:()=>({}),
        getBoundingClientRect:()=>({left:0,top:0,width:302,height:152}),
        addEventListener:(type,handler)=>{listeners[type]=handler},
        setPointerCapture(){}
    }
    const count=20
    let picked=null
    const node={
        forestCanvas:canvas,
        forestWeights:Array.from({length:count},(_,i)=>0.01+i*0.001),
        forestPlotLeft:0.10,forestPlotRight:0.01,
        /* ON NE PEINT PAS: ce qui nous intéresse est le RANG que le clic donne,
           pas la courbe qu'on en ferait. */
        drawForestCurve(rank){picked=rank}
    }
    node.forestCurveGeometry=evaluate("forestCurveGeometry",
        slice(NODE,"    forestCurveGeometry(){","    wireForestCursor(){","forestCurveGeometry"))
    /* L'ANRE EST `async setForestCut(` ET NON `setForestCut(`: l'helper
       `method()` construit ses ancres sans le mot-clé, et ne trouverait donc
       jamais la fin de `wireForestCursor`. On découpe à la main. */
    evaluate("wireForestCursor",
        slice(NODE,"    wireForestCursor(){","    async setForestCut(","wireForestCursor")).call(node)
    assert.ok(listeners.pointerdown,"the canvas must listen for presses")

    const geo=node.forestCurveGeometry()
    const xOf=rank=>geo.left+(count<2?geo.usable/2:(rank/(count-1))*geo.usable)
    const pitch=geo.usable/(count-1)
    /* UN DEMI PAS, ET PAS PLUS: `rankAt` ARRONDISIT au rang entier le plus
       proche, donc l'erreur maximale est la moitié de la distance entre deux
       rangs. Au-delà, ce n'est plus une imprécision de lecture. */
    const tolerance=pitch/2+0.5
    let checked=0
    for(let x=geo.left;x<=geo.left+geo.usable;x+=7){
        picked=null
        listeners.pointerdown({clientX:geo.x0+x,pointerId:1})
        assert.notEqual(picked,null,`no rank at x=${x}`)
        const drawn=xOf(picked)
        assert.ok(Math.abs(drawn-x)<=tolerance,
            `click at x=${x} lights the rank drawn at x=${drawn.toFixed(1)} `
            +`— ${Math.abs(drawn-x).toFixed(1)}px off (tolerance ${tolerance.toFixed(1)})`)
        checked++
    }
    assert.ok(checked>=30,`the sweep must cover the width, ${checked} probes is not enough`)

    /* LES BORDS DE LA MARGE: cliquer à GAUCHE de la courbe donne le premier
       rang, pas un rang négatif ni le deuxième. La marge appartient au
       graphique — elle n'est pas du vide qu'on peut viser. */
    picked=null
    listeners.pointerdown({clientX:geo.x0,pointerId:1})
    assert.equal(picked,0,"left of the plot reads the first rank")
    picked=null
    listeners.pointerdown({clientX:geo.x0+geo.width,pointerId:1})
    assert.equal(picked,count-1,"right of the plot reads the last rank")

    /* ET LA GÉOMÉTRIE EST BIEN CELLE DU DESSIN: ces deux nombres sont ceux que
       `drawForestCurve` emploie pour poser le trait. S'ils diffèrent, le test
       ci-dessus passerait en vérifiant une courbe que le programme ne peint pas. */
    assert.equal(geo.left,300*0.10,"the left margin is 10 % of the CONTENT box")
    assert.equal(geo.usable,300-30-3,"the drawn run spans width minus both margins")
    /* L'ORIGINE EST LE FOND ET PAS LA BORDURE: `clientLeft` vaut 1 ici, et
       l'oublier décalerait toute la lecture d'un pixel — le test de balayage
       ci-dessus resterait vert, car un pixel passe sous la tolérance. C'est
       donc cette ligne qui tient le correctif de la bordure. */
    assert.equal(geo.x0,1,"the reading origin is the padding edge, not the border")
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
    /* LA LECTURE, ET PAS LE RÉSEAU, ET C'EST LE COÛT.
       `forestPlan` n'a qu'un lecteur: la première ligne de la lecture. Tout le
       reste de `renderForest` — courbe, liste, graphe, récapitulatif — ne le
       lit pas. Le relancer coûtait pourtant 130 ms à 2,3 s de Fruchterman–
       Reingold à CHAQUE groupe ajouté, pour repeindre une ligne de texte: un
       défaut invisible dans le calcul, qui ne se voit qu'au chronomètre, donc
       il est affirmé ici et non constaté ailleurs. */
    assert.match(refresh,/this\.renderForestReadout\(\)/)
    assert.ok(!/this\.renderForest\(\)/.test(refresh),
        "refreshForestPlan repaints the whole network: the plan changes one line of the readout")
})

/* LE VRAI COÛT DU PANNEAU, ET IL EST MESURÉ ICI.

   180 itérations de Fruchterman–ReingOLD valent 130 ms sur cinquante groupes
   et 2,3 s sur mille — `layoutForests` est le poste de dépense du panneau, et
   de très loin: `buildForestPlan` coûte moins d'une milliseconde. Le rendu ne
   doit donc pas le relancer.

   Ce test ne lit pas le texte: il EXÉCUTE la méthode avec un `layoutForests`
   espion. Un test de texte dirait « la mémoïsation est écrite »; il ne dirait
   pas qu'elle ne se vide pas au premier redimensionnement, ni que deux appels
   rendent bien la MÊME valeur plutôt que deux valeurs égales. */
test("the force layout runs ONCE for one graph, not at every repaint",()=>{
    /* L'INDENTATION A CHANGÉ, ET C'EST LE REFACTOR: `forestOverviewLayout` était
       une méthode du nœud (`    nom({`), elle est maintenant une FONCTION LIBRE au
       niveau du module (`nom({`). L'ancre à quatre espaces ne trouvait donc plus
       rien, et la tranche était VIDE — un test qui passe sur du vide.

       L'ancre de fin change avec elle: la méthode suivante n'est plus la même. */
    const source=slice(NODE,
        "forestOverviewLayout({",
        "/* AVANCE L'ANIMATION D'UNE FRAME",
        "forestOverviewLayout")
    let runs=0
    /* LE FILTRE EST INJECTÉ, parce que `new Function` ne voit pas les imports:
       le corps de la méthode appelle `layoutForests` comme une variable, donc
       c'est une variable qu'on lui donne — et c'est elle qui compte. */
    /* ET LES DÉFAUTS DE LAYOUT SONT INJECTÉS AUSSI, et c'est le refactor qui
       l'exige: la méthode lit `FOREST_LAYOUT_DEFAULTS` pour bâtir sa clé de cache,
       or ce nom est un IMPORT de `forest.js` — et `new Function` ne voit aucun
       import. Le code échouait donc sur un `ReferenceError` AVANT la première
       assertion: le test ne mesurait rien du tout.

       Les valeurs sont LUES dans `forest.js`, pas recopiées: une constante
       dupliquée finit toujours par diverger de celle qu'elle vérifie, et le test
       continuerait de passer sur l'ancienne. */
    /* Le littéral est sur UNE ligne dans `forest.js`; le motif tolère les deux
       formes — une accolade fermée sur la ligne, ou un bloc multiligne — et
       échoue explicitement si aucune ne matche, plutôt que d'évaluer `undefined`. */
    const LAYOUT_SOURCE=FOREST.match(
        /export const FOREST_LAYOUT_DEFAULTS=(\{[^\n]*\})/
    )?.[1]
    if(!LAYOUT_SOURCE) throw new Error("FOREST_LAYOUT_DEFAULTS not found in forest.js")
    const FOREST_LAYOUT_DEFAULTS=eval(`(${LAYOUT_SOURCE})`)
    const build=new Function("window","layoutForests","FOREST_LAYOUT_DEFAULTS",
        "return "+source.replace(/^(\s*)/,"$1function "))(
        {devicePixelRatio:1},
        ()=>({stamp:++runs,groups:[]}),
        FOREST_LAYOUT_DEFAULTS)
    /* LES DEUX GRAPHES SONT TENUS EN VARIABLE, et c'est l'objet même qui fait
       la clé: `[...]` écrit deux fois crée deux tableaux, donc deux identités,
       donc un cache qui manque toujours — un test qui vérifierait le cache en
       le remplissant à chaque ligne ne vérifierait rien. */
    const node={
        forestSelected:new Set([0]),
        forestPlotBox:{clientWidth:600,clientHeight:300},
        forestPlotHeight:260,
        forestGraphs:[{graphs:[{rank:0}]}]
    }
    const call=()=>build.call(node)

    const first=call()
    assert.equal(runs,1,"the first call must lay the graph out")
    const second=call()
    assert.equal(runs,1,
        "the same graph in the same box laid out twice: every repaint pays the whole network again")
    assert.equal(second,first,
        "two calls must return the same layout object, not two equal ones")
    /* LA BOÎTE COMPTE, et c'est la seule autre clé: une grille calée sur une
       largeur qu'on ne mesurerait plus serait fausse à chaque redimensionnement. */
    node.forestPlotBox={clientWidth:800,clientHeight:300}
    call()
    assert.equal(runs,2,"a resized box must lay the graph out again")
    /* ET DES SOMMETS NEUFS COMPTENT: c'est un nouveau réseau, pas le même. */
    const fresh={graphs:[{rank:1}]}
    node.forestGraphs=[fresh]
    node.forestSelected=new Set([1])
    call()
    assert.equal(runs,3,"a new graph must lay the graph out again")
    /* PUIS LE MÊME, ENCORE: c'est le cas que le panneau rencontre à chaque
       ajout de groupe, et celui qui coûtait 130 ms à 2,3 s. */
    node.forestGraphs=[fresh]
    call()
    assert.equal(runs,3,"the very same graph and box must not be laid out again")
})

test("the readout has ONE writer, and the plan has ONE reader",()=>{
    /* Écrire la lecture à deux endroits, c'est deux endroits à rafraîchir — et
       l'un finit par être oublié. `renderForest` délègue, le plan n'est lu que
       dans la lecture, et c'est ce qui rend `refreshForestPlan` bon marché. */
    const readout=method("renderForestReadout","renderForest")
    assert.match(readout,/this\.forestPlan/,
        "the readout no longer reads the plan: its first line would go stale")
    assert.match(readout,/this\.forestReadout\.textContent=/,
        "the readout must paint its own element")
    const render=method("renderForest","renderForestCurveLine")
    assert.match(render,/this\.renderForestReadout\(\)/,
        "renderForest must delegate the readout instead of writing it again")
    assert.ok(!/this\.forestPlan/.test(render),
        "renderForest reads the plan directly: the readout would have two writers")
})

test("the module is served: an import nothing serves is a 404 at the click",()=>{
    assert.match(SERVER,/"\/scripts\/forest\.js":"scripts\/forest\.js"/)
    /* Et il est importé par les TROIS consommateurs, dont le worker — c'est le
       seul moyen que le repli y soit disponible sans chimie. */
    /* LE CHEMIN A CHANGÉ AVEC LE REFACTOR: `AttributionNode` et
       `AttributionForestMethods` vivent désormais dans `scripts/nodes/`, donc ils
       importent `../forest.js`. Le worker et le pool restent dans `scripts/` et
       gardent `./forest.js`. Le test exigeait `./` pour les quatre — dont deux qui
       ne l'ont jamais écrit — donc il échouait sur du bon code. */
    assert.match(MODULAR_ATTRIBUTION,/from "\.\.\/forest\.js"/)
    assert.match(FOREST_METHODS,/from "\.\.\/forest\.js"/)
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

test("the extracted node modules keep their dependencies and mixin state",()=>{
    assert.match(THERMO_RAW,/import\("\.\.\/workerPool\.js"\)/,
        "ThermoRawNode must resolve workerPool from the scripts directory")
    assert.doesNotMatch(THERMO_RAW,/import\("\.\/workerPool\.js"\)/,
        "a relative import from nodes/workerPool.js points at a nonexistent file")
    assert.match(PLOT_2D,/import \{XYTrace\} from "\.\.\/formats\.js"/,
        "Plot2D.setTraces uses XYTrace and must import its runtime class")
    assert.match(MODULAR_ATTRIBUTION,/this\.forestColors=\{/,
        "the forest renderer needs its instance palette on AttributionNode")
    assert.match(MODULAR_ATTRIBUTION,/this\.forestPlotLeft=0\.10/)
    assert.match(MODULAR_ATTRIBUTION,/this\.forestPlotRight=0\.01/)
    assert.match(MODULAR_ATTRIBUTION,/Object\.getOwnPropertyNames\(AttributionForestMethods\)/,
        "static forest constants must be transferred along with prototype methods")
    assert.match(FOREST_METHODS,/static FOREST_COLOR_STEPS=8/)
})

test("the merge button fuses the drawn trees, biggest first",()=>{
    /* Le bouton vit dans le panneau, la fusion dans deux méthodes pures du
       mixin, et le graphe mergé se substitue à ses sources. Un bouton sans
       méthode serait un décor, une méthode sans bouton du code mort. */
    assert.match(FOREST_METHODS,/this\.forestMergeBtn=CE\("button"/,
        "the selection row must carry a Merge button")
    assert.match(FOREST_METHODS,/mergeSelectedForests\(\)/,
        "clicking Merge must fuse the drawn trees")
    assert.match(FOREST_METHODS,/forestMergedGraphs\(/,
        "the fused graph must stand in for its sources")
    assert.match(FOREST_METHODS,/forestCompositionDiff\(/,
        "each bridge is the stoichiometric difference of two roots")
    assert.match(FOREST_METHODS,/forestMergeGraphs\(/,
        "fused graphs keep every vertex and link, plus the bridge")
    assert.match(FOREST_METHODS,/forestMerges\?\.clear\(\)/,
        "a fresh Grow network regenerates the raw state: merges do not survive it")
    assert.match(FOREST,/export function forestCompositionDiff\(/,
        "the root diff is pure: no DOM, no kernel, testable alone")
    assert.match(FOREST,/export function forestMergeGraphs\(/,
        "the fusion is pure: no DOM, no kernel, testable alone")
})