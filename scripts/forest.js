import {positiveMassConjugate} from "./chemistry.js"

/* =========================================================================
   forest.js — le RÉSEAU de mesures, hors du DOM.

   Ce que fait ce fichier, en une phrase: étant donné une liste de points
   mesurés (les X d'un spectre) et une liste de MASSES DE RÉFÉRENCE, il relie
   deux points dont l'écart de m/z tombe sur une référence, puis construit
   l'arbre couvrant de poids minimal de ce graphe — le poids d'un lien étant
   l'erreur sur cet écart.

   L'ORACLE est `GRAPHTTRIBUTOR` dans resources/ProcAttributorLegacy/MainProc.ipf:
   `GrowForest` appelle `calcBestof` (les liens) puis `kruskal4mass` (l'arbre),
   et `CompteTribue` en tire la liste des composantes. Les trois temps — PLAN,
   GROS CALCUL, LECTURE — sont ceux du nœud d'attribution, et c'est
   délibérément le même découpage.

   CE QUI EST ICI ET CE QUI EST DANS LE NOYAU.

   La Physique — la liste de références et ce qu'on affiche — reste en JS, où
   elle vit déjà. Le GROS calcul est dans forest.rs, appelé par le worker. Le
   `growForest` ci-dessous est le MÊME calcul en JS: il sert de repli quand le
   wasm est absent ou périmé, et il est l'oracle du test de parité
   (`forestParity.test.mjs`). Il n'est jamais utilisé quand le noyau répond.

   Il ne dépend de RIEN — pas de table périodique, pas de nodos — parce qu'il
   est chargé dans chaque worker. C'est la raison pour laquelle les références
   lui arrivent en nombres et non en formules.
   ========================================================================= */

/* LA FENÊTRE DE LIEN, en unités de masse.

   C'est le 0.5 qu'Igor avait écrit en dur dans `calcBestof`
   (`if(wavemin(Candidates)<0.5)`), et il est devenu un PARAMÈTRE pour deux
   raisons: 0.5 Da sur un lien est une géométrie et pas une physique — c'est
   « près », pas « juste » — et une constante cachée dans une comparaison ne se
   règle pas. La même raison a fait passer le plafond de degré de `inf` (mode
   `GrowForest`) à un réglage : Igor's `GrowReticles` le mettait à 2, donc la
   valeur existe déjà dans l'oracle. */
export const DEFAULT_LINK_TOLERANCE=0.5

export const FOREST_LAYOUT_DEFAULTS={iterations:1e9,ideal:26,repulsion:1,restBase:0.9,restSpan:0.1,gravity:0,tempStart:1000,tempEnd:0,fac:20,viscosity:1,springExponent:3,massForce:0,defectForce:0,errorForce:0,depthForce:0}
/* LE BUDGET DU MODE STATIQUE, et il est en TOURS DE PHYSIQUE, pas en
   millisecondes.

   Il s'applique à `layoutGroup` SEULEMENT. Le mode animé garde `iterations` à
   10⁹ sans coût: là, atteindre le plafond ne fait que relancer la boucle — le
   graphe « respire » tant qu'il est affiché, c'est voulu. Seul le mode statique
   bloque le thread, et c'est lui qui avait besoin d'une borne.

   POURQUOI PAS EN MILLISECONDES. Un plafond de temps rend le RENDU
   NON DÉTERMINISTE, et c'est le défaut le plus grave possible ici: deux rendus
   du même réseau s'arrêtaient à des tours voisins — celui où la machine a eu
   fini son tour — donc le même groupe s'affichait différemment d'un clic à
   l'autre, et l'utilisateur n'avait plus rien à comparer. C'est exactement ce
   que vérifie le test « the layout is DETERMINISTIC », et il échouait sur
   cette raison-là, pas sur une variation de la physique.

   Le budget est donc une QUANTITÉ DE TRAVAIL, non une durée: `WORK` unités
   « sommet + lien », divisées entre les tours. Un groupe de vingt-quatre pics
   en fait 48 par tour et dispose donc de tout le budget; un groupe de mille
   pics en fait 2 000 et en reçoit dix fois moins. Le temps d'attente est
   approximativement le même pour tous les groupes — le but initial du budget —
   mais il est maintenant le MÊME pour deux rendus du même groupe.

   Les deux bornes BORNE le résultat : `MAX_ROUNDS` est au-dessus du nombre de
   tours que demande la convergence (1 114), donc un petit groupe se détend
   complètement au lieu d'être arrêté au milieu; `MIN_ROUNDS` garantit qu'un
   groupe énorme reçoit tout de même quelques dizaines de tours, sans quoi il
   ne serait pas dessiné du tout.

   `FOREST_LAYOUT_BUDGET_MS` reste, mais uniquement comme filet de sécurité pour
   le cas où plusieurs groupes se cumulent. Il est VOLONTAIREMENT LARGE: à
   150 ms il mordait dès mille sommets, c'est-à-dire dans le cas ordinaire — et
   il réintroduisait alors exactement le défaut qu'on venait de supprimer, deux
   rendus du même groupe différaient encore. Un budget de travail de 800 000
   unités coûte au pire quelques centaines de millisecondes par groupe, donc un
   plafond à 1 500 ms ne peut mordre que si plusieurs groupes se cumulent, et
   laisse le temps de finir proprement avant. */
const FOREST_LAYOUT_WORK=800000
const FOREST_LAYOUT_MAX_ROUNDS=1200
const FOREST_LAYOUT_MIN_ROUNDS=60
const FOREST_LAYOUT_BUDGET_MS=1500
/* LE NOMBRE DE TOURS, pour un groupe — et il ne dépend que du GROUPE. */
/* NOTE: ce plafond n'appartient qu'au MODE STATIQUE (`layoutGroup`): le
   mode animé plafonne sur `iterations` (voir `forest-worker.js`). */
function layoutRoundsFor(count,links){
    const weight=count+(links??0)
    if(!(weight>0)) return FOREST_LAYOUT_MIN_ROUNDS
    return Math.max(FOREST_LAYOUT_MIN_ROUNDS,
        Math.min(FOREST_LAYOUT_MAX_ROUNDS,Math.round(FOREST_LAYOUT_WORK/weight)))
}
/* LA VISCOSITÉ, et la TEMPÉRATURE qui bornait le pas sans jamais décroître.

   `tempEnd` valait 0.5 et n'était de toute façon JAMAIS transmis à `frStep`:
   le pas était plafonné par la seule saturation `atan`, constante d'un tour à
   l'autre. Il ne restait donc aucune perte d'énergie, `maxSpeed` ne descendait
   jamais sous 1e-7, et la boucle ne s'arrêtait que par son plafond de 10⁹. C'est
   ce qui gelait le mode statique, et ce qui faisait que `forest.test.mjs` ne
   finissait jamais.

   On rétablit ce que le commentaire annonçait déjà (« c'est la température qui
   plafonne le pas »), mais une température qui DESCEND: elle part de
   `tempStart` et tend vers `tempEnd`, par demi-vie. La demi-vie et non la
   fraction `round/iterations` est délibéré — `iterations` vaut 10⁹, donc une
   décroissance proportionnelle au plafond ne produirait aucun refroidissement
   observable avant l'épuisement du temps.

`tempEnd` passe de 0.5 à 0 : tant qu'elle reposait sur un plancher non nul,
    `maxSpeed` avait ce plancher pour plancher et ne pouvait donc plus franchir
    le seuil d'arrêt. Le graphe ne s'immobilise jamais tout à fait — il se
    stabilise, ce qui est le comportement voulu d'un FR. */
const FOREST_TEMPERATURE_HALF_LIFE=60
/* LE PLANCHER DE PROFONDEUR: la part de la force que reçoit le plus petit
   niveau d'un arbre, la racine étant la seule à n'en recevoir aucune. C'est ce
   qui tient la racine en bas — voir `depthBiasOf`. */
const FOREST_DEPTH_FLOOR=0.25
export const FOREST_VISCOSITY=FOREST_LAYOUT_DEFAULTS.viscosity
/* LE CRITÈRE DE CONVERGENCE, et il est RELATIF à `k`.

   On déclare l'arrêt quand le déplacement du sommet le plus rapide est inférieur
   à `k`/10 000. La même valeur vaut donc pour un groupe de deux pics et pour
   une chaîne de trois mille — ce qu'un seuil ABSOLU ne peut pas faire, puisque
   la longueur d'un graphe varie de deux ordres de grandeur alors que les
   positions restent comparables.

   Le seuil est atteint par la décroissance de la température, donc en un
   nombre de tours FIXE, indépendant de la machine et de la taille: c'est ce qui
   rend deux rendus du même réseau strictement identiques. Le budget de temps
   reste une sécurité pour les groupes giants, où il peut encore trancher —
   mais il n'est plus l'arrêt normal. */
export const FOREST_SETTLE_RATIO=1e-4

/* LE PRNG, À GRAINE. `Math.random()` rendrait le même réseau différent à chaque
   rendu, et le test « the layout is DETERMINISTIC » existe précisément pour que
   deux réseaux restent comparables. Mulberry32: quelques lignes, sans état
   global, et la même graine redonne la même suite — donc le même placement
   initial, donc le même résultat. */
function layoutRandom(seed){
    let state=seed>>>0
    return()=>{
        state=(state+0x6D2B79F5)>>>0
        let t=state
        t=Math.imul(t^(t>>>15),t|1)
        t^=t+Math.imul(t^(t>>>7),t|61)
        return((t^(t>>>14))>>>0)/4294967296
    }
}
/* LA GRAINE VIENT DU GRAPHE, pour que deux arbres différents ne partent pas du
   même nuage, tout en restant reproductibles d'un rendu à l'autre. */
function layoutSeed(graph,count){
    let h=0x9E3779B9^count
    h=Math.imul(h^(graph.rootIndex+1),0x85EBCA6B)
    const first=graph.vertices?.[0]?.index??0
    h=Math.imul(h^(first+1),0xC2B2AE35)
    return(h^(graph.vertices?.length??0))>>>0
}
/* LE DÉCALAGE DE MASSE, normalisé dans [-0.5, +0.5].

   On normalise par l'ÉTENDUE et non par la masse brute: les masses sont en
   Da autour de 100–900, et un écart de 800 unités de masse écraserait tout le
   reste de la physique. Après normalisation, `massBias[i] > 0` veut dire « plus
   lourd que le milieu du groupe », quelle que soit l'unité. Un seul sommet
   aberrant tire donc le milieu, mais pas l'échelle. */
export function massBiasOf(vertices){
    const n=vertices?.length??0
    const bias=new Float64Array(n)
    if(!n) return bias
    let min=Infinity
    let max=-Infinity
    for(const vertex of vertices){
        const mass=Number(vertex?.mass)
        if(!Number.isFinite(mass)) continue
        if(mass<min) min=mass
        if(mass>max) max=mass
    }
    const span=max-min
    for(let i=0;i<n;i++){
        const mass=Number(vertices[i]?.mass)
        bias[i]=span>0?(mass-min)/span-0.5:0
    }
    return bias
}
/* LE DÉFAUT DE MASSE, et c'est `round`, PAS le `massDefect` du fichier.

   `massDefect` vaut `mass - Math.floor(mass)`, donc sa plage est [0, 1): elle
   est ASYMÉTRIQUE, et s'en servir ici pousserait tous les sommets vers le haut,
   sans jamais rien pousser vers le bas.

   Ici on prend `mass - Math.round(mass)`, dont la plage est [-0.5, +0.5] —
   centrée sur zéro, donc un sommet de masse entière reste au milieu et les
   autres s'étagent également vers le haut et vers le bas. C'est ce qui donne au
   réseau l'allure d'un diagramme de défaut de masse, où la deflection d'un pic
   se lit directement en ordonnée.

   Le sommet porte déjà un champ `defect`, mais c'est celui du `floor`: les deux
   coexistent donc, et ils ne mesurent pas la même chose. */
/* L'ERREUR PAR SOMMET, NORMALISÉE SUR LE GROUPE — et c'est la normalization
   qui fait toute la différence.

   Un sommet ne porte pas d'erreur: les liens en portent une (`weight`, l'écart
   en Da à la masse de référence). On attribue donc à chaque sommet l'erreur de
   son MEILLEUR lien — un sommet dont tous les liens sont précis est bien ancré,
   et il ne doit pas hériter de l'erreur d'un maillon médiocre qui le touche.

   Puis on NORMALISE sur l'étendue du groupe, en [-0.5, +0.5]. C'est la leçon de
   `massForce`, qui atteint une corrélation de 0.94 : normalisé, l'axe vertical
   s'étale sur toute la hauteur quelle que soit l'unité. Non normalisé, l'erreur
   d'un réseau tient dans quelques millièmes de Da et se ferait écraser par les
   ressorts — exactement ce qui arrive à `defectForce`, dont la plage réelle dans
   un groupe est bien plus étroite que les [-0.5, +0.5] théoriques.

   SIGNE: une erreur GRANDE tire vers le BAS, donc vers un ordonnée négative.
   C'est la convention « les pics bien identifiés en haut, les doubtous en bas ».
   Inverser le signe se fait en changeant `bias=-…` en `bias=…`. */
/* LA DISTANCE À LA RACINE, EN NOMBRE DE SAUTS — jamais la distance
   euclidienne.

   La distance euclidienne bouge pendant que la mise en page se fait: une force
   qui en dépendrait changerait de valeur à chaque tour, puisque c'est
   exactement ce qu'elle déplace. Elle n'aurait donc aucune valeur stable, et le
   résultat dépendrait de l'ordre des tours. Le nombre de sauts, lui, est une
   propriété du graphe: il ne bouge jamais.

   On mesure donc la profondeur dans l'arbre (parcours en largeur depuis la
   racine), puis on normalise sur la profondeur maximale du groupe, pour la
   même raison que `massForce` et `errorForce` — une profondeur en sauts n'a
   pas d'unité naturelle, et non normalisée elle resterait collée à 0 ou 1.

   La valeur est POSITIVE: elle vaut 0 à la racine et ~1 au sommet le plus
   profond. La force pousse donc vers le DEHORS, radialement. */
export function depthBiasOf(vertices,links,rootIndex){
    const n=vertices?.length??0
    const bias=new Float64Array(n)
    if(!n) return bias
    const at=new Map()
    for(let i=0;i<n;i++) at.set(vertices[i].index,i)
    const root=at.get(rootIndex)
    const hops=new Int32Array(n).fill(-1)
    if(root===undefined) return bias
    hops[root]=0
    /* DES LISTES D'ADJACENCE, ET NON UN BALAYAGE DE TOUS LES LIENS.

       Le parcours en largeur konsommait, à chaque sommet qu'il déqueue, la
       liste ENTIÈRE des liens du groupe pour y chercher ses voisins. Sur un
       arbre de n sommets portant n-1 liens, c'est n×(n-1) tests — donc
       quadratique, et c'était le second poste du profilage de mise en page
       juste après `errorBiasOf`. Les listes d'adjacence coûtent une passe sur
       les liens, et le parcours redevient linéaire. */
    const adjacency=Array.from({length:n},()=>[])
    for(const link of links??[]){
        const a=at.get(link.u)
        const b=at.get(link.v)
        if(a===undefined||b===undefined) continue
        adjacency[a].push(b)
        adjacency[b].push(a)
    }
    const queue=new Int32Array(n)
    let tail=1
    queue[0]=root
    for(let head=0;head<tail;head++){
        const current=queue[head]
        for(const next of adjacency[current]){
            if(hops[next]!==-1) continue
            hops[next]=hops[current]+1
            queue[tail++]=next
        }
    }
    let deepest=0
    for(let i=0;i<n;i++) if(hops[i]>deepest) deepest=hops[i]
    if(!(deepest>0)) return bias
    for(let i=0;i<n;i++){
        //sommet non atteignable : aucun lien ne le rattache à la racine
        bias[i]=hops[i]<0?0:hops[i]/deepest
    }
    /* LE PLANCHER, et c'est lui qui tient la racine EN BAS.

       Sans lui, un sommet à une profondeur 1 sur 37 reçoit un poids de 0,027 —
       rien. La force est donc quasi nulle autour de la racine et maximale aux
       feuilles, alors qu'on veut l'inverse: TOUT ce qui est sous la racine doit
       s'en détacher. Les ressorts, eux, ramènent chaque voisin à la racine avec
       une longueur au repos de l'ordre de `ideal`, donc ils annulaient cette
       première version: le nuage encadrait l'origine et la racine paraissait
       au centre du dessin.

       Le plancher donne à tout sommet non-racine au moins une fraction de la
       force, et la hauteur devient proportionnelle à la profondeur: un arbre
       long reste dressé au lieu de se replier sur lui-même.

       La racine garde zéro — elle doit rester posée, et c'est de toute façon
       `frStep` qui l'épingle en (0,0) à chaque tour. */
    for(let i=0;i<n;i++){
        if(bias[i]<=0) continue
        bias[i]=FOREST_DEPTH_FLOOR+(1-FOREST_DEPTH_FLOOR)*bias[i]
    }
    return bias
}
export function errorBiasOf(vertices,links){
    const n=vertices?.length??0
    const bias=new Float64Array(n)
    if(!n) return bias
    const best=new Float64Array(n).fill(Infinity)
    /* LA TABLE sommet→rang est bâtie UNE FOIS, hors de la boucle des liens.

       Elle l'était à l'intérieur: une `Map` complète était reconstruite pour
       chaque lien, donc E fois — soit n×E paires construites puis abandonnées,
       le seul poste de coût du calcul d'erreur sur un vrai arbre, où le
       nombre de liens est du même ordre que le nombre de pics. C'était aussi
       la première chose que signalait un profilage de mise en page. */
    const at=new Map()
    for(let i=0;i<n;i++) at.set(vertices[i].index,i)
    for(const link of links??[]){
        const weight=Number(link?.weight)
        if(!Number.isFinite(weight)) continue
        for(const end of [link.u,link.v]){
            const index=at.get(end)
            if(index===undefined) continue
            if(weight<best[index]) best[index]=weight
        }
    }
    let min=Infinity
    let max=-Infinity
    for(let i=0;i<n;i++){
        if(!Number.isFinite(best[i])) continue
        if(best[i]<min) min=best[i]
        if(best[i]>max) max=best[i]
    }
    const span=max-min
    for(let i=0;i<n;i++){
        //sommet isolé : ni lien, donc ni erreur. On le met au milieu plutôt que
        //de le coller à un bord qui n'est pas le sien
        if(!Number.isFinite(best[i])||!(span>0)){ bias[i]=0; continue }
        bias[i]=-((best[i]-min)/span-0.5)
    }
    return bias
}
export function defectBiasOf(vertices){
    const n=vertices?.length??0
    const bias=new Float64Array(n)
    for(let i=0;i<n;i++){
        const mass=Number(vertices[i]?.mass)
        bias[i]=Number.isFinite(mass)?mass-Math.round(mass):0
    }
    return bias
}
export function layoutTemperature(round,from,to){
    if(!Number.isFinite(from)) return to
    if(round<=0) return from
    return to+(from-to)*Math.pow(0.5,round/FOREST_TEMPERATURE_HALF_LIFE)
}

/* LES RÉFÉRENCES, et d'où elles viennent.

   C'est le PREMIER temps d'Igor: `formatStds` assemblait la liste des masses
   théoriques des formules cochées dans un molbag. Ici la source naturelle est
   le PLAN du nœud d'attribution — les briques des groupes à combiner — parce
   que c'est déjà la liste des masses que l'utilisateur a écrite, et qu'elle
   existe sans qu'aucune formule n'ait été attribuée.

   CE QUI N'EST PAS DANS LA LISTE, ET POURQUOI: les adductions. Un adduit porte
   une charge, pas un incrément de masse que deux pics du même spectre
   pourraient présenter comme différence. Le comparer aux écarts de m/z
  ferait des liens sans signification, donc il est laissé de côté — et dit.

   LA CHARGE. Igor comparait des masses à des écarts de m/z, ce qui n'est juste
   que pour des ions 1+. Ici c'est explicite: les références sont divisées par
   |z|, et `charge` est un paramètre. À z=1 on retrouve exactement l'oracle. */
export function forestStandards(plan,{charge=1}={}){
    const diagnostics=[]
    if(!plan?.items?.length){
        diagnostics.push("no plan yet: the reference list is built from the combining groups")
        return {masses:[],labels:[],charge,diagnostics}
    }
    const z=Math.abs(Number(charge))
    const divisor=Number.isFinite(z)&&z>0?z:1
    const bricks=plan.items.filter(item=>item.kind==="combining"&&linkableBrick(item))
    if(!bricks.length){
        diagnostics.push("no combining group produced a mass, so no pair of peaks can be linked")
    }
    if(plan.items.some(item=>item.kind==="ionising")){
        diagnostics.push("adducts are not used as references: they carry a charge, not a mass increment")
    }
    if(plan.items.some(item=>item.kind==="combining"&&item.atomicMass<0)){
        diagnostics.push("negative-mass references were excluded; text formulas are conjugated when parsed")
    }
    /* L'ORDRE EST celui du plan, et il est celui que le noyau rend dans
       `edge_standard`: le noyau trie ses références en interne mais rend
       l'indice de CELLE-LÀ, donc l'appeler dans un autre ordre donnerait un
       libellé faux sur le lien. Trier ici rendrait le tri visible et gratuit,
       mais le libellé deviendrait « la brique la plus légère » au lieu de
       « celle que l'utilisateur a écrite ». */
    const masses=bricks.map(item=>item.atomicMass/divisor)
    const labels=bricks.map(item=>item.notation??item.groupNotation??item.key)
    /* LES COMPOSITIONS, DANS LE MÊME ORDRE. `propagateForest` indexe ses
       références comme `link.standard`: l'entrée i est la composition de la
       brique i. Rendre un tableau séparé dans un autre ordre donnerait des
       formules propagées fausses avec l'air de mesures — donc le même
       `bricks`, le même ordre, et la Map partagée du plan (jamais mutée:
       `mergeComposition` lit sa source sans l'écrire). */
    const compositions=bricks.map(item=>item.composition??null)
    return {masses,labels,compositions,charge:divisor,diagnostics}
}
/* UNE BRIQUE EST-ELLE UTILISABLE COMME RÉFÉRENCE?

    Une brique lisible et de masse strictement POSITIVE. Le crible ne visite que
    les écarts croissants; les entrées de masse négative sont donc conjuguées à
    la frontière de lecture (`Formula.parse`) avant d'arriver ici.

   CETTE FONCTION EST LE FILTRE UNIQUE, et les trois endroits qui indexent les
   références DOIVENT l'appeler: `forestStandards` (les masses envoyées au
   noyau), `forestLinkBricks` (la liste des choix) et `attributeTree` (les
   compositions lues par la propagation). Un filtre différent à l'un des trois
   fait porter, par un même `link.standard`, une brique différente selon le
   lecteur — le défaut que la recherche d'une brique par magnitudes introduisait
   déjà une fois. */
export function linkableBrick(item){
    return item?.kind==="combining"
        &&Number.isFinite(item.atomicMass)
    &&item.atomicMass>0
}

/* LA RÉFÉRENCE LA PLUS PROCHE, dans une liste de {mass,index} TRIÉE par masse.

   La liste triée est construite ici plutôt que par l'appelant: c'est un tri
   sur quelques dizaines d'éléments, il ne coûte rien, et le noyau fait pareil
   pour la même raison. */
function nearestReference(sorted,gap){
    let low=0
    let high=sorted.length
    while(low<high){
        const mid=(low+high)>>1
        if(sorted[mid].mass<gap) low=mid+1
        else high=mid
    }
    /* Les deux voisins du point d'insertion, et le PREMIER reste en cas
       d'égalité — même arbitrage que le noyau, et le même motif: deux
       références à la même distance sont indiscernables, donc le choix doit
       être DÉTERMINISTE ou le même spectre donnerait deux libellés différents
       d'une exécution à l'autre. */
    let best=null
    for(const candidate of [low>0?sorted[low-1]:null,low<sorted.length?sorted[low]:null]){
        if(!candidate) continue
        const error=Math.abs(candidate.mass-gap)
        if(best===null||error<best.error) best={index:candidate.index,error}
    }
    return best
}

/* L'ARBRE, en JS — le même calcul que forest.rs, dans le même ordre.

   Pas une approximation : c'est l'ORACLE du test de parité, et le repli quand
   le wasm manque. Trois règles gouvernent le résultat, et chacune a son
   équivalent exact côté Rust :

     1. les points doivent être TRIÉS par masse — c'est ce qui autorise l'arrêt
        précoce de la boucle des paires;
     2. le poids est l'erreur en Da, et le lien est gardé si elle est
        STRICTEMENT inférieure à la fenêtre;
     3. Kruskal accepte par poids croissant, puis par (u, v) croissant, ce qui
        rend l'arbre indépendant du tri interne. */
export function growForest({masses,intensities,standards,tolerance=DEFAULT_LINK_TOLERANCE,degreeMax=0,limit=0}={}){
    const empty=()=>({
        edgeU:[],edgeV:[],edgeWeight:[],edgeStandard:[],degree:[],
        componentOf:[],componentRoot:[],componentSize:[],
        componentMaxIntensity:[],componentWeight:[],
        componentRootMass:[],componentPeakMass:[],
        weights:[],candidates:0,cutUsed:0,isolated:0,edgeCount:0,componentCount:0
    })
    const n=masses?.length??0
    /* LES REFUS, ET ILS SONT LES MÊMES QUE CEUX DU NOYAU.

       Une tolérance nulle relierait tous les points dont l'écart vaut
       exactement une référence — et une négative, tous les points. Rendre
       vide est la seule réponse qui ne mente pas. */
    if(n===0||(intensities?.length??0)!==n) return empty()
    if(!Number.isFinite(tolerance)||tolerance<=0) return empty()
    const references=[]
    for(let i=0;i<(standards?.length??0);i++){
        const mass=standards[i]
        if(Number.isFinite(mass)&&mass>0) references.push({mass,index:i})
    }
    if(!references.length) return empty()
    references.sort((a,b)=>a.mass-b.mass)
    /* LA FENÊTRE EST ENCORE CELLE DE LA TOLÉRANCE, MAIS INDEXÉE PAR RÉFÉRENCE.

       L'ancien code parcourait tous les `j` et s'arrêtait sur
       `gap <= max(références) + tolérance`. Ce seuil ne donnait AUCUN gain
       asymptotique: dès qu'une référence est grosse — un lipide C80 à 900 Da —
       il couvre la moitié de l'axe des masses, donc la boucle interne visitait
       presque tous les pics suivants, pour CHAQUE pic. En O(n²) sur 10⁵ pics,
       avec un `nearestReference` et une allocation par paire.

       On inverse donc le sens de la marche: ce sont les RÉFÉRENCES qui pilotent,
       et elles sont peu nombreuses. Pour chaque pic `k` et chaque référence `R`,
       les seuls `j` possibles sont ceux dont l'écart tombe dans la fenêtre
       autour de `R` — un intervalle CONTIGU sur `masses`, trouvé par recherche
       dichotomique. On ne visite donc que les pics réellement candidats.

       MÊME RÉSULTAT, POUR UNE RAISON PRÉCISE: un écart garde son lien s'il est à
       moins de `tolerance` d'une référence AU PLUS, donc s'il tombe dans la
       fenêtre de CETTE référence. Toute fenêtre visitée contient donc tous les
       candidats, et le test `error < tolerance` — inchangé, et calculé dans le
       même ordre qu'avant — rejette tout le reste. L'ancien seuil `reach`
       n'était jamais un filtre: il ne bornait que la boucle, et aucune fenêtre
       illevée ne pouvait s'y trouver, puisque `R + tolerance <= reach` toujours. */
    const candidates=[]
    /* LE DOUBLON, et il faut le prévoir: deux références proches de moins de
       deux fois la tolérance donnent des fenêtres QUI SE CHEVAUCHENT, et le même
       `j` serait alors vu deux fois. Or un couple (k, j) ne doit donner qu'un
       candidat, celui de la référence la plus proche — le doublon le ferait
       compter deux fois dans `candidates`, donc dans la courbe et dans la
       coupure. Un tampon de marque suffit: il dit « ce `j` a déjà été servi
       pour ce `k` », et il est réutilisé d'un `k` à l'autre par un compteur
       qui change, donc jamais besoin de le remettre à zéro. */
    const served=new Int32Array(n)
    let generation=0
    //premier `j` dont l'écart vaut au moins `x`. La comparaison se fait sur
    //`masses[mid]-low` et NON sur `masses[mid] >= low+x`: les deux écritures ne
    //sont pas le même flottant, et c'est le premier qui décide du lien
    const firstGapAtLeast=(low,x)=>{
        let a=0
        let b=n
        while(a<b){
            const mid=(a+b)>>1
            if(masses[mid]-low<x) a=mid+1
            else b=mid
        }
        return a
    }
    //La fenêtre est élargie d'un souffle, puis le test exact fait le tri. Une
    //fenêtre trop ÉTROITE perdrait un candidat sur un simple arrondi; trop large
    //ne coûte qu'une comparaison de plus, que le test rejette.
    const slack=tolerance*1e-9+1e-12
    for(let k=0;k<n;k++){
        const low=masses[k]
        if(!Number.isFinite(low)) continue
        generation++
        for(let r=0;r<references.length;r++){
            const centre=references[r].mass
            let lo=firstGapAtLeast(low,centre-tolerance-slack)
            if(lo<k+1) lo=k+1
            const hi=firstGapAtLeast(low,centre+tolerance+slack)
            for(let j=lo;j<hi;j++){
                if(served[j]===generation) continue
                served[j]=generation
                const found=nearestReference(references,masses[j]-low)
                if(found&&found.error<tolerance){
                    candidates.push({weight:found.error,u:k,v:j,std:found.index})
                }
            }
        }
    }
    candidates.sort((a,b)=>a.weight-b.weight||a.u-b.u||a.v-b.v)
/* LA COUPURE, ET ELLE SE COMPTE ICI — pas plus loin.

   `limit` est un rang dans la liste DÉJÀ triée: l'arbre se construit sur les
   `limit` meilleurs candidats et sur eux seuls. C'est ce que faisait Igor, dont
   la boucle s'arrêtait sur un critère statistique; ici l'arrêt est décidé
   ailleurs — sur la courbe — et il ne change que le bout de la liste, jamais
   son ordre. La courbe, elle, se rend ENTIÈRE: c'est elle qui montre où passe
   la coupure, donc la tronquer l'empêcherait de la montrer. */
    const cut=Number.isFinite(limit)&&limit>0
        ?Math.min(Math.trunc(limit),candidates.length)
        :candidates.length
    const curve=candidates.map(candidate=>candidate.weight)

    /* L'UNION-FIND, avec compression de chemin: c'est elle qui rend le coût
       amorti quasi constant quand le graphe est une longue chaîne. */
    const parent=new Int32Array(n)
    const size=new Int32Array(n)
    for(let i=0;i<n;i++){ parent[i]=i; size[i]=1 }
    const find=i=>{
        let root=i
        while(parent[root]!==root) root=parent[root]
        while(i!==root){ const next=parent[i]; parent[i]=root; i=next }
        return root
    }
    const cap=Number.isFinite(degreeMax)&&degreeMax>0?Math.trunc(degreeMax):0
    const degree=new Int32Array(n)
    const kept=[]
    for(const edge of candidates.slice(0,cut)){
        const ru=find(edge.u)
        const rv=find(edge.v)
        if(ru===rv) continue
        /* LE PLAFOND VÉRIFIE LES DEUX BOUTS AVANT L'AJOUT, comme Igor: un
           sommet atteint le plafond exactement, et refuse ensuite. */
        if(cap&&(degree[edge.u]>=cap||degree[edge.v]>=cap)) continue
        if(size[ru]<size[rv]) parent[ru]=rv
        else{ parent[rv]=ru; size[ru]+=size[rv] }
        degree[edge.u]++
        degree[edge.v]++
        kept.push(edge)
    }

    /* LES COMPOSANTES, rangées par taille décroissante puis par sommet
       croissant. Le représentant est le SOMMET DE PLUS FAIBLE INDICE — donc le
       plus léger — et c'est l'ancêtre, celui dont on part pour attribuer. */
    const roots=[]
    const representative=[]
    for(let node=0;node<n;node++){
        const root=find(node)
        const at=roots.indexOf(root)
        if(at===-1){ roots.push(root); representative.push(node) }
    }
    const rankOf=root=>roots.indexOf(root)
    const sizes=new Int32Array(roots.length)
    /* L'INTENSITÉ ET LA MASSE MAXIMALES sont accumulées ICI, dans les MÊMES
       tableaux que les tailles — donc ENCORE INDEXÉS PAR L'ANCIEN RANG.

       C'est la seule façon d'être d'accord avec le noyau, et la tentative
       d'accumuler après le remappage a déjà coûté un bug: `componentOf` porte
       alors le rang DÉFINITIF, qu'on ne peut plus comparer à un rang venu de
       `order`, qui est l'ancien. Chaque composant affichait alors le maximum
       d'un AUTRE — un arbre juste dont la lecture ment. Le test de parité l'a
       vu immédiatement sur 900 pics, où il ne se serait pas vu sur cinq. */
    const maxIntensityByRank=new Float64Array(roots.length).fill(-Infinity)
    const peakMassByRank=new Float64Array(roots.length).fill(-Infinity)
    const componentOf=new Int32Array(n)
    for(let node=0;node<n;node++){
        const rank=rankOf(find(node))
        sizes[rank]++
        if(intensities[node]>maxIntensityByRank[rank]) maxIntensityByRank[rank]=intensities[node]
        if(masses[node]>peakMassByRank[rank]) peakMassByRank[rank]=masses[node]
        componentOf[node]=rank
    }
    const order=roots.map((_,rank)=>rank)
    order.sort((a,b)=>sizes[b]-sizes[a]||representative[a]-representative[b])
    const position=new Int32Array(roots.length)
    order.forEach((old,rank)=>{ position[old]=rank })
    for(let node=0;node<n;node++) componentOf[node]=position[componentOf[node]]

    /* ET LE POIDS TOTAL, DANS L'AUTRE SENS.

       Il est cumulé APRÈS le remappage — donc indexé par le rang DÉFINITIF,
       qui est celui des tableaux rendus. Ce n'est pas une incohérence avec ce
       qui précède: les deux sommes ne se lisent pas au même moment. L'une
       décrit l'arbre (ses arêtes, donc sa topologie finale), l'autre décrit le
       groupe (ses pics, donc sa numérotation finale). */
    const componentWeight=new Float64Array(order.length)
    for(const edge of kept) componentWeight[componentOf[edge.u]]+=edge.weight

    const forest=empty()
    forest.edgeU=kept.map(e=>e.u)
    forest.edgeV=kept.map(e=>e.v)
    forest.edgeWeight=kept.map(e=>e.weight)
    forest.edgeStandard=kept.map(e=>e.std)
    forest.degree=Array.from(degree)
    forest.componentOf=Array.from(componentOf)
    forest.componentRoot=order.map(rank=>representative[rank])
    forest.componentSize=order.map(rank=>sizes[rank])
    forest.componentRootMass=order.map(rank=>masses[representative[rank]])
    forest.componentMaxIntensity=order.map(rank=>
        Number.isFinite(maxIntensityByRank[rank])?maxIntensityByRank[rank]:0)
    forest.componentPeakMass=order.map(rank=>
        Number.isFinite(peakMassByRank[rank])?peakMassByRank[rank]:0)
    forest.componentWeight=Array.from(componentWeight)
    forest.weights=curve
    forest.candidates=candidates.length
    forest.cutUsed=cut
    forest.isolated=Array.from(degree).filter(d=>d===0).length
    forest.edgeCount=kept.length
    forest.componentCount=order.length
    return forest
}
/* LE TROISIÈME TEMPS: RENDRE LA LECTURE.

   C'est l'équivalent du `CompteTribue` d'Igor, et c'est ici que les tableaux
   du noyau deviennent des LIGNES: un composant avec son ancêtre, sa taille,
   son pic le plus intense, son erreur totale, et les liens qui le forment.

   LES LIENS SONT RATTACHÉS À LEUR COMPOSANT, et pas renvoyés à part: une liste
   d'arêtes globale n'est pas lisible — on veut « les trois pics que ce
   groupe relie », pas « 41 arêtes quelque part ». Et le label de la référence
   vient de `standards.labels`, que le noyau ne connaît pas. */
export function forestComponents(forest,standards={}){
    const labels=standards.labels??[]
    if(!forest||!forest.componentCount) return []
    const links=Array.from({length:forest.componentCount},()=>[])
    for(let e=0;e<(forest.edgeU?.length??0);e++){
        const rank=forest.componentOf?.[forest.edgeU[e]]
        if(rank===undefined) continue
        links[rank].push({
            u:forest.edgeU[e],
            v:forest.edgeV[e],
            weight:forest.edgeWeight[e],
            standard:forest.edgeStandard[e],
            label:labels[forest.edgeStandard[e]]??null
        })
    }
    return Array.from({length:forest.componentCount},(_,rank)=>({
        rank,
        root:forest.componentRoot[rank],
        rootMass:forest.componentRootMass[rank],
        peakMass:forest.componentPeakMass[rank],
        size:forest.componentSize[rank],
        maxIntensity:forest.componentMaxIntensity[rank],
        weight:forest.componentWeight[rank],
        links:links[rank]
    }))
}

/* UNE LIGNE DE LECTURE POUR UN COMPOSANT, et elle est ici plutôt qu'à l'écran.

   Le format est une décision de DONNÉE, pas de mise en page: la même chaîne
   sert au panneau, à une infobulle et à un `console.log` de débogage, donc
   elle ne peut pas vivre dans un `textContent` du DOM où personne ne la
   retrouverait.

   LES LIENS SONT REGROUPÉS, parce qu'une chaîne de six pics affiche six fois
   la même formule et que la ligne finit par dépasser le panneau. « CH₂×5 »
   dit la même chose en un tiers de la place, et le compte est l'information
   qui manque à la version DÉVELOPPÉE — « combien de liens de ce type », pas
   « quels pics », que l'infobulle donne déjà.

   LE DÉCOMPTE EST CELUI DES LIENS, PAS CELUI DES SOMMETS: un groupe de six pics
   reliés en chaîne a cinq liens, et dire « CH₂×5 » est exact. */
export function componentLine(component,{tolDigits=3}={}){
    const error=(component.weight??0).toFixed(tolDigits)
    const chain=abbreviateLinks(component.links)
    const parts=[
        `${component.size} peak(s)`,
        `root ${component.rootMass.toFixed(4)}`
    ]
    if(component.size>1) parts.push(`Σ error ${error} Da`)
    if(chain) parts.push(chain)
    return parts.join("  ·  ")
}

/* LES LIENS RÉSUMÉS, et le résumé est trié par NOMBRE DÉCROISSANT.

   Le tri n'est pas cosmétique: sans lui, l'ordre dépend de l'ordre des arêtes,
   qui est celui du tri des poids — donc deux spectres voisins donneraient deux
   lignes qui se ressemblent mais ne se comparent pas à l'œil. */
function abbreviateLinks(links,maxDistinct=4){
    if(!links?.length) return ""
    const counts=new Map()
    for(const link of links){
        const key=link.label??`#${link.standard}`
        counts.set(key,(counts.get(key)??0)+1)
    }
    const ranked=[...counts.entries()].sort((a,b)=>b[1]-a[1]||String(a[0]).localeCompare(String(b[0])))
    const shown=ranked.slice(0,maxDistinct).map(([label,n])=>n>1?`${label}×${n}`:label)
    if(ranked.length>maxDistinct){
        /* LE RESTE EST COMPTÉ, PAS EFFACÉ: « …+3 autres » dit qu'il y en a, et
           une ligne qui n'en dit rien ferait croire que la liste est complète. */
        const hidden=ranked.slice(maxDistinct).reduce((total,[,n])=>total+n,0)
        shown.push(`+${hidden} other${hidden>1?"s":""}`)
    }
    return shown.join(", ")
}
/* ===========================================================================
   LA COUPURE, ET OÙ LA TROUVER.

   `suggestWeightCut` cherche, dans les poids déjà triés, le RANG après lequel
   le réseau cesse d'être crédible — la « marche » de la photo. C'est le premier
   écart entre deux poids consécutifs qui sort nettement du bruit de fond.

   LE CHOIX DE L'ÉCART, ET NON UN SEUIL SUR L'ERREUR.

   Igor cumulait les points tant que la distribution gardait un « caractère
   gaussien » — tant qu'un modèle de référence expliquait mieux la courbe qu'au
   point précédent — et il s'arrêtait quand il expliquait moins bien. C'est
   élégant, mais ça suppose une LOI: il faut savoir à quoi comparer. Ici on ne
   suppose rien sur la forme, on regarde la texture locale: un écart qui vaut
   `z` fois l'écart typique n'est pas du bruit, c'est une marche. C'est le
   critère déjà employé par le filtre anti-radio sur les largeurs de pic, donc la
   maison a déjà décidé de ce qu'elle appelle « significatif ».

   LE FT-ICR, ET POURQUOI C'ÉTAIT PEU ROBUSTE.

   Un spectromètre FT donne parfois une erreur NULLE: deux pics dont l'écart
   tombe exactement sur la référence. La courbe commence alors par un plateau à
   zéro, l'échelle logarithmique n'a rien à y tracer, et l'écart entre ce
   plateau et la suite est le plus grand de toute la courbe — donc, naïvement,
   la première marche EST le passage de zéro à la première valeur positive. Une
   coupure là-dessus garderait trois liens et jetterait tout le reste.

   LA RÉPONSE EST DE NE PAS REGARDER LE PREMIER SAUT, MAIS LE PREMIER SAUT
   PARMIIS CEUX QUI SUIVENT UNE PARTIE DE COURBE: on saute le bloc de valeurs
   identiques au minimum, et on ne cherche la marche que dans ce qui reste, une
   fois qu'il y a assez de points pour juger. Un plateau de zéros garde ainsi
   TOUS ses liens — ils sont les meilleurs, après tout — et la coupure tombe
   plus loin, là où la marche est réelle.
   =========================================================================== */

/* LE PASSAGE MAD → σ, et le seuil de significativité.

   Les deux sont des conventions de la maison, reprises telles quelles
   d'`antiradio.rs`: 1.4826 rend la médiane de l'écart absolu comparable à une
   déviation standard pour une gaussienne, et 8 est le rapport au-dessus duquel
   un écart n'est plus du bruit. */
const MAD_TO_SIGMA=1.4826
export const CUT_SIGNIFICANCE=8
/* Combien de points il faut surveying avant de se prononcer.

   Sans minimum, deux points suffisent: n'importe quelle paire a « une marche »,
   et la fonction proposerait une coupure fondée sur du bruit. Huit est le même
   plancher que le filtre anti-radio. */
export const CUT_MIN_POINTS=8

/* LA MÉDIANE, ET ELLE TRIE ELLE-MÊME.

   Une médiane qui exige une liste triée est une médiane qui rend n'importe quoi
   en silence: l'appelant qui lui passe `[...écarts]` sans trier obtient l'élément
   DU MILIEU, pas le médian — et ici cela donnait un seuil deux fois trop haut,
   donc aucune marche trouvée sur une courbe qui en avait une. Elle trie donc sa
   propre copie, et le tri est fait une fois de plus que nécessaire: sur quelques
   dizaines de nombres, c'est la quantité d'énergie la moins chère du programme,
   et c'est le prix d'une fonction dont on ne peut pas se tromper d'appel. */
const median=values=>{
    if(!values?.length) return NaN
    const sorted=[...values].sort((a,b)=>a-b)
    const middle=sorted.length>>1
    return sorted.length%2===1?sorted[middle]:0.5*(sorted[middle-1]+sorted[middle])
}
/* LA MARCHE, RENDUE COMME UN RANG DE POIDS CONSERVÉS.

   Couper après les `k` premiers poids revient à passer `k` au noyau, donc le
   rang rendu EST la longueur du préfixe. Une fonction qui rendait un indice
   d'écart obligerait l'appelant à recompter — et à le recompter différemment
   selon qu'il compte les écarts avant ou après: c'est ainsi que naissent les
   coupes décalées d'un cran. */
export function suggestWeightCut(weights,{significance=CUT_SIGNIFICANCE,minPoints=CUT_MIN_POINTS}={}){
    const count=weights?.length??0
    if(count<minPoints+1) return {index:count,reason:"not enough links to judge"}
    /* LE PLATEAU INITIAL, et c'est le cas FT-ICR.

       On saute les valeurs STRICTEMENT égales à la première. Elles sont aussi
       bonnes les unes que les autres — les garder toutes ne coûte rien et
       n'introduit rien de faux — et surtout le passage de zéro à la première
       valeur positive n'est PAS une marche: c'est la sortie du plancher de
       mesure, et c'est le plus grand écart de la courbe. */
    let start=0
    while(start+1<count&&weights[start+1]===weights[start]) start++
    const tail=weights.slice(start+1)
    /* Il faut de quoi comparer: sans une queue de points, aucun écart ne peut
       être jugé « anormal », et la fonction rendrait une absence de preuve
       comme une preuve d'absence de marche. */
    if(tail.length<minPoints) return {index:count,reason:"not enough links after the zero plateau"}
    const steps=[]
    for(let i=1;i<tail.length;i++) steps.push(tail[i]-tail[i-1])
    const positive=steps.filter(step=>step>0)
    /* QUE DES ÉCARTS NULS: une courbe plate n'a pas de marche, et en inventer une
       reviendrait à couper au hasard — donc on garde tout et on le dit. */
    if(!positive.length) return {index:count,reason:"every link has the same error"}
    /* L'ÉCHELLE, prise sur les écarts POSITIFS seulement.

       Les écarts nuls sont la texture normale d'une courbe d'erreurs — deux
       liens peuvent tomber sur la même erreur — et les compter ferait tomber la
       médiane à zéro, donc n'importe quel écart NON nul semblerait
       significatif. */
    const centre=median(positive)
    const spread=MAD_TO_SIGMA*median(positive.map(step=>Math.abs(step-centre)))
    /* L'ÉCHELLE, ET ELLE SE REPOSE SUR LE PAS TYPIQUE.

       Le MAD d'une série dont tous les pas sont IDENTIQUES vaut zéro — ou, en
       flottant, 1e-19, ce qui n'est pas mieux. C'est le cas de la queue d'une
       courbe après un plateau à zéros: dix-huit pas de 1e-4 et un pas de 0.9,
       donc une médiane d'écarts qui vaut « presque rien », et un seuil si petit
       que le PREMIER pas ordinaire passe pour une marche. Une coupure à cet
       endroit garderait un seul lien.

       Donc l'échelle n'est jamais en dessous du pas TYPIQUE: « significatif »
       veut dire « huit fois plus grand que le pas qu'on voit d'ordinaire », et
       le pas ordinaire est la seule grandeur qui ne s'effondre pas. */
    const floor=median(positive)
    const reference=Math.max(spread,floor)
    for(let i=0;i<steps.length;i++){
        const step=steps[i]
        if(step<=0) continue
        /* LA MARCHE EST LE PREMIER ÉCART QUI DÉPASSE LE BRUIT.

           On compare au niveau de référence, pas au plus grand écart de la
           courbe: ce serait la fin de la distribution — des pics sans voisin —
           et la couper laisserait tous les groupes de l'échantillon fusionnés en
           un seul. */
        if(reference>0&&step>significance*reference){
            return {
                /* LE RANG EST CELUI DU POINT HAUT DE LA MARCHE, et c'est le
                   point qui doit TOMBER: couper « après le saut » garderait le
                   lien fautif, qui est précisément celui qu'on veut laisser
                   dehors. Donc on rend l'indice du point haut, qui est aussi le
                   nombre de poids conservés. */
                index:start+2+i,
                step,
                reference,
                reason:`first step above ${significance}x the local spread`
            }
        }
    }
    return {index:count,reason:"no step stands out: keep every link"}
}

/* =========================================================================
   LE GRAPHE, tel qu'un ÉCRAN peut le dessiner.

   `forestComponents` rend des LIGNES: `6 peak(s), root 180.1028, CH₂×3`. C'est
   la lecture d'un composant, et elle est parfaite pour une liste. Ce qu'un
   écran ne peut pas faire, c'est montrer trois cents pics reliés en étoile — et
   c'est pourtant là que se lit la qualité d'un réseau: un groupe où tous les
   liens sont courts est une molécule, un groupe dont la moitié des liens sont à
   la limite de la fenêtre est du bruit qui a trouvé une forme.

   Donc on rend le MÊME objet sous une autre forme: des sommets qui portent leur
   masse, leur intensité et leur degré, et des arêtes qui portent leur erreur.
   Les deux viennent des MEMES tableaux que la ligne lit — rien n'est recalculé,
   et une ligne qui ment ferait mentir le graphique tout autant.
   ========================================================================= */

/* LE DÉFAUT DE MASSE, et il est la seule chose qui distingue deux pics voisins.

   La définition est celle de la spectrométrie haute résolution: la partie
   fractionnaire AU-DESSUS de la masse nominale, donc `m − ⌊m⌋`, dans [0,1).

   `Math.round` donnerait l'inverse — un pic à 199.9999 aurait un défaut de
   0.0001 — et c'est exactement le pic le plus caractéristique d'un spectre qui
   serait écarté. La partie fractionnaire est donc le bon choix, et il n'a pas
   de paramètre: changer sa définition changerait ce que « le plus spécifique »
   veut dire, et ce mot doit vouloir dire une seule chose dans le programme. */
export function massDefect(mass){
    return Number.isFinite(mass)?mass-Math.floor(mass):0
}

/* LA DIFFÉRENCE STOICHIOMÉTRIQUE ENTRE DEUX COMPOSITIONS, isotope par isotope.
   Rend une composition SIGNÉE sur le même format `Map<Element, Map<A,count>>`
   (comptes négatifs possibles): `diff = big − small`, donc propager depuis la
   petite racine en AJOUTANT le diff donne la grande — et propager depuis la
   grande en le RETIRANT donne la petite. C'est `propagateForest` qui décide du
   sens via `u < v` en masse; ici on ne fait que la soustraction.
   Les clés `Element` sont comparées par IDENTITÉ (mêmes objets du plan): deux
   compositions issues du même plan partagent leurs objets, donc c'est exact. */
export function forestCompositionDiff(big,small){
    const diff=new Map()
    const bump=(element,A,delta)=>{
        if(!delta) return
        if(!diff.has(element)) diff.set(element,new Map())
        const slot=diff.get(element)
        slot.set(A,(slot.get(A)??0)+delta)
        if(slot.get(A)===0) slot.delete(A)
        if(slot.size===0) diff.delete(element)
    }
    for(const [element,byA] of big??[]){
        for(const [A,n] of byA) bump(element,A,n)
    }
    for(const [element,byA] of small??[]){
        for(const [A,n] of byA) bump(element,A,-n)
    }
    return diff
}

/* LE DIFF EST-IL VIDE — deux racines de même formule, rien à relier. */
export function forestDiffIsEmpty(diff){
    if(!diff) return true
    for(const [,byA] of diff){
        for(const [,n] of byA){
            if(n!==0) return false
        }
    }
    return true
}

/* ÉCRIT UN DIFF SIGNÉ DANS LA LANGUE QUE LE LECTUREUR PARLE RÉELLEMENT.

   Sert à nommer la brique ajoutée au plan de liaison quand le diff ne
   correspond à aucune brique existante — donc cette chaîne va être RE-LUE par
   `Formula.parse`, et c'est ce qui la contraint entièrement.

   LA LANGUE EST CELLE DE `parseComposition`, et elle n'est pas celle
   qu'écrirait un chimiste : le signe précède le symbole et le compte suit.

       -C      un carbone en moins        -2H   deux hydrogènes en moins
       -H2     deux H en moins, de même   +N    un azote en plus

   L'ancienne écriture mettait le nombre d'A DEVANT le symbole — `-12C6` — et le
   lecteur y voyait un COEFFICIENT : `-12C6` devenait −6 × 12 = −72 carbons, au
   lieu de six carbones en moins. Une substitution s'écrivait donc `-12C6-1H+14N
   +16O` et se relisait à −413 Da au lieu de −15 : la brique écrite, relue, et
   appliquée, n'était pas la différence qu'elle décrivait. Mesuré, pas supposé.

    L'ISOTOPE NON PAR DÉFAUT GARDE SON A DEVANT LE SYMBOLE. Son compte négatif
    vient après le symbole (`13C-2`), car le mettre devant (`-13C`) en ferait un
    coefficient de treize carbones par défaut. Les termes sont séparés par des
    espaces pour que chaque signe reste attaché à son propre atome. */
export function forestDiffNotation(diff){
    const terms=[]
    const composition=positiveMassConjugate(diff)
    const ordered=[...(composition?.keys()??[])].sort((a,b)=>{
        const sa=String(a?.symbol??a?.name??a)
        const sb=String(b?.symbol??b?.name??b)
        if(sa==="C"&&sb!=="C") return -1
        if(sb==="C"&&sa!=="C") return 1
        if(sa==="H"&&sb!=="H") return -1
        if(sb==="H"&&sa!=="H") return 1
        return sa<sb?-1:sa>sb?1:0
    })
    for(const element of ordered){
        const byA=composition.get(element)
        const symbol=String(element?.symbol??element?.name??element)
        for(const [A,n] of [...(byA?.entries()??[])].sort((x,y)=>x[0]-y[0])){
            if(!n) continue
            /* L'ISOTOPE PAR DÉFAUT, celui que le lecteur choisirait de lui-même:
               l'écrire serait l'écrire deux fois — et le mal lire. */
            const isDefault=A===element?.pickA?.("mostProbable")
            const massTag=!isDefault&&Number.isInteger(A)&&A>0?`${A}`:""
            const sign=n<0?"-":"+"
            const count=Math.abs(n)
            if(massTag){
                terms.push(n<0
                    ?`${massTag}${symbol}-${count}`
                    :`${massTag}${symbol}${count===1?"":count}`)
            }else{
                terms.push(`${sign}${symbol}${count===1?"":count}`)
            }
        }
    }
    return terms.join(" ")||"±0"
}

/* RETROUVE UNE BRIQUE DU PLAN PAR SA COMPOSITION — comparaison isotope par
   isotope, SIGNE par signe (`forestFindBrick`): une brique est une différence
   signée, donc elle se compare comme telle.
signe signed par signe. Rend l'index
   dans `items`, ou -1. */
export function forestFindBrick(items,diff){
    const list=items??[]
    if(!diff) return -1
    /* UNE SUBSTITUTION N'EST PLUS UN CAS IMPOSSIBLE.

       Une brique était réputée ne pas pouvoir porter de compte négatif, parce
       que le plan ne les produisait pas: le moteur relisait la clé canonique
       d'une formule, donc une perte entrait comme un ajout de masse et de
       signe. Le plan garde maintenant la composition signée (`readCombining`),
       et une brique EST une différence signée — donc `-C-H+N-O` est une brique
       comme une autre, que l'on peut écrire, relire, comparer et appliquer.

       Ce que la recherche par magnitudes apportait — trouver une brique pour une
       substitution — est désormais obtenu SANS elle, et sans rien perdre de
       deuxième main:

       La comparaison se fait SUR LA DIFFÉRENCE SIGNÉE, et non sur ses
       magnitudes. C'était la seule manière de répondre au problème premier —
       une substitution ne peut pas s'écrire en brique positive — mais
       l'astuce des magnitudes était fausse deux fois:

       elle perdait les SIGNES, donc une différence `-C-H+N-O` se retrouvait
       comparée à la brique `CHNO` sans que rien ne distingue les deux; et elle
       perdait la MASSE, donc une brique choisie par magnitudes ne pesait pas
       ce que valait la différence. Comme le poids d'un lien se calcule sur
       l'écart moins la masse de la brique, l'erreur du lien portait alors
       l'erreur du modèle — 60 Da mesurés sur une substitution.

       Une brique EST donc la différence signée, et elle est comparée comme
        telle. Une brique non signée reste cherchable, parce que c'est le cas
        général: `CH2` et `-CH2` sont deux briques distinctes, et le lien
        choisit. */
    const target=new Map()
    for(const [element,byA] of diff){
        const slot=new Map()
        for(const [A,n] of byA){
            if(n) slot.set(A,n)
        }
        if(slot.size) target.set(element,slot)
    }
    if(!target.size) return -1
    const sameAs=(composition,times)=>{
        const probe=new Map()
        const bump=(element,A,delta)=>{
            if(!delta) return
            if(!probe.has(element)) probe.set(element,new Map())
            const slot=probe.get(element)
            slot.set(A,(slot.get(A)??0)+delta)
            if(slot.get(A)===0) slot.delete(A)
            if(slot.size===0) probe.delete(element)
        }
        for(const [element,byA] of composition??[]){
            for(const [A,n] of byA) bump(element,A,n*times)
        }
        if(probe.size!==target.size) return false
        for(const [element,byA] of target){
            const other=probe.get(element)
            if(!other||other.size!==byA.size) return false
            for(const [A,n] of byA){
                if((other.get(A)??0)!==n) return false
            }
        }
        return true
    }
    for(let i=0;i<list.length;i++){
        const composition=list[i]?.composition
        if(!composition) continue
        if(sameAs(composition,1)) return i
    }
    return -1
}

/* FUSIONNE DES GRAPHES EN UN SEUL, avec les liens inter-racines donnés.
   `links` porte `{u, v, standard, label, weight}` — un lien est un lien, la
   physique (`frStep`) n'a rien de nouveau à apprendre: le ressort du segment
   ajouté tire les deux moitiés l'une vers l'autre tout seul. La racine du
   graphe fusionné est celle du PLUS GRAND arbre (le premier de la liste, qui
   doit arriver triée par taille décroissante). */
export function forestMergeGraphs(graphs,links=[]){
    const list=(graphs??[]).filter(Boolean)
    if(!list.length) return null
    if(list.length===1&&!links.length) return list[0]
    const seen=new Map()
    for(const graph of list){
        for(const vertex of graph.vertices??[]){
            if(seen.has(vertex.index)) continue
            seen.set(vertex.index,{...vertex,isRoot:false})
        }
    }
    const mergedLinks=[]
    for(const graph of list){
        for(const link of graph.links??[]){
            if(!seen.has(link.u)||!seen.has(link.v)) continue
            mergedLinks.push({u:link.u,v:link.v,weight:Number(link.weight)||0,
                standard:link.standard,label:link.label??null})
        }
    }
    for(const link of links??[]){
        if(!seen.has(link.u)||!seen.has(link.v)) continue
        mergedLinks.push({u:link.u,v:link.v,weight:Number(link.weight)||0,
            standard:link.standard,label:link.label??null})
    }
    const vertices=[...seen.values()].sort((a,b)=>a.mass-b.mass)
    const rootIndex=Number.isInteger(list[0]?.rootIndex)&&seen.has(list[0].rootIndex)
        ?list[0].rootIndex
        :vertices[0]?.index??null
    for(const vertex of vertices) vertex.isRoot=vertex.index===rootIndex
    return {
        rank:list[0].rank,
        size:vertices.length,
        vertices,
        links:mergedLinks,
        rootIndex,
        rootReason:`merged from ${list.map(g=>`#${g.rank}`).join(", ")}`,
        rootCandidates:1,
        meanMass:vertices.length
            ?vertices.reduce((n,vertex)=>n+vertex.mass,0)/vertices.length
            :0,
        span:vertices.length?vertices[vertices.length-1].mass-vertices[0].mass:0,
        weight:list.reduce((n,graph)=>n+(Number(graph.weight)||0),0)
            +links.reduce((n,link)=>n+(Number(link.weight)||0),0),
        totalIntensity:vertices.reduce((n,vertex)=>n+(Number(vertex.intensity)||0),0),
        /* LA PROVENANCE EST CUMULATIVE, et c'est indispensable.

       `list.map(graph=>graph.rank)` ne portait que les rangs REÇUS. Mais un
       arbre peut lui-même être le résultat d'une fusion antérieure: son rang
       est alors celui du plus grand d'origine, et son propre `mergedFrom` — les
       arbres qu'il a déjà absorbés — disparaissait du nouveau.

       Conséquence observée: après #0+#1 puis (fusionné)+#2, la nouvelle
       provenance valait `[0,2]`. Le rang 1, déjà absorbé, n'y figurait plus, et
       le rendu — qui ne retire du dessin que les rangs listés — réaffichait
       l'arbre #1. L'utilisateur voyait l'arbre qu'il venait de fusionner
       réapparaître, et ses)fusions suivantes portaient sur le mauvais couple.

       On déplie donc la provenance de chaque entrant, et on dédoublonne: un rang
       absorbé reste absorbé, quelle que soit la longueur de la chaîne. */
mergedFrom:[...new Set(list.flatMap(graph=>graph.mergedFrom??[graph.rank]))],
        mergedLinks:(links??[]).map(link=>({u:link.u,v:link.v,
            standard:link.standard,label:link.label??null}))
    }
}

/* UN GRAPHE PAR COMPOSANT, et il est complet ou il n'existe pas.

   Un sommet de degré zéro — un pic seul, que rien ne relie — n'est dans aucune
   arête, donc une lecture qui neinio que les arêtes perdrait les pics isolés…
   et `componentCount` les compte. Le compte du noyau est donc la seule longueur
   qui ne ment pas, et c'est elle qui décide de la boucle: un composant annoncé à
   six sommets pour trois arêtes est complet quand même, et l'afficher à moitié
   serait pire que de ne pas l'afficher.

   `masses` est indexé comme le noyau, donc dans l'ordre TRIÉ des pics: c'est
   cet ordre que portent `u` et `v`, et la ligne n'en a pas besoin — d'où la
   présence explicite du tableau ici. */
export function forestGraph(components,{masses=[],intensities=[]}={}){
    return (components??[]).map(component=>{
        const seen=new Map()
        const keep=index=>{
            if(!Number.isInteger(index)||index<0||seen.has(index)) return
            const mass=Number(masses?.[index])
            if(!Number.isFinite(mass)) return
            seen.set(index,{
                index,
                mass,
                intensity:Number(intensities?.[index])||0,
                defect:massDefect(mass),
                degree:0,
                /* `false` PROVISOIRE, et ce n'est pas un détail: la vraie racine
                   est désignée une seule fois, en bas, par `forestRoot`. Poser
                   ici `index===component.root` installerait une SECONDE autorité
                   — la racine du noyau Rust — qui survivrait au moindre
                   réordonnancement du code, et le même arbre se propagerait
                   alors depuis deux pics différents selon le chemin pris. Le
                   drapeau provisoire n'a aucune valeur: il est réécrit avant la
                   sortie. */
                isRoot:false
            })
        }
        /* LA RACINE D'ABORD: elle est le seul sommet que le noyau NOMME, et un
           groupe d'un seul pic n'a aucune arête pour la faire apparaître. */
        keep(component.root)
        const links=[]
        for(const link of component.links??[]){
            keep(link.u)
            keep(link.v)
            if(!seen.has(link.u)||!seen.has(link.v)) continue
            seen.get(link.u).degree++
            seen.get(link.v).degree++
            links.push({
                u:link.u,
                v:link.v,
                weight:Number(link.weight),
                standard:link.standard,
                label:link.label??null
            })
        }
        const vertices=[...seen.values()].sort((a,b)=>a.mass-b.mass)
        /* LA RACINE DU CAHIER DES CHARGES, ET ELLE VIT DANS LE GRAPHE.
           `forestRoot` choisit le pic au défaut le plus élevé dans ±10 % de
           l'étendue autour de la moyenne — pas le premier indice, qui est le
           pic le plus léger. `propagateForest` lit `graph.rootIndex` en
           premier et ne retombe sur `vertices[0]` qu'en son absence: sans ce
           champ, la propagation partait du mauvais pic. */
        const chosen=forestRoot({vertices})
        const rootIndex=Number.isInteger(chosen?.index)&&seen.has(chosen.index)
            ?chosen.index
            :null
        for(const vertex of vertices) vertex.isRoot=vertex.index===rootIndex
        return {
            rank:component.rank,
            size:component.size??vertices.length,
            vertices,
            links,
            rootIndex,
            rootReason:chosen?.reason??null,
            rootCandidates:chosen?.candidates??0,
            /* LA MASSE MOYENNE, et elle sert à deux choses: choisir la racine, et
               dire à l'écran où est le CENTRE d'un groupe. Un groupe dont la
               moyenne est très au-dessus du mode n'est pas un groupe, c'est une
               traîne de pics sans lien — et le dessin le montre. */
            meanMass:vertices.length
                ?vertices.reduce((n,vertex)=>n+vertex.mass,0)/vertices.length
                :0,
            span:vertices.length?vertices[vertices.length-1].mass-vertices[0].mass:0,
            /* L'ÉNERGIE TOTALE, l'erreur déjà cumulée que la ligne affiche. Elle
               est reprise telle quelle: c'est la somme des `weight` du noyau, et
               la recalculer en JavaScript donnerait un nombre différent au
               dernier bit, donc deux affichages qui ne concordent pas. */
            weight:Number(component.weight)||0,
            totalIntensity:vertices.reduce((n,vertex)=>n+vertex.intensity,0)
        }
    })
}

/* LE LAYOUT ANIMÉ PASSE PAR LE WORKER, mais le CONTRAT EST CELUI DE
   `createAnimatedLayout` / `advanceLayout`: mêmes champs d'état, même
   résultat final — seul `frStep` change de thread.

   LE WORKER EST TIRÉ, JAMAIS POUSSÉ: il ne calcule que sur la réponse à un
   `resume` (N pas), puis il renvoie les positions. La boucle rAF du nœud
   reste maîtresse du rythme: `stop` n'a aucun calcul d'arrière-plan à
   annuler, et une session qui ne reçoit rien ne coûte rien.

   UNE SESSION PAR ARBRE, identifiée par `initId`: plusieurs arbres
   affichés cohabitent dans le même worker. Et CHAQUE demande reçoit une
   réponse — une promesse sans réponse figerait la boucle d'animation pour
   toujours, et c'est le défaut le plus silencieux qu'un worker puisse
   avoir. */
let forestWorker = null
const workerCallbacks = new Map()
let workerInitId = 0

function getForestWorker() {
    if (!forestWorker) {
        forestWorker = new Worker(new URL("./forest-worker.js", import.meta.url), {type: "module"})
        forestWorker.onmessage = (e) => {
            const {type, initId, ...data} = e.data
            if (type !== "positions" && type !== "done") return
            /* LA DÉCONNEXION EST ICI, UNE SEULE FOIS: le callback peut aussi
               être déconnecté par `stop` (libération d'un état obsolète), et
               une réponse trop tardive ne doit alors plus rien toucher. */
            const cb = workerCallbacks.get(initId)
            if (!cb) return
            workerCallbacks.delete(initId)
            cb(data)
        }
        forestWorker.onerror = (err) => {
            console.error('[forest] worker error:', err)
            const message = err?.message ?? String(err)
            for (const cb of workerCallbacks.values()) cb({done: true, error: message})
            workerCallbacks.clear()
        }
    }
    return forestWorker
}

/* LIBÈRE LA PROMESSE EN ATTENTE D'UNE SESSION: `stop` peut arriver au milieu
   d'une frame en cours (changement de sélection), et la promesse abandonnée
   est exactement celle que le tick attend. Sans positions dans la réponse,
   l'état garde les dernières connues — il n'avance plus, il ne régresse pas. */
function flushWorkerCallback(initId, data) {
    const cb = workerCallbacks.get(initId)
    if (!cb) return
    workerCallbacks.delete(initId)
    cb(data)
}

export function createAnimatedLayoutWorker(graph, options = {}) {
    const worker = getForestWorker()
    const initId = ++workerInitId
    const params = {
        iterations: options.iterations ?? FOREST_LAYOUT_DEFAULTS.iterations,
        ideal: options.ideal ?? FOREST_LAYOUT_DEFAULTS.ideal,
        repulsion: options.repulsion ?? FOREST_LAYOUT_DEFAULTS.repulsion,
        restBase: options.restBase ?? FOREST_LAYOUT_DEFAULTS.restBase,
        restSpan: options.restSpan ?? FOREST_LAYOUT_DEFAULTS.restSpan,
        tempStart: options.tempStart ?? FOREST_LAYOUT_DEFAULTS.tempStart,
        tempEnd: options.tempEnd ?? FOREST_LAYOUT_DEFAULTS.tempEnd,
        fac: options.fac ?? FOREST_LAYOUT_DEFAULTS.fac,
        viscosity: options.viscosity ?? FOREST_LAYOUT_DEFAULTS.viscosity,
        springExponent: options.springExponent ?? FOREST_LAYOUT_DEFAULTS.springExponent,
        massForce: options.massForce ?? FOREST_LAYOUT_DEFAULTS.massForce,
        defectForce: options.defectForce ?? FOREST_LAYOUT_DEFAULTS.defectForce,
        errorForce: options.errorForce ?? FOREST_LAYOUT_DEFAULTS.errorForce,
        depthForce: options.depthForce ?? FOREST_LAYOUT_DEFAULTS.depthForce
    }
    return new Promise((resolve, reject) => {
        workerCallbacks.set(initId, (data) => {
            if (data.error) return reject(new Error(data.error))
            resolve({
                positions: data.positions,
                iteration: data.iteration ?? 0,
                maxSpeed: data.maxSpeed ?? 0,
                done: !!data.done,
                totalIterations: data.totalIterations ?? params.iterations,
                graph,
                params,
                workerInitId: initId
            })
        })
        worker.postMessage({type: 'init', initId, graph, params})
    })
}

export function advanceLayoutWorker(state, steps = 1) {
    if (state.done) return Promise.resolve(true)
    if (!Number.isInteger(state.workerInitId)) return Promise.resolve(true)
    const worker = getForestWorker()
    return new Promise((resolve) => {
        workerCallbacks.set(state.workerInitId, (data) => {
            if (data.error) {
                /* UNE ERREUR ARRÊTE L'ANIMATION, elle ne la reboucle pas: sans
                   ça, chaque frame re-posterait la même faute, pour toujours. */
                console.error('[forest] worker advance error:', data.error)
                state.done = true
                return resolve(true)
            }
            if (data.positions) {
                state.positions = data.positions
                state.iteration = data.iteration ?? state.iteration
                state.maxSpeed = data.maxSpeed
                state.totalIterations = data.totalIterations ?? state.totalIterations
            }
            /* PAS DE POSITIONS = session libérée entre-temps: on garde les
               dernières connues et on n'avance plus. */
            state.done = data.positions ? !!data.done : true
            resolve(state.done)
        })
        worker.postMessage({type: 'resume', initId: state.workerInitId, steps: Math.max(1, Math.trunc(steps) || 1)})
    })
}

export function pauseLayoutWorker(state) {
    if (!Number.isInteger(state.workerInitId)) return
    flushWorkerCallback(state.workerInitId, {done: true})
    getForestWorker().postMessage({type: 'pause', initId: state.workerInitId})
    state.done = true
}

export function stopLayoutWorker(state) {
    if (!Number.isInteger(state.workerInitId)) return
    flushWorkerCallback(state.workerInitId, {done: true})
    getForestWorker().postMessage({type: 'stop', initId: state.workerInitId})
    state.done = true
}

export function terminateForestWorker() {
    if (!forestWorker) return
    /* LE WORKER MEURT AVEC SES SESSIONS, mais pas avec les promesses qui
       l'attendaient: elles reçoivent une erreur, donc se ferment. L'identité
       `workerInitId` n'est JAMAIS remise à zéro — un état orphelin survivant
       réclamerait alors une session déjà refaite sous le même numéro. */
    forestWorker.terminate()
    forestWorker = null
    for (const cb of workerCallbacks.values()) cb({done: true, error: 'forest worker terminated'})
    workerCallbacks.clear()
}


/* LA RACINE D'UN GROUPE, et c'est le SEUL endroit du programme qui décide quel
   pic sert de point de départ à une attribution.

   LA RÈGLE, en deux temps, et c'est celle du cahier des charges:

     1. le pic le plus PROCHE DE LA MOYENNE EN MASSE — parce que la moyenne d'un
        groupe de pics est la position la plus probable de la molécule, et qu'un
        pic à l'extrémité d'un groupe est un fragment ou un adduit;
     2. à distance égale, celui au DÉFAUT DE MASSE LE PLUS ÉLEVÉ — parce que
        parmi des candidats équivalents le plus fractionnaire est le plus
        spécifique: à ppm donnée, un pic rare et très nominal ne laisse qu'une
        formule, un pic médian en laisse dix.

   LA FENÊTRE. « Le plus proche de la moyenne » sans fenêtre ne sélectionne
   qu'un seul point — le plus proche, point. Un groupe de quatre cents pics n'a
   pas de point central, il a une NUÉE autour du centre, et c'est dans la nuée
   que le défaut de masse départage. On retient donc d'abord ceux qui sont à
   `window` de l'étendue autour de la moyenne, et c'est DANS ce lot que le
   défaut tranche. Dix pour cent de l'étendue: assez large pour englober la
   nuée, assez étroit pour ne pas descendre dans la traîne.

   CE QUI EST RENDU, et pourquoi autant: `candidates` dit combien de pics
   concurraient, donc un utilisateur qui n'aime pas le choix voit tout de suite
   qu'il y en avait d'autres. Un choix qu'on ne peut pas contester n'est pas un
   choix. */
export function forestRoot(graph,{window:share=0.1}={}){
    const vertices=graph?.vertices??[]
    const usable=vertices.filter(vertex=>Number.isFinite(vertex.mass))
    if(!usable.length) return {index:null,reason:"the group has no measurable peak"}
    const mean=usable.reduce((n,vertex)=>n+vertex.mass,0)/usable.length
    const span=usable[usable.length-1].mass-usable[0].mass
    /* UN GROUPE D'UN SEUL PIC n'a pas d'étendue, donc toute fenêtre le garderait
       et le défaut déciderait — sur un seul candidat il n'y a rien à décider, et
       c'est lui. Le cas est traité pour que la fenêtre ne serve pas à exclure
       l'unique pic qu'il reste. */
    const width=span>0?span*share:Infinity
    const candidates=usable.filter(vertex=>Math.abs(vertex.mass-mean)<=width)
    let best=candidates[0]??null
    /* AUCUN PIC dans la fenêtre (±10 % de l'étendue autour de la moyenne) :
       c'est la règle n°1 du cahier des charges — celui le plus proche de la
       moyenne — et non le plus léger, qui n'est pas nécessairement le sommet
       le plus représentatif du groupe. */
    if(!best){
        best=usable.reduce((a,b)=>{
            const da=Math.abs(a.mass-mean),db=Math.abs(b.mass-mean)
            if(da!==db) return da<db?a:b
            if(a.defect!==b.defect) return b.defect>a.defect?b:a
            return a.index<b.index?a:b
        })
    }
    for(const vertex of candidates){
        const better=vertex.defect>best.defect
            /* À DÉFAUT ÉGAL, LE PLUS CENTRÉ. Deux pics ne peuvent pas partager un
               défaut de masse ET une masse, donc ce départage n'arrive presque
               jamais; il est là pour que la fonction soit TOTALE et qu'un jeu
               d'essai ne puisse ni la faire boucler ni lui faire rendre le
               premier trouvé. */
            ||(vertex.defect===best.defect&&Math.abs(vertex.mass-mean)<Math.abs(best.mass-mean))
        if(better) best=vertex
    }
    return {
        index:best.index,
        mass:best.mass,
        defect:best.defect,
        meanMass:mean,
        candidates:candidates.length,
        reason:usable.length===1
            ?"the group is a single peak"
            :`${best.defect.toFixed(4)} defect, among ${candidates.length} near the ${mean.toFixed(4)} mean`
    }
}


/* LA MISE EN PLACE, et elle est EXÉCUTÉE ICI, pas à chaque image.

   Un moteur de force qui tourne à chaque `requestAnimationFrame` recalcule le
   même résultat cinquante fois par seconde pendant que l'utilisateur regarde.
   On le calcule UNE FOIS, quand le graphe change, et le dessin ne fait plus que
   lire des positions.

   ET ELLE EST DÉTERMINISTE. Aucun tirage aléatoire: les sommets partent d'un
   cercle rangé par masse croissante — ce qui est déjà une mise en page qui veut
   quelque chose, puisque l'ordre des masses est l'ordre de construction du
   réseau — et les itérations sont déterministes. Un graphique qui change de
   forme à chaque « Grow network » ne permet pas de comparer deux réseaux, et
   c'est la comparaison qui sert.

   LA GRILLE. La répulsion ne s'évalue que sur les paires proches. En exact elle
   coûte O(n²) par itération: deux cents itérations sur mille sommets, c'est
   deux cents millions de paires, et le panneau se figerait plusieurs secondes.
   La grille rend le coût indépendant de la taille du groupe, au prix d'une
   approximation que personne ne voit — deux pics très éloignés se repoussent
   déjà très peu. */
function repulse(positions,disp,count,k,cutoff,cellSize,repulsion=1){
    const grid=new Map()
    const cellOf=index=>
        `${Math.floor(positions[index*2]/cellSize)},${Math.floor(positions[index*2+1]/cellSize)}`
    for(let i=0;i<count;i++){
        const key=cellOf(i)
        let bucket=grid.get(key)
        if(!bucket){ bucket=[]; grid.set(key,bucket) }
        bucket.push(i)
    }
    for(const bucket of grid.values()){
        for(const i of bucket){
            const [cx,cy]=cellOf(i).split(",")
            for(let dx=-1;dx<=1;dx++){
                for(let dy=-1;dy<=1;dy++){
                    const other=grid.get(`${Number(cx)+dx},${Number(cy)+dy}`)
                    if(!other) continue
                    for(const j of other){
                        if(j<=i) continue
                        let px=positions[j*2]-positions[i*2]
                        let py=positions[j*2+1]-positions[i*2+1]
                        let distance=Math.hypot(px,py)
                        /* DEUX SOMMETS AU MÊME POINT, et la répulsion est une
                           division par cette distance: sans ce plancher le
                           résultat vaut l'infini et la mise en page explose. Il
                           vaut un millième de la longueur idéale — assez pour
                           lever l'indétermination, trop petit pour se voir. */
                        if(distance<1e-6){
                            px=(i%2?1:-1)*1e-3
                            py=(j%2?1:-1)*1e-3
                            distance=Math.hypot(px,py)
                        }
                        if(distance>cutoff) continue
                        /* FR PUR: fr=k²/d, accumulé dans `disp` — PAS appliqué
                           brut aux positions, sinon un pas de 2700/d² explose
                           dès que deux sommets se touchent. C'est la température
                           qui plafonne le pas, en bas. */
                        const push=repulsion*k*k/distance/distance
                        const ux=px/distance
                        const uy=py/distance
                        disp[i*2]-=ux*push*distance
                        disp[i*2+1]-=uy*push*distance
                        disp[j*2]+=ux*push*distance
                        disp[j*2+1]+=uy*push*distance
                    }
                }
            }
        }
    }
}


/* UN PAS FAÇON IGOR, et c'est le SEUL endroit où ça bouge.
   Trois lois reprises de `opimisation`:
     — RESSORT CUBIQUE sur les liens: `f=(d-rest)³/rest²` le long de l'axe.
       Mou près du repos, raide loin — un arbre replié se fait arracher d'un
       coup au lieu de se déplier mollement. `R` vaut `rest`, pas 1 fixe:
       chaque lien a son repos selon son erreur.
     — RÉPULSION BORNÉE sur les paires proches: `f=r/(1+d²)` au lieu de
       `k²/d`. Max en `d=1`, →0 quand les sommets se touchent — jamais
       d'explosion, pas de garde-fou, mais le cercle initial doit déjà séparer
       (il le fait: rayon `ideal`).
     — MOMENTUM + SATURATION: `vitesse` accumule d'un tour à l'autre (jamais
       remis à zéro), puis chaque nœud est normalisé (`v/|v|`), écrasé par
       `2*atan(|v|)/pi` → [0,1[, multiplié par `fac`. Gros effort = pas de
       `fac`, petit effort = pas proportionnel. C'est ça qui converge, pas une
       température programmée — `temp` ne sert plus qu'au tout premier pas.
   Le recentrage est dur (`obs -= bary`), comme ton `bary`: pas de gravité
   douce, pas de dérive. */
/* UN PAS HYBRIDE: répulsion FR + ressort cubique Igor + momentum saturé.
   - RÉPULSION FR `k²/d` sur paires proches (portée 2k): c'est elle qui sépare
     — divergente quand ça se touche, les chevauchements ne survivent pas.
   - RESSORT CUBIQUE `(d-rest)³/rest²` sur liens: mou près du repos, raide
     loin — déplie au lieu d'écraser.
   - MOMENTUM + ATAN par nœud + recentrage dur: le vivant sans l'explosion.
   `repulsion` règle la FR, `restBase/restSpan` le repos, `fac` l'amplitude.
   `rootLocalIndex` (optional): index local du sommet racine à maintenir fixe à (0,0). */
/* LES LIENS, EN INDEX LOCAUX, ET RÉSOLUS UNE SEULE FOIS.

   `frStep` relisait `byIndex.get(link.u)` et `byIndex.get(link.v)` à CHAQUE
   tour, pour chaque lien: deux recherches dans une `Map` de milliers d'entrées
   à chaque tour, alors que la correspondance sommet→index ne bouge jamais
   pendant la mise en page. Sur une chaîne de 3 000 sommets, ces 6 000
   recherches pèsent déjà autant que la grille spatiale entière.

   Elles sont donc résolues une fois et mémorisées sur le graphe — d'où le
   `WeakMap`: le cache ne doit pas garder un graphe en vie, il doit être
   ramassé avec lui. Trois tableaux typés plutôt qu'une liste d'objets,
   parce que la boucle de ressort les relit deux fois par sommet et par tour. */
const linkCache=new WeakMap()
function physicsLinks(graph,byIndex){
    const cached=linkCache.get(graph)
    if(cached&&cached.byIndex===byIndex) return cached
    const links=graph.links??[]
    const u=new Int32Array(links.length)
    const v=new Int32Array(links.length)
    const weight=new Float64Array(links.length)
    let kept=0
    for(let i=0;i<links.length;i++){
        const a=byIndex.get(links[i].u)
        const b=byIndex.get(links[i].v)
        if(a===undefined||b===undefined) continue
        u[kept]=a
        v[kept]=b
        weight[kept]=Number(links[i].weight)||0
        kept++
    }
    const table={byIndex,u,v,weight,count:kept}
    linkCache.set(graph,table)
    return table
}

/* UNE CELLULE VIDE, et une sentinelle qui ne peut pas être une coordonnée.
   `Math.floor(x/2k)` reste très loin de 2³¹-1 pour toute position atteignable,
   donc la valeur ne peut pas être prise pour une case réelle — et un tableau
   `Int32Array` s'initialise à 0, qui EST une coordonnée possible: sans cette
   sentinelle, toute case non occupée paraîtrait être la case (0,0). */
const EMPTY_CELL=0x7FFFFFFF

/* LA GRILLE DE RÉPULSION, EN TABLE DE HACHAGE À ADRESSAGE OUVERT.

   La version d'avant était une `Map` dont la clé était `cx*4096+cy`, et
   chaque sommet coûtait neuf `Map.get` par tour — une par case voisine. Sur
   3 000 sommets étalés, il y a près de 3 000 cases occupées, donc près de
   27 000 recherches dans une table de `Map` par tour: le premier poste de coût
   du moteur, avant même les paires.

   Ici la table est un `Int32Array` en adressage ouvert, les coordonnées de la
   case étant conservées à côté pour lever les collisions par égalité. Un
   `Int32Array` ne coûte rien à sonder là où une `Map` alloue, hascode et
   abandonne: le voisinage ne relit plus que des entiers, sans rien allouer. */
function gridProbe(cellX,cellY,mask,cx,cy){
    const slot=((cx*73856093)^(cy*19349663))&mask
    for(let step=0;;step++){
        const at=(slot+step)&mask
        const bx=cellX[at]
        if(bx===EMPTY_CELL) return at
        if(bx===cx&&cellY[at]===cy) return at
    }
}

/* LE SEMISAGE INITIAL, et il est écrit UNE FOIS pour les deux chemins.

   Le mode statique et le mode animé doivent partir du MÊME état, sinon un même
   réseau s'afficherait différemment selon celui des deux qui est choisi. C'est
   donc une fonction, et non deux copies — d'autant que le rayon dépend du
   nombre de sommets (voir le commentaire dans `layoutGroup`). */
export function seedPositions(positions,graph,count,ideal,rootLocalIndex){
    const seedRadius=Math.max(ideal,ideal*1.2*Math.sqrt(count/Math.PI))
    const rand=layoutRandom(layoutSeed(graph,count))
    for(let i=0;i<count;i++){
        if(i===rootLocalIndex) continue
        const radius=seedRadius*Math.sqrt(rand())
        const angle=2*Math.PI*rand()
        positions[i*2]=radius*Math.cos(angle)
        positions[i*2+1]=radius*Math.sin(angle)
    }
}

export function frStep(positions,velo,graph,byIndex,{k,worst,repulsion=1,restBase=1,restSpan=0,fac=null,rootLocalIndex=-1,temperature=Infinity,viscosity:viscosity_,springExponent=3,massBias=null,massForce=0,defectBias=null,defectForce=0,errorBias=null,errorForce=0,depthBias=null,depthForce=0}){
    const count=positions.length/2
    /* GRILLE SPATIALE: portée 2k, comme avant — au-delà ils s'ignorent. */
    const cutoff=2*k
    const cellSize=2*k
    /* La table est dimensionnée à 4× la population, soit un quart de
       remplissage: les collisions restent rares, et la taille étant une
       puissance de deux, le masque remplace la division. */
    let capacity=8
    while(capacity<count*4) capacity*=2
    const mask=capacity-1
    const head=new Int32Array(capacity).fill(-1)
    const cellX=new Int32Array(capacity).fill(EMPTY_CELL)
    const cellY=new Int32Array(capacity).fill(EMPTY_CELL)
    /* `next` PORTE LA LISTE des sommets d'une case: le premier est dans `head`,
       les suivants sont chaînés. Donc aucune liste, et donc aucune allocation
       par case et par tour — c'était le second poste de coût. */
    const next=new Int32Array(count).fill(-1)
    const cells=new Int32Array(capacity).fill(-1)
    let occupied=0
    for(let i=0;i<count;i++){
        const cx=Math.floor(positions[i*2]/cellSize)
        const cy=Math.floor(positions[i*2+1]/cellSize)
        const at=gridProbe(cellX,cellY,mask,cx,cy)
        if(cellX[at]===EMPTY_CELL){ cellX[at]=cx; cellY[at]=cy; cells[occupied++]=at }
        next[i]=head[at]
        head[at]=i
    }
    /* LES CASES, À PARCOURIR UNE SEULE FOIS chacune: `cells` ne contient que
       les cases OCCUPÉES, donc le balayage de voisinage ne parcourt plus trois
       mille cases vides par tour comme le faisait l'ancienne liste de buckets. */
    /* RÉPULSION FR toutes paires proches: fr=k²/d le long de l'axe.
       Accumule dans `velo` (momentum) — PAS appliqué brut, sinon explosion
       quand d→0. C'est l'atan qui plafonne, en bas. */
    const cutoffSquared=cutoff*cutoff
    const kSquared=k*k
    const repulsionK2=repulsion*k*k
    for(let c=0;c<occupied;c++){
        const at=cells[c]
        const cx=cellX[at]
        const cy=cellY[at]
        for(let dx=-1;dx<=1;dx++){
            for(let dy=-1;dy<=1;dy++){
                /* La case voisine est sondée par la MÊME fonction que
                   l'insertion, donc une collision est rejetée de la même façon:
                   une adresse occupied ici peut appartenir à une autre case,
                   et il ne faut pas la lire comme si c'était celle-ci. */
                const other=gridProbe(cellX,cellY,mask,cx+dx,cy+dy)
                if(cellX[other]===EMPTY_CELL) continue
                for(let i=head[at];i>=0;i=next[i]){
                    const xi=positions[i*2]
                    const yi=positions[i*2+1]
                    for(let j=head[other];j>=0;j=next[j]){
                        if(j<=i) continue
                        let rx=xi-positions[j*2]
                        let ry=yi-positions[j*2+1]
                        let squared=rx*rx+ry*ry
                        if(squared>cutoffSquared) continue
                        let distance=Math.sqrt(squared)
                        /* Même point: pousse au hasard d'un millième de k pour
                           lever l'indétermination — trop petit pour se voir. */
                        let ux,uy
                        if(distance<1e-6){
                            rx=(i%2?1:-1)*k*1e-3
                            ry=(j%2?1:-1)*k*1e-3
                            distance=Math.sqrt(rx*rx+ry*ry)
                            ux=rx/distance; uy=ry/distance
                        }else{
                            ux=rx/distance; uy=ry/distance
                        }
                        /* FR: k²/d le long de l'axe unitaire. */
                        const push=repulsionK2/distance/distance
                        velo[i*2]+=ux*push
                        velo[i*2+1]+=uy*push
                        velo[j*2]-=ux*push
                        velo[j*2+1]-=uy*push
                    }
                }
            }
        }
    }
    /* LES RESSORTS, sur les index DÉJÀ résolus — voir `physicsLinks`. */
    const springs=physicsLinks(graph,byIndex)
    const spring3=springExponent===3
    for(let e=0;e<springs.count;e++){
        const u=springs.u[e]
        const v=springs.v[e]
        const slack=Math.min(1,Math.max(0.02,springs.weight[e]/worst))
        const rest=k*(restBase+restSpan*slack)
        const rx=positions[u*2]-positions[v*2]
        const ry=positions[u*2+1]-positions[v*2+1]
        /* `Math.hypot` est CORRECT pour les très grands écarts, où `rx*rx`
           peut déborder — mais une position ici vaut quelques centaines, et
           `hypot` est dix fois plus lent que le produit puis la racine. Sur
           trois mille liens et deux mille tours, c'était le poste dominant. */
        const distance=Math.max(1e-6,Math.sqrt(rx*rx+ry*ry))
        /* CUBIQUE: (d-rest)³/rest² le long de l'axe — ton `(dis-R)^3`,
           normalisé par `rest²` pour garder des unités de longueur.
           SIGNE: `rx = u-v` pointe de v vers u; si d>rest (étiré), u doit
           revenir vers v donc `-ux*pull` avec pull>0. Ton Igor faisait
           `vitesse[k] += -rr*(d-R)^3` — pareil, le cube garde le signe. */
        const stretch=(distance-rest)/Math.max(1e-6,rest)
        /* L'EXPOSANT REND LE RESSORT RÉGLABLE, et `3` reste EXACTEMENT le
           calcul d'origine. On ne passe pas par `Math.pow` à 3: il n'est pas
           garanti identique à `x*x*x` au dernier bit, et la disposition par
           défaut doit rester rigoureusement celle d'avant — c'est elle que le
           test de déterminisme compare. Le produit est donc conservé tel quel,
           et `Math.pow` ne sert que pour les autres exposants.

           Un exposant plus bas rend le ressort plus MOU: la force croît moins
           vite avec l'écart. `1` est linéaire, donc jamais raide — le graphe
           s'affaisse et se tasse, ce qui va à l'encontre de ce qu'on cherche
           contre les chevauchements. `2` est le compromis raisonnable. */
        const shape=springExponent===3?stretch*stretch*stretch:Math.pow(stretch,springExponent)
        const pull=shape*distance
        const ux=rx/distance
        const uy=ry/distance
        velo[u*2]-=ux*pull
        velo[u*2+1]-=uy*pull
        velo[v*2]+=ux*pull
        velo[v*2+1]+=uy*pull
        /* Pas de répulsion bornée en plus ici: la FR ci-dessus s'applique déjà
           aux paires liées via la grille — comme ton `if(1)`. */
    }
    /* SATURATION PAR NŒUD: v/|v| * 2*atan(|v|)/pi * fac — ton `vv`, `velo`,
       `fac=0.1` ramené à l'échelle `k`: `fac=k*0.004` ≈ 0.1 à k=26.
       Le momentum est la vitesse saturée elle-même (pas de ×0.9: l'atan
       écrase déjà — un nœud qui allait vite repart de `fac` max). */
    /* LA FORCE DE MASSE, ET ELLE EST HORIZONTALE ET PROPORTIONNELLE.

       Un sommet tire vers la DROITE s'il est plus lourd que le milieu de son
       groupe, vers la GAUCHE s'il est plus léger. Le résultat est un gradient
       continu: pas un tri, mais les masses croissantes de gauche à droite, ce
       qui laisse la force de répulsion ordonner le reste sans qu'un seul pic
       soit épinglé à une coordonnée.

       Elle s'ajoute à l'ÉLAN et non à la position: elle passe donc par la même
       saturation `atan` et le même plafond de température que tout le reste,
       donc elle ne peut pas produire un pas plus grand que les autres. Injectée
       directement dans `positions`, elle Ignorerait les deux.

       `massForce` est sans dimension, relatif à `k`. À 0 le comportement est
       exactement celui d'avant. */
    if(massBias&&massForce>0){
        const push=massForce*k
        for(let i=0;i<count;i++){
            const bias=massBias[i]
            if(bias===0) continue
            velo[i*2]+=bias*push
        }
    }
    /* LA MÊME CHOSE VERTICALEMENT, et par le DÉFAUT DE MASSE. Comme
       `massForce`, elle passe par l'élan et non par la position, donc elle est
       bornée par la saturation et par la température comme tout le reste. */
    if(defectBias&&defectForce>0){
        const push=defectForce*k
        for(let i=0;i<count;i++){
            const bias=defectBias[i]
            if(bias===0) continue
            velo[i*2+1]+=bias*push
        }
    }
    /* ET LE MÊME PRINCIPE POUR L'ERREUR, en ordonnée. Comme les deux autres, elle
       passe par l'élan: bornée par la saturation et par la température, donc
       elle ne peut pas produire un pas plus grand que les ressorts. */
    if(errorBias&&errorForce>0){
        const push=errorForce*k
        for(let i=0;i<count;i++){
            const bias=errorBias[i]
            if(bias===0) continue
            velo[i*2+1]+=bias*push
        }
    }
    /* LA PROFONDEUR POUSSE VERS LE HAUT, ET SEULEMENT VERS LE HAUT.

       Une poussée RADIALE — vers l'extérieur dans toutes les directions — était
       la mauvaise physique: ce n'est pas une croissance d'arbre, c'est une
       répulsion. Elle s'auto-alimente: pousser dehors allonge les
       liens, ce qui étire les ressorts, qui repoussent encore plus loin, et la
       mise en page finit en fuite — mesuré, le rayon moyen multipliait par
       quatorze.

       Ce qu'on simule est une CROISSANCE: la racine en bas, les feuilles vers le
       haut. Donc une seule composante, l'ordonnée, et la racine épinglée en
       (0,0) fait le bas du dessin toute seule. L'abscisse reste libre — c'est
       elle qui accueille la masse, avec `massForce`, et les deux forces ne se
       disputent plus rien. */
    if(depthBias&&depthForce>0){
        const push=depthForce*k
        for(let i=0;i<count;i++){
            const bias=depthBias[i]
            if(bias===0) continue
            velo[i*2+1]+=bias*push
        }
    }
    fac=fac??k*0.004
    /* LA VISCOSITÉ, puis LA TEMPÉRATURE — les deux pertes d'énergie.

       La VISCOSITÉ multiplie l'élan par un facteur < 1 à chaque tour: c'est une
       fuite d'énergie franche, et elle est ce qui ramène le système vers un point
       fixe plutôt que de le laisser osciller.

       La TEMPÉRATURE borne ensuite le pas, comme l'annonçait le commentaire sur
       la répulsion (« c'est la température qui plafonne le pas, en bas »). Le
       plafond `fac` seul était une borne CONSTANTE: un sommet qui allait vite
       repartait donc à pleine vitesse indéfiniment, et `maxSpeed` ne pouvait pas
       décroître. Une température qui descend vers `tempEnd` rend le critère
       d'arrêt `maxSpeed<1e-7` atteignable, donc la boucle peut enfin finir.

       `temperature` infinie ou absente = pas de refroidissement, ce qui laisse
       le comportement d'avant si quelqu'un le demande explicitement. */
    const viscosity=Number.isFinite(viscosity_)?viscosity_:FOREST_VISCOSITY
    const ceiling=Number.isFinite(temperature)&&temperature>=0?Math.min(fac,temperature):fac
    /* L'ARRÊT EST FAIT EN RELATIF, et non sur un 1e-7 absolu.

       Les positions sont de l'ordre de la longueur du graphe — quelques
       centaines d'unités pour un groupe, des dizaines de milliers pour une
       chaîne longue. Un seuil ABSOLU de 1e-7 y est donc indécent : il ne peut
       être atteint qu'à l'arrêt du refroidissement, après deux mille tours, et
       il ne l'est qu'à la limite près. Le critère utile est « le sommet le plus
       rapide ne bouge plus que de `k` millièmes de k », ce qui se lit dans la
       même unité que la longueur au repos — donc la même valeur de convergence
       vaut pour deux pics et pour trois mille.

       C'est aussi ce qui rend la boucle DÉTERMINISTE : sur un critère physique,
       deux rendus du même graphe s'arrêtent au MÊME tour, alors que sur un
       plafond de temps ils s'arrêtent où le hasard de la machine les a
       interrompus — et le même réseau s'affichait alors différemment d'un
       rendu à l'autre. Le budget de temps reste, mais il n'est plus ce qui
       arrête normalement. */
    const stopSpeed=k*FOREST_SETTLE_RATIO
    let maxSpeed=0
    for(let i=0;i<count;i++){
        const vx=velo[i*2]*viscosity
        const vy=velo[i*2+1]*viscosity
        const speed=Math.sqrt(vx*vx+vy*vy)
        if(speed<1e-12){
            velo[i*2]=0
            velo[i*2+1]=0
            continue
        }
        const capped=Math.min(2*Math.atan(speed)/Math.PI*fac,ceiling)
        velo[i*2]=vx/speed*capped
        velo[i*2+1]=vy/speed*capped
        positions[i*2]+=velo[i*2]
        positions[i*2+1]+=velo[i*2+1]
        /* `velo` garde la partie saturée comme momentum — mais amorti par
           l'écrasement `atan`: un nœud qui allait vite repart de `fac` max,
           pas de sa vitesse brute. */
        if(capped>maxSpeed) maxSpeed=capped
    }
    /* RECENTRAGE DUR: obs -= bary — ton `sumcols(obs)/n`. */
    let bx=0,by=0
    for(let i=0;i<count;i++){ bx+=positions[i*2]; by+=positions[i*2+1] }
    bx/=Math.max(1,count); by/=Math.max(1,count)
    for(let i=0;i<count;i++){ positions[i*2]-=bx; positions[i*2+1]-=by }
    // Ensure root stays at (0,0) - pin it after physics step
    if(rootLocalIndex>=0&&rootLocalIndex<count){
        positions[rootLocalIndex*2]=0
        positions[rootLocalIndex*2+1]=0
        velo[rootLocalIndex*2]=0
        velo[rootLocalIndex*2+1]=0
    }
    return maxSpeed
}
/* LA MISE EN PLACE D'UN GROUPE, et c'est du FRUCHTERMAN–REINGOLD.
   Trois forces, et chacune répond à une question:
     — la RÉPULSION fr=k²/d empêche deux pics d'être superposés, portée 2k:
       au-delà ils ne se voient plus, sinon un groupe de mille sommets
       s'étale sans fin;
     — l'ATTRACTION fa=d²/k tire le long des liens, d'autant plus fort que
       l'erreur est faible — un lien à 0.05 Da serre, un lien à 0.48 Da reste
       lâche;
     — la GRAVITÉ douce retient les isolés sans aplatir les chaînes.
   L'ERREUR PILOTE LA LONGUEUR DU LIEN: la forme devient lisible sans lire un
   seul nombre. */
/* LA MISE EN PLACE D'UN GROUPE, façon `opimisation` d'Igor.
   Ressort cubique sur liens, répulsion bornée toutes paires, momentum +
   saturation atan par nœud, recentrage dur. Convergence quand la vitesse max
   passe sous 1e-7 — `iterations` n'est qu'un plafond de sécurité. */
function layoutGroup(graph,{iterations,ideal,repulsion=1,restBase=0.4,restSpan=0.6,gravity=0.005,tempStart=null,tempEnd=0,fac=null,budgetMs=FOREST_LAYOUT_BUDGET_MS,viscosity=FOREST_LAYOUT_DEFAULTS.viscosity,springExponent=FOREST_LAYOUT_DEFAULTS.springExponent,massForce=FOREST_LAYOUT_DEFAULTS.massForce,massBias=null,defectForce=FOREST_LAYOUT_DEFAULTS.defectForce,defectBias=null,errorForce=FOREST_LAYOUT_DEFAULTS.errorForce,errorBias=null,depthForce=FOREST_LAYOUT_DEFAULTS.depthForce,depthBias=null}={}){
    const count=graph.vertices.length
    const positions=new Float64Array(count*2)
    if(!count) return positions
    /* Trouver l'index local de la racine. */
    const rootLocalIndex=graph.vertices.findIndex(v=>v.index===graph.rootIndex)
    /* LE NUAGE INITIAL EST TIRÉ AU SORT, ET PLUS POSÉ SUR UN CERCLE.

       Le cercle rangeait les sommets par masse angulaire — le plus léger en
       tête — ce qui était déterministe, mais concentrait toute la population sur
       une courbe: les premiers tours les empilaient tous dans la MÊME case de
       la grille de répulsion, et le coût d'un tour était donc quadratique.

       `sqrt(rand())` et non `rand()`: c'est ce qui rend le tirage UNIFORME en
       surface — sans le racine, les points se massent au centre.

       Le tirage reste à GRAINE (voir `layoutRandom`): le même réseau repart du
       même nuage à chaque rendu, sans quoi deux réseaux cesseraient d'être
       comparables.

       ET SON RAYON EST CELUI DU GROUPE, PAS CELUI D'UN PIC.

       Un disque de rayon `ideal`, quelle que soit la population, écrit que
       trois mille sommets tiennent dans la place d'un seul: ils s'y entassent
       à la densité d'équilibre même, et la grille de répulsion voit alors
       n²/2 paires par tour. Mesuré sur une chaîne de 3 000 : le PREMIER tour
       coûtait 111 ms et les vingt premiers, 1,5 s sur 3,7 s au total — le
       quart du temps du moteur passé à ouvrir un nuage déjà ouvert.

       Le disque de départ est donc celui que le groupe OCCUPE à l'équilibre:
       rayon `k·√(n/π)`, la surface qui laisse `k²` par sommet — exactement la
       distance au repos d'un lien. La densité de départ est alors celle de
       l'arrivée, donc le coût d'un tour est linéaire dès le premier. Un
       coefficient de 1,2 laisse la marge nécessaire pour qu'une grappe
       aléatoire ne s'y forme pas; en dessous de `ideal`, on retombe sur
       l'ancien rayon, ce qui préserve exactement le cas des petits groupes. */
    seedPositions(positions,graph,count,ideal,rootLocalIndex)
    if(count===1) return positions
    /* LA PLUS FORTE ERREUR DU GROUPE, et elle fixe l'échelle. La comparer à
       l'erreur MOYENNE — ou à la médiane — écraserait le groupe contre son
       lien le plus faible dès qu'un seul pic est absurde, et un groupe est
       précisément ce qui doit rester lisible. */
    const worst=graph.links.reduce((n,link)=>Math.max(n,link.weight||0),0)||1
    const byIndex=new Map(graph.vertices.map((vertex,index)=>[vertex.index,index]))
    /* `vitesse=0` — ton `vitesse=0`: le momentum part de zéro et accumule. */
    const velo=new Float64Array(count*2)
    if(!massBias) massBias=massBiasOf(graph.vertices)
    /* LE NOMBRE DE TOURS, et il est DÉTERMINISTE.

       C'est `layoutRoundsFor`, calculé sur la seule taille du groupe — donc le
       même groupe s'arrête au même tour sur n'importe quelle machine. La
       boucle physique s'arrête plus haut si elle converge (`maxSpeed`), mais le
       plafond n'est plus une mesure de temps: c'était précisément ce qui
       faisait qu'un même réseau s'affichait différemment d'un rendu à l'autre,
       et qui faisait échouer le test de déterminisme. */
    const started=performance.now()
    const rounds=Math.min(iterations,layoutRoundsFor(count,graph.links.length))
    /* La température de DÉPART vaut la moitié de `ideal` quand on ne la donne
       pas: c'est le pas initial maximal, assez pour ouvrir un nuage tiré au
       sort sans le disperser hors du cadre d'un tour. */
    const tempFrom=Number.isFinite(tempStart)?tempStart:ideal*0.5
    const tempTo=Number.isFinite(tempEnd)?tempEnd:0
    for(let round=0;round<rounds;round++){
        const maxSpeed=frStep(positions,velo,graph,byIndex,{
            k:ideal,worst,repulsion,restBase,restSpan,fac,viscosity,rootLocalIndex,springExponent,massBias,massForce,defectBias,defectForce,errorBias,errorForce,depthBias,depthForce,
            temperature:layoutTemperature(round,tempFrom,tempTo)
        })
        /* `while(wavemax(vitesse)>seuil)` — ton critère d'arrêt, rendu RELATIF
           à `k` par `FOREST_SETTLE_RATIO`: voir la constante. */
        if(maxSpeed<ideal*FOREST_SETTLE_RATIO) break
        /* LE FILET, et il ne devrait jamais mordre. Un tour coûte O(sommets):
           si un seul tour dépasse le budget, il n'y a pas de position
           intermédiaire où s'arrêter proprement — et le filet existe justement
           pour ne pas laisser le thread se figer sur un groupe qui n'en finit
           pas. C'est le SEUL endroit où le rendu dépend de la vitesse de la
           machine, et il ne s'atteint que pour un groupe bien plus grand que
           ceux que le panneau affiche. `Infinity` = pas de filet du tout. */
        if(budgetMs<Infinity&&performance.now()-started>budgetMs) break
    }
    return positions
}

/* CRÉE UN ÉTAT DE LAYOUT ANIMÉ — pour pilotage par requestAnimationFrame.
   `velo` accumule comme ton `vitesse` (jamais remis à zéro); la boucle
   s'arrête sur `maxSpeed<1e-7`, `iterations` n'est qu'un plafond. */
export function createAnimatedLayout(graph,{iterations=FOREST_LAYOUT_DEFAULTS.iterations,ideal=FOREST_LAYOUT_DEFAULTS.ideal,repulsion=FOREST_LAYOUT_DEFAULTS.repulsion,restBase=FOREST_LAYOUT_DEFAULTS.restBase,restSpan=FOREST_LAYOUT_DEFAULTS.restSpan,gravity=FOREST_LAYOUT_DEFAULTS.gravity,tempStart=FOREST_LAYOUT_DEFAULTS.tempStart,tempEnd=FOREST_LAYOUT_DEFAULTS.tempEnd,fac=FOREST_LAYOUT_DEFAULTS.fac,viscosity=FOREST_LAYOUT_DEFAULTS.viscosity,springExponent=FOREST_LAYOUT_DEFAULTS.springExponent,massForce=FOREST_LAYOUT_DEFAULTS.massForce,defectForce=FOREST_LAYOUT_DEFAULTS.defectForce,errorForce=FOREST_LAYOUT_DEFAULTS.errorForce,depthForce=FOREST_LAYOUT_DEFAULTS.depthForce}={}){
    const count=graph.vertices.length
    const positions=new Float64Array(count*2)
    if(!count) return {positions,done:true,totalIterations:0}
    /* Trouver l'index local de la racine. */
    const rootLocalIndex=graph.vertices.findIndex(v=>v.index===graph.rootIndex)
    /* Le nuage initial est TIRÉ AU SORT comme dans `layoutGroup`, avec la même
       graine dérivée du graphe: les deux chemins — statique et animé — doivent
       partir du même état, sinon un même réseau s'afficherait différemment selon
       lequel des deux est choisi. */
    seedPositions(positions,graph,count,ideal,rootLocalIndex)
    if(count===1) return {positions,done:true,totalIterations:0,rootLocalIndex}
    const worst=graph.links.reduce((n,link)=>Math.max(n,link.weight||0),0)||1
    const byIndex=new Map(graph.vertices.map((vertex,index)=>[vertex.index,index]))
    return {
        positions,
        velo:new Float64Array(count*2),
        iteration:0,
        totalIterations:iterations,
        ideal,
        worst,
        byIndex,
        count,
        graph,
        repulsion,
        restBase,
        restSpan,
        fac,
        rootLocalIndex,
        /* La température est portée par l'ÉTAT, pas recalculée : c'est elle qui
           doit descendre au fil des frames. `tempFrom` vaut la moitié de `ideal`
           quand on ne donne rien, comme dans `layoutGroup`. */
        tempFrom:Number.isFinite(tempStart)?tempStart:ideal*0.5,
        tempTo:Number.isFinite(tempEnd)?tempEnd:0,
springExponent,
        massBias:massBiasOf(graph.vertices),
        defectBias:defectBiasOf(graph.vertices),
        massForce,
        defectForce,
        errorForce,
        depthForce,
        depthBias:depthBiasOf(graph.vertices,graph.links,graph.rootIndex),        errorBias:errorBiasOf(graph.vertices,graph.links),        viscosity:viscosity,
        done:false
    }
}

/* AVANCE LE LAYOUT D'UN NOMBRE D'ÉTAPES (par défaut 1).
   Retourne true si le déplacement maximal passe sous `k`/10 000
   (FOREST_SETTLE_RATIO) ou si le plafond est atteint. */
export function advanceLayout(state,steps=1){
    if(state.done) return true
    const {positions,velo,totalIterations,ideal,worst,byIndex,rootLocalIndex}=state
    if(!state.graph) { state.done=true; return true }
    const repulsion=state.repulsion??1
    const restBase=state.restBase??0.4
    const restSpan=state.restSpan??0.6
    const fac=state.fac??null
    for(let s=0;s<steps;s++){
        const round=state.iteration++
        if(round>=totalIterations){
            state.done=true
            return true
        }
        const maxSpeed=frStep(positions,velo,state.graph,byIndex,{
            k:ideal,worst,repulsion,restBase,restSpan,fac,rootLocalIndex,
            /* LA MÊME PHYSIQUE QUE LE MODE STATIQUE. Sans la température ici, le
               mode animé plafonnait toujours par `fac`, constant: c'était lui —
               et non le mode statique — que mon test de convergence mesurait, et
               il ne convergait donc pas, alors que le chemin statique, lui, était
               déjà refroidi. Les deux doivent être le même calcul. */
            temperature:layoutTemperature(round,state.tempFrom,state.tempTo),
            viscosity:state.viscosity,
            springExponent:state.springExponent,
            massBias:state.massBias,
            massForce:state.massForce,
            defectForce:state.defectForce,
            defectBias:state.defectBias,
            errorForce:state.errorForce,
            errorBias:state.errorBias,
            depthForce:state.depthForce,
            depthBias:state.depthBias
        })
        if(maxSpeed<ideal*FOREST_SETTLE_RATIO){
            state.done=true
            return true
        }
    }
    return state.done
}

/* TRANSFORME UN ÉTAT ANIMÉ EN RÉSULTAT FINAL compatible avec layoutForests. */
export function finalizeAnimatedLayout(state){
    const {positions,ideal,count,graph}=state
    let minX=Infinity,maxX=-Infinity,minY=Infinity,maxY=-Infinity
    for(let i=0;i<count;i++){
        minX=Math.min(minX,positions[i*2])
        maxX=Math.max(maxX,positions[i*2])
        minY=Math.min(minY,positions[i*2+1])
        maxY=Math.max(maxY,positions[i*2+1])
    }
    if(!Number.isFinite(minX)){ minX=0; maxX=0; minY=0; maxY=0 }
    return {
        graph,
        positions,
        minX,
        minY,
        w:Math.max(1e-6,maxX-minX),
        h:Math.max(1e-6,maxY-minY)
    }
}


/* LA MISE EN PAGE DES GROUPES, et c'est une GRILLE À CASES ET NON UNE VAGUE.

   Les groupes n'ont pas la même taille: il y a un composant de quatre cents pics
   et six composants de deux. Les poser en grille régulière leur donne la même
   place, donc le petit groupe devient un point invisible au milieu d'un carré
   vide — et c'est le petit groupe qu'on veut voir, parce que c'est là qu'une
   attribution est facile à vérifier.

   ALORS CHACUN REÇOIT SA CELLULE, dans une grille dont on choisit la largeur.
   La grille est `columns` colonnes et autant de lignes qu'il faut: c'est la
   seule disposition qui tienne sur une largeur donnée sans mesurer quoi que ce
   soit, et elle est STABLE — ajouter un groupe décale ceux qui suivent, mais ne
   redimensionne aucun de ceux qui précèdent. Une disposition dont la taille
   dépend du nombre de groupes ferait sautiller tout le graphique à chaque
   réseau. */
export function layoutForests(graphs,{width=800,height=400,gap=8,margin=6,columns=0,iterations=FOREST_LAYOUT_DEFAULTS.iterations,ideal=FOREST_LAYOUT_DEFAULTS.ideal,repulsion=FOREST_LAYOUT_DEFAULTS.repulsion,restBase=FOREST_LAYOUT_DEFAULTS.restBase,restSpan=FOREST_LAYOUT_DEFAULTS.restSpan,gravity=FOREST_LAYOUT_DEFAULTS.gravity,tempStart=FOREST_LAYOUT_DEFAULTS.tempStart,tempEnd=FOREST_LAYOUT_DEFAULTS.tempEnd,fac=FOREST_LAYOUT_DEFAULTS.fac,viscosity=FOREST_LAYOUT_DEFAULTS.viscosity,budgetMs=FOREST_LAYOUT_BUDGET_MS,springExponent=FOREST_LAYOUT_DEFAULTS.springExponent,massForce=FOREST_LAYOUT_DEFAULTS.massForce,defectForce=FOREST_LAYOUT_DEFAULTS.defectForce,errorForce=FOREST_LAYOUT_DEFAULTS.errorForce,depthForce=FOREST_LAYOUT_DEFAULTS.depthForce}={}){
    const list=(graphs??[]).filter(graph=>(graph?.vertices?.length??0)>0)
    if(!list.length) return {width,height,groups:[],columns:0,rows:0}
    const span=width-2*margin
    const spanHeight=height-2*margin
    /* UNE COLONNE PAR DÉFAUT pour un groupe, et une grille carrée pour beaucoup.
       Le nombre de colonnes est borné par la largeur: une colonne de moins de
       90 px ne perdrait plus ses groupes, elle les rognerait. */
    const fit=Math.max(1,Math.floor(span/90))
    const cols=Math.max(1,Math.min(fit,columns>0?columns:Math.ceil(Math.sqrt(list.length))))
    const rows=Math.ceil(list.length/cols)
    const cellWidth=(span-(cols-1)*gap)/cols
    const cellHeight=(spanHeight-(rows-1)*gap)/rows
    /* LE PLUS GRAND GROUPE REMPLIT SA CASE, et tous les autres sont ramenés à
       LA MÊME ÉCHELLE — celle du plus grand. Une échelle par groupe ferait d'un
       groupe de deux pics une tache qui occupe toute sa case: on perdrait
       exactement l'information qu'on est venu chercher, savoir qu'il est petit. */
    /* LE FILET DE TEMPS EST PARTAGÉ PAR TOUS LES GROUPES, et il ne sert plus
       qu'à cela.

       Un budget par groupe se multipliait: cinq arbres de 2 000 sommets
       coûtaient cinq fois le budget, donc toujours un gel. L'échéance est
       calculée UNE fois ici, et chaque groupe reçoit le TEMPS RESTANT — mais
       ce n'est plus qu'un garde-fou: le nombre de tours de chaque groupe est
       désormais fixé par sa taille (voir `layoutRoundsFor`), donc l'échéance ne
       change rien à l'image rendue tant qu'elle ne mord pas. Un même lot de
       groupes rend donc la même image d'un clic à l'autre, quel que soit le
       nombre de groupes affiché. */
    const deadline=performance.now()+budgetMs
    const placed=list.map(graph=>{
        const remaining=Math.max(0,deadline-performance.now())
        const positions=layoutGroup(graph,{iterations,ideal,repulsion,restBase,restSpan,gravity,tempStart,tempEnd,fac,viscosity,budgetMs:remaining,springExponent,massForce,massBias:massBiasOf(graph.vertices),defectForce,defectBias:defectBiasOf(graph.vertices),errorForce,errorBias:errorBiasOf(graph.vertices,graph.links),depthForce,depthBias:depthBiasOf(graph.vertices,graph.links,graph.rootIndex)})
        let minX=Infinity
        let maxX=-Infinity
        let minY=Infinity
        let maxY=-Infinity
        for(let i=0;i<graph.vertices.length;i++){
            minX=Math.min(minX,positions[i*2])
            maxX=Math.max(maxX,positions[i*2])
            minY=Math.min(minY,positions[i*2+1])
            maxY=Math.max(maxY,positions[i*2+1])
        }
        if(!Number.isFinite(minX)){ minX=0; maxX=0; minY=0; maxY=0 }
        return {
            graph,
            positions,
            minX,
            minY,
            w:Math.max(1e-6,maxX-minX),
            h:Math.max(1e-6,maxY-minY)
        }
    })
    const widest=placed.reduce((n,entry)=>Math.max(n,entry.w),0)||1
    const tallest=placed.reduce((n,entry)=>Math.max(n,entry.h),0)||1
    const scale=Math.min(cellWidth/widest,cellHeight/tallest)
    const groups=placed.map((entry,index)=>{
        const column=index%cols
        const row=Math.floor(index/cols)
        /* LA CELLULE EST CENTRÉE DANS SA CASE: un groupe étroit pose son centre
           au milieu de la case, donc les pics isolés restent au milieu de leur
           colonne au lieu de coller au bord de l'écran. */
        const cellX=margin+column*(cellWidth+gap)
        const cellY=margin+row*(cellHeight+gap)
        const drawWidth=entry.w*scale
        const drawHeight=entry.h*scale
        const offsetX=cellX+(cellWidth-drawWidth)/2
        const offsetY=cellY+(cellHeight-drawHeight)/2
const points=entry.graph.vertices.map((vertex,i)=>({
            index:vertex.index,
            mass:vertex.mass,
            intensity:vertex.intensity,
            x:offsetX+(entry.positions[i*2]-entry.minX)*scale,
            y:offsetY+(entry.positions[i*2+1]-entry.minY)*scale
        }))
        const xs=points.map(point=>point.x)
        const ys=points.map(point=>point.y)
        return {
rank:entry.graph.rank,
            size:entry.graph.size,
            points,
            box:{
                x:Math.min(...xs),y:Math.min(...ys),
                width:Math.max(...xs)-Math.min(...xs),
                height:Math.max(...ys)-Math.min(...ys)
            }
        }
    })
    return {width,height,groups,columns:cols,rows}
}

/* APPLIQUE LA MISE EN PAGE GRILLE AUX ENTRÉES PLACÉES.
   Prend les entrées de `finalizeAnimatedLayout` (qui ont graph, positions, minX, minY, w, h)
   et applique la même logique de grille que `layoutForests`:
   - calcule l'échelle pour que le plus grand groupe remplisse sa case
   - positionne chaque groupe dans sa cellule avec offsetX/offsetY
   - retourne les groups avec `points` en coordonnées écran. */
export function applyGridLayout(placed,{width=800,height=400,gap=8,margin=6,columns=0}={}){
    const list=placed.filter(e=>e.graph.vertices.length>0)
    if(!list.length) return {width,height,groups:[],columns:0,rows:0}
    const span=width-2*margin
    const spanHeight=height-2*margin
    const fit=Math.max(1,Math.floor(span/90))
    const cols=Math.max(1,Math.min(fit,columns>0?columns:Math.ceil(Math.sqrt(list.length))))
    const rows=Math.ceil(list.length/cols)
    const cellWidth=(span-(cols-1)*gap)/cols
    const cellHeight=(spanHeight-(rows-1)*gap)/rows
    const widest=placed.reduce((n,entry)=>Math.max(n,entry.w),0)||1
    const tallest=placed.reduce((n,entry)=>Math.max(n,entry.h),0)||1
    const scale=Math.min(cellWidth/widest,cellHeight/tallest)
    const groups=placed.map((entry,index)=>{
        const column=index%cols
        const row=Math.floor(index/cols)
        const cellX=margin+column*(cellWidth+gap)
        const cellY=margin+row*(cellHeight+gap)
        const drawWidth=entry.w*scale
        const drawHeight=entry.h*scale
        const offsetX=cellX+(cellWidth-drawWidth)/2
        const offsetY=cellY+(cellHeight-drawHeight)/2
        const points=entry.graph.vertices.map((vertex,i)=>({
            index:vertex.index,
            mass:vertex.mass,
            intensity:vertex.intensity,
            x:offsetX+(entry.positions[i*2]-entry.minX)*scale,
            y:offsetY+(entry.positions[i*2+1]-entry.minY)*scale
        }))
        const xs=points.map(point=>point.x)
        const ys=points.map(point=>point.y)
        return {
            rank:entry.graph.rank,
            size:entry.graph.size,
            points,
            box:{
                x:Math.min(...xs),y:Math.min(...ys),
                width:Math.max(...xs)-Math.min(...xs),
                height:Math.max(...ys)-Math.min(...ys)
            }
        }
    })
    return {width,height,groups,columns:cols,rows}
}
