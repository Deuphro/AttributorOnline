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

export const FOREST_LAYOUT_DEFAULTS={iterations:1e9,ideal:26,repulsion:1,restBase:1,restSpan:0,gravity:0,tempStart:null,tempEnd:0.5,fac:2}

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
    const bricks=plan.items.filter(item=>item.kind==="combining"&&item.atomicMass>0)
    if(!bricks.length){
        diagnostics.push("no combining group produced a mass, so no pair of peaks can be linked")
    }
    if(plan.items.some(item=>item.kind==="ionising")){
        diagnostics.push("adducts are not used as references: they carry a charge, not a mass increment")
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
    /* LA COUPURE: au-delà de la plus grosse référence, plus aucun écart ne peut
       être atteint, et les masses étant triées tous les suivants non plus. */
    const reach=references[references.length-1].mass+tolerance

    const candidates=[]
    for(let k=0;k<n;k++){
        const low=masses[k]
        if(!Number.isFinite(low)) continue
        for(let j=k+1;j<n;j++){
            const gap=masses[j]-low
            if(!(gap<=reach)) break
            const found=nearestReference(references,gap)
            if(found&&found.error<tolerance){
                candidates.push({weight:found.error,u:k,v:j,std:found.index})
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
                isRoot:index===component.root
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
    let best=candidates[0]??usable[0]
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
   `repulsion` règle la FR, `restBase/restSpan` le repos, `fac` l'amplitude. */
function frStep(positions,velo,graph,byIndex,{k,worst,repulsion=1,restBase=1,restSpan=0,fac=null}){
    const count=positions.length/2
    /* GRILLE SPATIALE: portée 2k, comme avant — au-delà ils s'ignorent.
       Clés NUMÉRIQUES `cx*4096+cy`, pas des strings: `cellOf` + `split` +
       template coûtaient plus cher que la physique elle-même. */
    const cutoff=2*k
    const cellSize=2*k
    const GRID_N=4096
    const grid=new Map()
    const cellCoords=index=>[
        Math.floor(positions[index*2]/cellSize),
        Math.floor(positions[index*2+1]/cellSize)]
    const cellKey=(cx,cy)=>(cx%GRID_N+GRID_N)%GRID_N*GRID_N+((cy%GRID_N+GRID_N)%GRID_N)
    const buckets=[]
    for(let i=0;i<count;i++){
        const [cx,cy]=cellCoords(i)
        const key=cellKey(cx,cy)
        let bucket=grid.get(key)
        if(!bucket){ bucket={cx,cy,list:[]}; grid.set(key,bucket); buckets.push(bucket) }
        bucket.list.push(i)
    }
    /* RÉPULSION FR toutes paires proches: fr=k²/d le long de l'axe.
       Accumule dans `velo` (momentum) — PAS appliqué brut, sinon explosion
       quand d→0. C'est l'atan qui plafonne, en bas. */
    for(const bucket of buckets){
        const {cx,cy}=bucket
        for(let dx=-1;dx<=1;dx++){
            for(let dy=-1;dy<=1;dy++){
                const other=grid.get(cellKey(cx+dx,cy+dy))
                if(!other) continue
                for(const i of bucket.list){
                    for(const j of other.list){
                        if(j<=i) continue
                        let rx=positions[i*2]-positions[j*2]
                        let ry=positions[i*2+1]-positions[j*2+1]
                        let distance=rx*rx+ry*ry
                        if(distance>cutoff*cutoff) continue
                        distance=Math.sqrt(distance)
                        /* Même point: pousse au hasard d'un millième de k pour
                           lever l'indétermination — trop petit pour se voir. */
                        let ux,uy
                        if(distance<1e-6){
                            rx=(i%2?1:-1)*k*1e-3
                            ry=(j%2?1:-1)*k*1e-3
                            distance=Math.hypot(rx,ry)
                            ux=rx/distance; uy=ry/distance
                        }else{
                            ux=rx/distance; uy=ry/distance
                        }
                        /* FR: k²/d le long de l'axe unitaire — sans 2e hypot. */
                        const push=repulsion*k*k/distance/distance
                        velo[i*2]+=ux*push
                        velo[i*2+1]+=uy*push
                        velo[j*2]-=ux*push
                        velo[j*2+1]-=uy*push
                    }
                }
            }
        }
    }
    for(const link of graph.links){
        const u=byIndex.get(link.u)
        const v=byIndex.get(link.v)
        if(u===undefined||v===undefined) continue
        const slack=Math.min(1,Math.max(0.02,(link.weight||0)/worst))
        const rest=k*(restBase+restSpan*slack)
        const rx=positions[u*2]-positions[v*2]
        const ry=positions[u*2+1]-positions[v*2+1]
        const distance=Math.max(1e-6,Math.hypot(rx,ry))
        /* CUBIQUE: (d-rest)³/rest² le long de l'axe — ton `(dis-R)^3`,
           normalisé par `rest²` pour garder des unités de longueur.
           SIGNE: `rx = u-v` pointe de v vers u; si d>rest (étiré), u doit
           revenir vers v donc `-ux*pull` avec pull>0. Ton Igor faisait
           `vitesse[k] += -rr*(d-R)^3` — pareil, le cube garde le signe. */
        const stretch=(distance-rest)/Math.max(1e-6,rest)
        const pull=stretch*stretch*stretch*distance
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
    fac=fac??k*0.004
    let maxSpeed=0
    for(let i=0;i<count;i++){
        const vx=velo[i*2]
        const vy=velo[i*2+1]
        const speed=Math.hypot(vx,vy)
        if(speed<1e-9) continue
        const capped=2*Math.atan(speed)/Math.PI*fac
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
function layoutGroup(graph,{iterations,ideal,repulsion=1,restBase=0.4,restSpan=0.6,gravity=0.005,tempStart=null,tempEnd=0.5,fac=null}){
    const count=graph.vertices.length
    const positions=new Float64Array(count*2)
    if(!count) return positions
    /* LE CERCLE INITIAL, rangé par masse — donc le plus léger en tête, et les
       sommets déjà dans l'ordre où le réseau les a construits. */
    for(let i=0;i<count;i++){
        const angle=2*Math.PI*i/count
        positions[i*2]=ideal*Math.cos(angle)
        positions[i*2+1]=ideal*Math.sin(angle)
    }
    if(count===1) return positions
    /* LA PLUS FORTE ERREUR DU GROUPE, et elle fixe l'échelle. La comparer à
       l'erreur MOYENNE — ou à la médiane — écraserait le groupe contre son
       lien le plus faible dès qu'un seul pic est absurde, et un groupe est
       précisément ce qui doit rester lisible. */
    const worst=graph.links.reduce((n,link)=>Math.max(n,link.weight||0),0)||1
    const byIndex=new Map(graph.vertices.map((vertex,index)=>[vertex.index,index]))
    /* `vitesse=0` — ton `vitesse=0`: le momentum part de zéro et accumule. */
    const velo=new Float64Array(count*2)
    for(let round=0;round<iterations;round++){
        const maxSpeed=frStep(positions,velo,graph,byIndex,{k:ideal,worst,repulsion,restBase,restSpan,fac})
        /* `while(wavemax(vitesse)>1e-7)` — ton critère d'arrêt. */
        if(maxSpeed<1e-7) break
    }
    return positions
}

/* CRÉE UN ÉTAT DE LAYOUT ANIMÉ — pour pilotage par requestAnimationFrame.
   `velo` accumule comme ton `vitesse` (jamais remis à zéro); la boucle
   s'arrête sur `maxSpeed<1e-7`, `iterations` n'est qu'un plafond. */
export function createAnimatedLayout(graph,{iterations=FOREST_LAYOUT_DEFAULTS.iterations,ideal=FOREST_LAYOUT_DEFAULTS.ideal,repulsion=FOREST_LAYOUT_DEFAULTS.repulsion,restBase=FOREST_LAYOUT_DEFAULTS.restBase,restSpan=FOREST_LAYOUT_DEFAULTS.restSpan,gravity=FOREST_LAYOUT_DEFAULTS.gravity,tempStart=FOREST_LAYOUT_DEFAULTS.tempStart,tempEnd=FOREST_LAYOUT_DEFAULTS.tempEnd,fac=FOREST_LAYOUT_DEFAULTS.fac}={}){
    const count=graph.vertices.length
    const positions=new Float64Array(count*2)
    if(!count) return {positions,done:true,totalIterations:0}
    for(let i=0;i<count;i++){
        const angle=2*Math.PI*i/count
        positions[i*2]=ideal*Math.cos(angle)
        positions[i*2+1]=ideal*Math.sin(angle)
    }
    if(count===1) return {positions,done:true,totalIterations:0}
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
        done:false
    }
}

/* AVANCE LE LAYOUT D'UN NOMBRE D'ÉTAPES (par défaut 1).
   Retourne true si `maxSpeed<1e-7` (ton `wavemax`) ou le plafond atteint. */
export function advanceLayout(state,steps=1){
    if(state.done) return true
    const {positions,velo,totalIterations,ideal,worst,byIndex}=state
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
        const maxSpeed=frStep(positions,velo,state.graph,byIndex,{k:ideal,worst,repulsion,restBase,restSpan,fac})
        if(maxSpeed<1e-7){
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
export function layoutForests(graphs,{width=800,height=400,gap=8,margin=6,columns=0,iterations=FOREST_LAYOUT_DEFAULTS.iterations,ideal=FOREST_LAYOUT_DEFAULTS.ideal,repulsion=FOREST_LAYOUT_DEFAULTS.repulsion,restBase=FOREST_LAYOUT_DEFAULTS.restBase,restSpan=FOREST_LAYOUT_DEFAULTS.restSpan,gravity=FOREST_LAYOUT_DEFAULTS.gravity,tempStart=FOREST_LAYOUT_DEFAULTS.tempStart,tempEnd=FOREST_LAYOUT_DEFAULTS.tempEnd,fac=FOREST_LAYOUT_DEFAULTS.fac}={}){
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
    const placed=list.map(graph=>{
        const positions=layoutGroup(graph,{iterations,ideal,repulsion,restBase,restSpan,gravity,tempStart,tempEnd,fac})
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
            x:offsetX+(entry.positions[i*2]-entry.minX)*scale,
            y:offsetY+(entry.positions[i*2+1]-entry.minY)*scale
        }))
        const xs=points.map(point=>point.x)
        const ys=points.map(point=>point.y)
        return {
            rank:entry.graph.rank,
            size:entry.graph.size,
            points,
            /* LA BOÎTE, et elle sert à deux choses: savoir si un sommet est
               visible, et savoir où cliquer dessus. Elle est calculée ICI et non
               relue au dessin, parce qu'un dessin qui recalcule son échelle est
               un dessin qui n'en a qu'une. */
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
