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
    return {masses,labels,charge:divisor,diagnostics}
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