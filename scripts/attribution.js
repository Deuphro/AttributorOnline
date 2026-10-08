/* =========================================================================
   attribution.js — le moteur d'ATTRIBUTION, hors du DOM.

   Ce que fait un nœud d'attribution, en une phrase: étant donné deux listes
   de formules — les GROUPES À COMBINER et les GROUPES IONISANTS AUTORISÉS —
   et un spectre, il énumère TOUTES les combinaisons de ces groupes dont la
   masse tombe dans la fenêtre, puis dit pour chacune à quel point du spectre
   elle se rattache et à combien de ppm.

   L'ORACLE, c'est le code Igor de la thèse: crible1..10 et surtout
   trouvemass (resources/ProcAttributorLegacy/MainProc.ipf). Celui-ci énumérait
   les combinaisons de `perm` en base mixte et comblait le reste avec LA MASSE LA
   PLUS FAIBLE, ce qui l'exemptait d'explorer les masses nobles proches. On
   garde son idée — un crible exhaustif, pas un tirage — et on supprime le
   comblement: ici la fenêtre doit être couverte ENTIÈREMENT.

   DEUX LISTES, ET POURQUOI CE SONT DEUX.
   Les groupes à combiner portent de la MASSE et aucune charge: ce sont les
   briques du squelette (CH2, O, NH...). Les groupes ionisants portent une
   CHARGE et sont l'adduit (H+, Na+, 2+...). On les compte ensemble parce que
   la masse est additive dans les deux cas, mais la charge n'est portée que par
   la seconde liste — et c'est elle qui décide du m/z final, donc de la fenêtre.

   POURQUOI UN TAS, ET POURQUOI SANS DOUBLON.
   Le crible est une marche en meilleur-premier sur les VECTEURS D'INDICES: on
   part du vecteur nul et on incrémente UN indice à la fois, en sortant toujours
   le plus léger. Chaque multiensemble a donc un parent, et le tas les rend par
   masse croissante — ce que la consigne demande.

   Le doublon, en revanche, se règle SANS `Set`. On n'autorise à incrémenter
   l'indice i que si TOUS les indices > i sont nuls: chaque multiensemble
   devient atteignable par un seul chemin, celui qui ajoute les indices dans
   l'ordre croissant. Un `seen` coûte une chaîne par état — intenable quand on
   en énumère des millions — alors que cette règle coûte un entier.
   ========================================================================= */
import {Formula,Stoichiometry} from "./chemistry.js"

/* LA TOLÉRANCE DU PLANCHER, en unités de masse.

   Elle rend le plancher une FRONTIÈRE et non un mur: une formule posée dessus
   est dans la fenêtre. Un proton pèse 1.007276 et un pic mesuré à 1.00728, donc
   l'écart est de quatre milli-millionièmes — invisible partout ailleurs, et
   suffisant pour exclure l'exacte formule que le pic désigne.

   Elle est ABSOLUE et non proportionnelle. Proportionnelle au pic, elle
   dépendrait du pic: deux spectres de la même molécule donneraient deux listes
   différentes, ce qui n'est pas un plancher mais une instabilité. En unités de
   masse, elle veut dire la même chose partout, et 1e-3 est assez large pour
   couvrir l'arrondi d'un m/z instrument sans jamais laisser entrer une formule
   d'un Dalton en dessous. */
const MASS_FLOOR_TOLERANCE=1e-3

/* La masse ATOMIQUE d'une composition: la somme des masses d'atomes NEUTRES.

   Volontairement sans correction d'électron. Dans tout ce fichier une masse est
   « la somme de ce qu'on a posé », et le manque de l'électron n'est appliqué
   qu'UNE fois, à la fin, quand le m/z est calculé. Le corriger à chaque brique
   ferait dépendre le résultat de l'ordre d'assemblage. */
function atomicMassOf(composition){
    let mass=0
    for(const [element,byA] of composition){
        for(const [A,n] of byA) mass+=element.isotope(A).mass*n
    }
    return mass
}

/* Un Map<Element, Map<A,count>> AJOUTÉ dans un autre, `times` fois.

   La reconstruction d'une formule recombinée se fait par là: on part d'une
   composition vide et on y verse les briques, ce qui évite d'écrire dans celle
   d'une brique — une brique est partagée par des millions d'attributions et
   n'a pas le droit d'être mutée. */
function mergeComposition(target,source,times=1){
    for(const [element,byA] of source){
        for(const [A,n] of byA){
            const added=n*times
            if(!target.has(element)) target.set(element,new Map())
            const slot=target.get(element)
            slot.set(A,(slot.get(A)??0)+added)
            if(slot.get(A)===0) slot.delete(A)
        }
        if(target.get(element)?.size===0) target.delete(element)
    }
    return target
}

/* -------------------------------------------------------------------------
   LA DÉPENDANCE ENTRE BRIQUES — mesurée, pas supposée.

   Le dossier « le 13C rend les briques dépendantes » est réel, mais
   l'identité écrite dans le HANDOFF est FAUSSE: `13CH2` ne porte qu'UN carbone,
   et `12CH2 + 13C` en porte DEUX — ce n'est pas la même formule, et une
   correction faite sur cette identité ne corrigerait rien. La relation qui
   existe réellement, et que cette fonction TROUVE au lieu de la supposer, est

       13CH2 + 12C  ==  13C + 12CH2

  autrement dit l'isotope du groupe « C » peut être porté par le groupe « CH2 »
   ou par le groupe « C », et les deux écritures sont la même formule. Une liste
   de combinaison qui contient un groupe et l'un de ses sous-groupes — C dans
   CH2, O dans CO, N dans CN — produit donc des doublons par construction.

   ELLE EST SYMÉTRIQUE, et c'est ce qui interdit de LA RÉSOUDRE en retirant une
   brique du plan: `13CH2` est le SEUL porteur de « un 13C et deux H », donc le
   retirer ferait disparaître 886 687 compositions réellement atteignables
   (mesuré). On ne peut donc pas « sortir la dépendance du plan »; on peut
   seulement, pour chaque composition, n'énumérer qu'UN de ses représentants —
   la FORME CANONIQUE.

   `take` sont les deux briques qu'on peut RETIRER, `give` les deux qu'on leur
   rend: retirer une unité de chacune des deux `take` et en ajouter une à chaque
   `give` laisse la composition — donc la formule — strictement inchangée. */
/* UNE LISTE DE GROUPES, NORMALISÉE — et c'est le seul endroit qui sait lire les
   deux écritures.

   L'ancienne écriture est une chaîne: `"CH2"`. La nouvelle est un objet:
   `{group:"CH2", min:0, max:Infinity, ratio:1}`. Les deux sont acceptées, et
   une chaîne reçoit les valeurs par défaut — ce qui veut dire qu'un appelant
   ancien continue de fonctionner sans écrire une ligne de plus.

   LES VALEURS PAR DÉFAUT SONT CHOISIES, PAS NEUTRES, et c'est le changement de
   fond. `min:0, max:Infinity` dit « autant que la masse le permet » — c'était le
   comportement d'avant, et il explosait. `ratio:1` dit « l'isotope le plus
   probable seulement », donc un groupe qui n'a jamais été touché n'ouvre qu'une
   masse isotopique.

   On ne veut pas dire pour autant qu'une liste sans isotopie soit un défaut:
   ouvrir `ratio:0` sur UN groupe est un choix légitime et doit rester possible.
   C'est le DÉFAUT qui change, pas la capacité. */
/* L'IDENTITÉ D'UN GROUPE, ET ELLE DOIT ÊTRE UNIQUE À TRAVERS LES DEUX LISTES.

   `combining` et `ionising` numérotent leurs entrées à partir de zéro, alors que
   leurs bornes sont appliquées SÉPARÉMENT — `groupWithin` compte par identifiant.
   Sans un espace de noms, le premier groupe de masse et le premier adduit
   s'appelleraient tous deux « 0 », et leurs multiensembles seraient additionnés
   ensemble: une borne `max:2` sur « CH2 » limiterait alors aussi le proton. */
function groupKeyOf(isCombining,index){
    return (isCombining?"combining#":"ionising#")+index
}

function normaliseGroups(list){
    const source=Array.isArray(list)?list:[]
    return source.map((entry,index)=>{
        /* DÉJÀ NORMALISÉ: on ne relit pas un objet comme une formule. */
        if(entry&&typeof entry==="object"&&!("key" in entry)&&!("group" in entry)){
            return {...entry,index}
        }
        if(entry&&typeof entry==="object"&&(entry instanceof Formula||entry instanceof Stoichiometry)){
            return {group:entry,min:0,max:Infinity,ratio:undefined,index}
        }
        if(entry&&typeof entry==="object"){
            /* `{group, min, max, ratio}`. `key` est un synonyme accepté parce
               qu'une session sérialisée écrit souvent sous ce nom.

               `ratio` LAISSÉ ABSENT quand on ne l'a pas donné, et c'est
               volontaire: l'entrée hérite alors du `ratio` du plan, donc
               `buildPlan({ratio:0,combining:["CH2"]})` garde exactement le sens
               qu'il avait. Le « 1 par défaut » que l'écran affiche est une
               décision d'INTERFACE, et elle appartient à l'écran: si le moteur
               l'imposait, un appelant qui passe `ratio:0` n'aurait plus aucun
               moyen de garder toutes les isotopies. */
            const group=entry.group??entry.key
            return {
                group,
                min:saneBound(entry.min,0),
                max:saneBound(entry.max,Infinity),
                ratio:entry.ratio===undefined?undefined:saneRatio(entry.ratio,1),
                index
            }
        }
        return {group:entry,min:0,max:Infinity,ratio:undefined,index}
    }).filter(entry=>entry.group!==undefined&&entry.group!==null)
}

/* UNE BORNE. `∞` et les écritures voisines sont lues comme l'infini, parce que
   c'est ce que le LEMNISCATE du tableau affiche et que taper « Infinity » dans
   une case est une façon de ne pas comprendre sa propre table.

   On NE REMET PAS `min` et `max` à l'échange: une borne basse plus grande que la
   borne haute est presque toujours une faute de frappe, et l'échanger
   silencieusement rendrait un plan qui ne donne rien — ou pire, quelque chose
   qu'on n'a pas demandé. On la garde, et le plan la signale en diagnostic: une
   borne impossible doit se voir à l'écran, pas se deviner à l'usage. */
function saneBound(value,fallback){
    if(value===undefined||value===null||value==="") return fallback
    if(value==="∞"||value==="inf"||value==="Infinity"||value==="-inf") return Infinity
    const parsed=Number(value)
    if(Number.isNaN(parsed)) return fallback
    if(!Number.isFinite(parsed)) return parsed>0?Infinity:fallback
    return Math.max(0,Math.trunc(parsed))
}
function saneRatio(value,fallback){
    if(value===undefined||value===null||value==="") return fallback
    const parsed=Number(value)
    if(!Number.isFinite(parsed)) return fallback
    return Math.min(1,Math.max(0,parsed))
}

/* L'IDENTITÉ D'UNE COMPOSITION, pour comparer deux briques.

   Deux briques de même composition sont INTERCHANGEABLES, et c'est tout ce qu'il
   faut savoir ici. La clé est signée et non réduite, comme le vecteur de
   différence: réduire « 13 » en « 1 » ferait croire que ¹³C et ¹²C se
   ressemblent, et c'est precisement la confusion qui fait relever une relation
   entre deux groupes portant la meme formule. */
function keyOfComposition(composition){
    const parts=[]
    for(const [element,byA] of composition)
        for(const [A,n] of byA) parts.push(`${element.symbol}${A}:${n}`)
    return parts.sort().join("|")
}

function findDependence(items){
    /* Seules les briques SANS CHARGE et de masse strictement POSITIVE entrent
       dans la recherche. Un adduit est une charge, et un « [2+] » pèse deux
       électrons perdus, donc une masse NÉGATIVE: l'ordonner par masse n'y
       voudrait rien dire, et une brique sans masse positive ne peut pas servir
       de terme de comparaison. */
    const free=[]
    for(let i=0;i<items.length;i++){
        if(items[i].charge===0&&items[i].atomicMass>0) free.push(i)
    }
    if(free.length<4) return null
    /* Deux PAIRES de briques qui ont le MÊME VECTEUR DE DIFFÉRENCE. C'est la
       forme que prend une dépendance, et elle se détecte par comparaison de
       vecteurs — sans résolution algébrique.

       Le vecteur garde son SIGNE et sa RÉDUCTION ('13' ne devient pas '1'):
       comparer des vecteurs réduits confondrait deux dépendances qui n'ont rien
       à voir, et c'est le genre de faute qui passe inaperçu parce que le
       résultat « a l'air » juste. */
    const seen=new Map()
    for(const i of free) for(const j of free){
        if(i===j) continue
        if(j<i&&seen.has(`${j},${i}`)) continue
        const delta=[]
        for(const [element,byA] of items[i].composition)
            for(const [A,n] of byA) delta.push([element,A,n])
        for(const [element,byA] of items[j].composition){
            for(const [A,n] of byA){
                const at=delta.findIndex(([e,A2])=>e===element&&A2===A)
                if(at>=0){
                    delta[at][2]-=n
                    if(delta[at][2]===0) delta.splice(at,1)
                }else delta.push([element,A,-n])
            }
        }
        if(!delta.length) continue
        const key=delta.map(([e,A,n])=>`${e.symbol}${A}:${n}`).sort().join("|")
        const previous=seen.get(key)
        if(previous===undefined){ seen.set(key,[i,j]); continue }
        /* VÉRIFIER QUE LA RELATION APPREND QUELQUE CHOSE, et c'est la condition
           qui manquait.

           Un plan peut contenir DEUX FOIS la même paire de briques: un groupe
           « C » et un groupe « 13C » produisent chacun un ¹²C et un ¹³C, donc
           les items 0 et 2 sont deux ¹²C identiques, et 1 et 3 deux ¹³C
           identiques. Les paires (0,1) et (2,3) ont le même vecteur de
           différence, donc l'algorithme annonce une dépendance.

           Elle est vraie au sens des COMPOSITIONS, mais elle ne veut rien dire
           ici: `groupWithin` compte les deux groupes SÉPARÉMENT, donc un ¹³C du
           premier groupe et un ¹²C du second ne sont PAS interchangeables avec
           l'inverse. La forme canonique déduite — « l'un des deux ¹³C doit être à
           zéro » — interdisait alors des multiensembles parfaitement
           légitimes, et les formules disparaissaient: un groupe « 13C » en
           min 1 ne renvoyait aucun ¹³C.

           On exige donc que les QUATRE briques soient de compositions DISTINCTES
           deux à deux. Quand deux groupes portent la même formule, on renonce à
           élaguer: plus lent, et surtout exact. */
        const four=[i,j,previous[0],previous[1]]
        const distinct=new Set(
            four.map(index=>keyOfComposition(items[index].composition)))
        if(distinct.size!==4){
            seen.set(key,[i,j])
            continue
        }
        /* v(i) - v(j) == v(k) - v(l) se réécrit v(i) + v(l) == v(k) + v(j). */
        return {take:[i,previous[1]],give:[previous[0],j]}
    }
    return null
}

/* -------------------------------------------------------------------------
   LE TAS.

   Un tas binaire MINIMUM sur la masse. L'énumération d'Igor (`isotopologues`)
   trie la liste ouverte à chaque tour, ce qui est O(k log k) sur les états
   OUVERTS; ici on veut énumérer des millions de masses, donc un vrai tas:
   insertion et extraction en O(log k).

   L'état est {mass, counts, lastAdded}, où `lastAdded` est le dernier indice
   ajouté — le levier de la règle anti-doublon, expliquée plus bas. Il n'est
   jamais muté après insertion: chaque état sorti du tas est donc le seul
   propriétaire de son vecteur, et aucune copie défensive n'est nécessaire.
   ------------------------------------------------------------------------- */
class MassHeap{
    constructor(){ this.items=[] }
    get size(){ return this.items.length }
    peek(){ return this.items[0]??null }
    //le minimum remonte à la racine, puis on reperce par le dernier
    pop(){
        const top=this.items[0]
        const last=this.items.pop()
        if(this.items.length){
            this.items[0]=last
            this.sink(0)
        }
        return top
    }
    push(state){
        this.items.push(state)
        this.rise(this.items.length-1)
    }
    rise(index){
        while(index>0){
            const parent=(index-1)>>1
            if(this.items[parent].mass<=this.items[index].mass) break
            this.swap(parent,index)
            index=parent
        }
    }
    sink(index){
        const n=this.items.length
        for(;;){
            const left=2*index+1
            if(left>=n) break
            //le plus léger des deux enfants, et on ne descend que s'il bat
            //le parent
            let child=left
            const right=left+1
            if(right<n&&this.items[right].mass<this.items[left].mass) child=right
            if(this.items[index].mass<=this.items[child].mass) break
            this.swap(child,index)
            index=child
        }
    }
    swap(a,b){
        const held=this.items[a]
        this.items[a]=this.items[b]
        this.items[b]=held
    }
}

/* -------------------------------------------------------------------------
   AttributionPlan — les deux listes, lues une fois, et les fenêtres.

   AUCUNE formule n'est stockée telle quelle ici: le plan garde des CLÉS et des
   masses, jamais d'objet Formula. C'est la règle que FormulaCollectionNode
   s'impose pour les sessions (une session qui porterait des formules
   traînerait une table périodique avec elle), et elle vaut d'autant plus ici
   qu'un plan peut concerner des millions de combinaisons.
   ------------------------------------------------------------------------- */
class AttributionPlan{
    constructor({combining=[],ionising=[],ratio=0,chargeMin=1,chargeMax=1,table=null,rule="mostProbable",chargeAuto=false}={}){
        this.table=table
        this.rule=rule
        this.ratio=ratio
        this.chargeMin=chargeMin
        this.chargeMax=chargeMax
        this.diagnostics=[]
        /* les briques de masse, et les adduits. Deux listes parce que leurs
           rôles ne sont pas interchangeables: une brique n'a pas de charge, un
           adduit n'a pas de squelette. */
        this.combinables=[]
        this.ionisers=[]
        this.items=[]
        /* LECTURE DES GROUPES, et une entrée n'est plus une chaîne.

           Une chaîne dit QUEL groupe. Elle ne disait pas combien de fois on
           l'autorise, ni quelle isotopie on ouvre — et c'est exactement ce qui
           manquait: un seul `ratio` pour toute la liste obligeait à choisir entre
           « 13C » et « 17O », parce qu'ouvrir l'un ouvrait l'autre. Les deux
           explosions venaient de là.

           Une entrée est donc `{group, min, max, ratio}`:
             - `group`  la formule, chaîne ou Formula — l'ancienne écriture
             - `min`    borne basse de multiplicité, 0 par défaut
             - `max`    borne haute, Infinity par défaut
             - `ratio`  fenêtre isotopique À CE GROUPE, 1 par défaut

           `min:0, max:Infinity, ratio:1` est le groupe « moderne seulement »,
           et c'est le NOUVEAU DÉFAUT: une liste qui n'a jamais été configurée
           doit rester petite. Une chaîne seule est encore acceptée et reçoit ce
           défaut, donc rien d'existant ne casse. */
        this.groups=normaliseGroups(combining)
        this.adducts=normaliseGroups(ionising)
        /* La plage de charge, quand elle se déduit des bornes par adduit.
           `chargeAuto` est vrai quand l'appelant veut que le plan la CALCULE;
           sinon les bornesPassed restent celles qu'il a données. Le nœud passe
           `true` au premier calcul, puis laisse le champ modifiable. */
        this.chargeAuto=chargeAuto
        this.readCombining(this.groups)
        this.readIonising(this.adducts)
        if(chargeAuto) this.deriveChargeWindow()
    }

    /* LA FENÊTRE DE CHARGE, DÉDUITE DES BORNES PAR ADDUIT.

       Chaque adduit porte une charge, et chaque adduit a un `min` et un `max`.
       La charge d'une attribution est la SOMME des charges des adduits
       employés, donc sa borne basse est la somme des `min` et sa borne haute la
       somme des `max` — en valeur ABSOLUE, comme partout ailleurs.

       Une liste de deux adduits à 1..1 donne donc |z| ∈ [1,2]: les deux ensemble,
       ou l'un seul. C'est ce que la saisieNe rend pas immédiatement évident, et
       le dire dans le plan vaut mieux que le laisser deviner. */
    deriveChargeWindow(){
        /* Les adduits sont les ENTRÉES lues, et chacune porte sa charge. On la lit
           sur l'ION lui-même: `ionisers` contient les `Formula` déjà passées par
           `parseIonisationOnly`, donc leur charge est exacte et lue, pas devinée.
           `groupKey` est l'index de l'ENTRÉE, PRÉFIXÉ PAR LA LISTE, ce qui est
           exactement ce qu'il faut apparier — et un adduit illisible n'apparaît
           pas dans `ionisers`, donc il ne compte pas, ce qui est voulu.

           LE PRÉFIXE N'EST PAS COSMÉTIQUE. Les deux listes numérotent leurs
           entrées à PARTIR DE ZÉRO, donc sans lui le groupe « CH2 » et l'adduit
           « [H+] » porteraient le même `groupIndex` — et `groupWithin` les
           compterait ensemble, bornant un adduit par la borne d'un groupe de
           masse. Un `0` et un `0` ne sont pas le même groupe dès qu'on borne
           chacun de son côté. */
        let low=0,high=0
        for(const [index,entry] of this.adducts.entries()){
            const piece=this.ionisers.find(i=>i.groupIndex===groupKeyOf(false,index))
            if(!piece) continue
            const charge=Math.abs(piece.charge||0)
            low+=charge*Math.max(0,Math.trunc(Number(entry.min)||0))
            high+=charge*(Number.isFinite(entry.max)
                ?Math.max(0,Math.trunc(entry.max)):Infinity)
        }
        /* Une borne `Infinity` ne veut rien dire comme borne de charge, et le
           champ doit rester saisissable: on garde alors la borne reçue. */
        /* La borne haute ne veut rien dire comme borne de charge, et le champ
           doit rester lisible: on garde alors la borne reçue. */
        if(!Number.isFinite(high)) high=this.chargeMax
        /* LA BORNE BASSE VAUT 0 QUAND ELLE DOIT.

           `if(low>0)` laissait `chargeMin` à sa valeur reçue — donc à 1 — dès
           que les adduits autorisaient le neutre. Deux conséquences, et la
           seconde est celle qu'on voit:

             - une liste ionisante VIDE ne donnait aucun neutre possible, alors
               que c'est la façon la plus directe de demander des masses
               neutres: aucun adduit, donc charge 0, donc rien à ioniser;
             - un adduit en `0..1` gardait `chargeMin: 1`, donc `withinCharge`
               rejetait les neutres que les réglages autorisaient.

           Le seuil se pose donc sur ce que les réglages disent, pas sur ce
           qu'ils ne disent pas: `low` est déjà la borne déduite, et 0 est une
           borne aussi légitime qu'une autre. */
        if(low!==this.chargeMin) this.chargeMin=low
        if(high>0) this.chargeMax=Math.max(this.chargeMax,high)
        /* ET L'ENSEMBLE DES CHARGES ATTEIGNABLES, parce que c'est ce que
           l'utilisateur veut LIRE.

           Une borne basse et une borne haute disent « entre 1 et 2 », ce qui
           laisse croire que 1,5 existe. Les adduits ne donnent que des charges
           entières, et la liste réelle est plus courte que l'intervalle: un
           [H+] seul donne {1}; un [H+] et un [Na+] donnent {1,2}; un [H+] et un
           [Cl-] donnent {0} — un neutre, que le champ doit pouvoir dire.

           On énumère donc les SOMMES réellement possibles. La liste d'adduits
           est minuscule, donc l'énumération est triviale — et une liste de
           dizaines d'adduits resterait gérable parce que chaque adduit est
           borné, donc le produit des `max+1` est ce qu'il est. Au-delà, on
           s'arrête et on dit qu'on s'est arrêté. */
        this.chargeSet=this.enumerateCharges()
        /* LE NEUTRE EST POSSIBLE, ET C'EST UN FAIT — une lecture, pas un artefact.

           Un adduit en `0..1` autorise l'absence d'adduit, donc une somme de
           charges nulle. L'écran l'affichait en « 1 » seulement, parce que
           l'énumération écartait le 0; l'utilisateur lisait donc un ensemble
           plus étroit que ce qu'il venait de régler, sans aucune raison
           visible.

           LA SUITE DU COMMENTAIRE DISAIT « on ne descend PAS la fenêtre du
           crible, parce que le neutre coûte le double pour rien ». C'était une
           double erreur, mesurée depuis: `mass/0` ne se produit pas — `Formula.mz`
           garde son `||1` — et la fenêtre n'ajoute AUCUNE dimension (mesuré:
           même nombre d'états visités avec `chargeMin` à 0 et à 1). Le
           doublement venait de l'adduit `0..1` lui-même, qui cesse d'être fixé.

           Le neutre est donc une lecture comme une autre, au m/z de sa masse. */
        this.neutralPossible=this.chargeSet?.includes(0)??false
        if(this.neutralPossible){
            this.diagnostics.push(
                "ionising: an adduct at min 0 makes a NEUTRAL reachable — it is "+
                "read at its own mass, with no proton added")
        }
        this.chargeDerived={min:this.chargeMin,max:this.chargeMax}
        return this
    }

    /* TOUTES LES CHARGES, en VALEUR ABSOLUE, que les adduits actuels peuvent
       donner. C'est une énumération des SOMMES, pas un intervalle: un [H+] et
       un [Na+] donnent {1,2} et pas {1, 1.5, 2}.

       LE ZÉRO EST RENDU, ET C'EST LE POINT CORRIGÉ. Il était filtré par
       `.filter(v=>v>0)`, ce qui cachait deux erreurs en une: la ligne
       « Reachable charge(s) » mentait sur les réglages en cours, et un plan
       sans aucune charge non nulle se voyait renvoyer `null` — donc « the
       adducts cannot charge anything » — alors que la seule chose qu'il
       pouvait faire était de ne pas charger. Un neutre est un résultat de
       calcul, pas une absence de résultat; il se dit comme tel. */
    enumerateCharges(ceiling=4096){
        /* `let`, et non `const`: chaque adduit REMPLACE l'ensemble des sommes
           par les siennes (voir plus bas). Le germe `0` est le point de
           départ de l'énumération — l'absence de tout adduit — et il ne survit
           pas au premier adduit si celui-ci est obligatoire. */
        let sums=new Set([0])
        let anyAdduct=false
        for(const [index,entry] of this.adducts.entries()){
            const piece=this.ionisers.find(i=>i.groupIndex===groupKeyOf(false,index))
            if(!piece) continue
            anyAdduct=true
            const charge=piece.charge||0
            const min=Math.max(0,Math.trunc(Number(entry.min)||0))
            const max=Number.isFinite(entry.max)?Math.max(min,Math.trunc(entry.max)):min
            if(max>ceiling) return null
            const next=new Set()
            for(const sum of sums){
                for(let n=min;n<=max;n++) next.add(sum+charge*n)
            }
            if(next.size>ceiling) return null
            /* `sums` EST REMPLACÉ, ET C'EST LE POINT CORRIGÉ.

               L'union conservait le germe `0` de l'itération précédente: après
               un adduit en `1..1`, la somme 0 restait donc dans l'ensemble, et
               un adduit OBLIGATOIRE se lisait comme s'il autorisait le neutre.
               C'est la seconde moitié du même symptôme — et elle est distincte
               du filtre `v>0` corrigé plus bas: l'une cachait le 0 qu'on
               devait avoir, l'autre en FABRIQUAIT un qu'on n'avait pas.

               Chaque adduit rend ses `min..max` copies, point de départ: après
               le premier adduit, l'ensemble ne contient plus que ses sommes à
               lui. La somme de toutes les combinaisons se lit donc dans le
               dernier `next`, pas dans l'union de tous. */
            sums=next
        }
        const charges=[...new Set([...sums].map(v=>Math.abs(v)))]
            .filter(v=>Number.isFinite(v))
            .sort((a,b)=>a-b)
        /* `null` veut dire « je n'ai pas su énumérer », ou « aucun adduit ».
           Le cas « des adduits qui ne chargent que des neutres » n'est PLUS
           confondu avec le premier: c'est `{0}`, et il se lit. */
        if(!charges.length) return null
        /* PAS D'ADDUCT N'EST UN CHOIX, ET L'ÉCRAN LE DIT AUTREMENT.

           Une liste ionisante VIDE est ce que tape l'utilisateur qui veut des
           masses NEUTRES. Il n'y a alors qu'une charge possible — la charge
           nulle — et c'est une RÉPONSE, pas une panne. La ligne doit donc
           montrer « 0 » et l'expliquer, au lieu d'annoncer « none — the
           adducts cannot charge anything », qui persuadait l'utilisateur que
           son plan était cassé alors qu'il faisait exactement ce qu'il
           demandait. */
        if(!anyAdduct) return [0]
        return charges
    }

    /* Une saisie -> une Formula (racine), ou un diagnostic.

       Une formule illisible est un DIAGNOSTIQUE et non une exception, comme
       partout ailleurs dans le moteur: une liste de trente groupes contient
       forcément une faute de frappe, et faire tomber les vingt-neuf autres
       punirait l'utilisateur pour une seule ligne. */
    asRoot(input,label){
        if(!this.table){
            this.diagnostics.push(`${label}: no periodic table, cannot read "${input}"`)
            return null
        }
        try{
            if(typeof input==="string") return Formula.parse(input,this.table,this.rule)
            if(input instanceof Formula||input instanceof Stoichiometry) return input
        }catch(error){
            this.diagnostics.push(`${label}: ${error.message}`)
            return null
        }
        this.diagnostics.push(`${label}: ${input?.constructor?.name??typeof input} is not a formula`)
        return null
    }

    /* LES MASSES COMBINABLES.

       Une brique est une racine: elle ne fige aucun isotope. Ses masses
       combinables sont donc ses ISOTOPOLOGUES, filtrées par la fenêtre
       isotopique — le `ratio` d'Igor, relatif au maximum, entre 0 pour tout
       garder et 1 pour le seul plus probable.

       `ratio:0` garde donc TOUT, et c'est le comportement demandé par défaut;
       « ne garder que les plus abondants » se dit en relevant le ratio. La
       liste est TOUJOURS triée par abondance décroissante, donc les plus
       abondants sont les premiers dans tous les cas, quel que soit le seuil. */
readCombining(entries){
        entries.forEach((entry,index)=>{
            const label=`combining group ${index+1}`
            const root=this.asRoot(entry.group,label)
            if(!root) return
            /* LA FENÊTRE ISOTOPIQUE EST PAR GROUPE, et c'est le cœur du
               changement. Avant, un seul `ratio` valait pour toute la liste:
               l'ouvrir à 0.01 pour voir le 13C ouvrait aussi le 17O et le 18O,
               parce que le seuil était global. Le seuil est donc lu DANS
               l'entrée, avec `ratio:1` en repli — et `ratio:1` ne garde que le
               plus probable, donc un groupe intact n'ouvre qu'une masse. */
            const ratio=entry.ratio!==undefined?entry.ratio:this.ratio
            if(entry.min>entry.max){
                this.diagnostics.push(`${label}: min ${entry.min} is above max `+
                    `${Number.isFinite(entry.max)?entry.max:"∞"} — it will match nothing`)
            }
            let produced=0
            /* `limit: Infinity` et non 10: une brique est petite (CH2, O), mais
               c'est le NOMBRE DE BRIQUES qui décide du volume, et il est
               justement ce qu'on cherche à explorer. */
            /* L'ISOTOPE ÉCRIT EST UNE CONTRAINTE, ET NON UNE AMORCE.
 
               « 13C » ne demande pas « du carbone, isotopes ouverts »: il
               demande DU 13C. Or `isotopologues` part du germe le PLUS
               PROBABLE — à ratio 1 il ne rend donc que 12C, et le 13C écrit
               disparaissait. Mesuré avant correction: un groupe « 13C » en
               1..1 pesait 12.0000, indiscernable d'un « C ».
 
               On distingue donc deux éléments: ceux dont l'isotope a été
               ÉCRIT, et ceux dont il est resté par défaut. Les premiers sont
               verrouillés sur leur isotope — le `ratio` ouvre les seconds et
               ne défait jamais les premiers. C'est la seule lecture qui
               respecte ce que l'utilisateur a tapé, et elle ne change rien
               pour un groupe sans isotope écrit (« C », « CH2 »). */
            const written=new Map()
            let hasNegativeCount=false
            for(const [element,byA] of root.composition){
                for(const [A,count] of byA){
                    if(count<0){
                        hasNegativeCount=true
                    }
                    /* Un atome n'est « écrit » que si son isotope n'est pas
                       celui que la règle aurait choisi de toute façon: sans
                       cette comparaison, « C » serait pris pour un isotope
                       choisi et le groupe perdrait toute isotopie.
                       `pickA` rend l'A que la règle trancherait, donc la
                       comparaison se fait sur l'A — pas sur un isotope, et
                       pas sur un rang dans une liste triée. */
                    if(count>0&&A!==element.pickA(this.rule)) written.set(element,A)
                }
            }
            /* SI LA FORMULE CONTIENT DES COMPTES NÉGATIFS (ex: "13C-(12C)"),
               on la traite comme une brique à MASSE FIXE: on n'essaie pas de
               générer des isotopologues (ce qui ne marche pas avec des comptes
               négatifs), on utilise la formule telle quelle avec sa masse
               calculée. C'est ce qui permet d'utiliser des différences de masse
               comme briques, comme dans F-KMD. */
            if(hasNegativeCount){
                const composition=Formula.parseComposition(root.key,this.table,this.rule)
                this.combinables.push({
                    groupIndex:groupKeyOf(true,index),
                    groupKey:root.key,
                    groupNotation:String(root),
                    key:root.key,
                    notation:String(root),
                    atomicMass:atomicMassOf(composition),
                    logProbability:0,
                    groupMin:entry.min,
                    groupMax:entry.max
                })
                produced=1
            }else{
                /* LE VERROU EST PAR ÉLÉMENT, ET LE SEUIL RESTE PAR ÉLÉMENT AUSSI.
 
                   C'est LA subtlety que le premier correctif avait manquée. Il
                   passait `ratio: 0` pour le groupe entier dès qu'un isotope était
                   écrit, ce qui verrouillait le carbone ET les hydrogènes: un
                   « 13C2H4 » à ratio 1 rendait ses cinq deutériums. C'était
                   exactement le défaut reproché au `ratio` global — un isotope
                   choisi ouvrait tous les isotopes de son groupe.
 
                   La correction est de ne toucher QUE l'élément écrit: son seuil
                   passe à 0 (on doit pouvoir atteindre le 13C, que le seuil
                   aurait autrement exclu), et le FILTRE le garde. Les autres
                   éléments gardent le seuil du groupe, donc « 13C2H4 » à ratio 1
                   rend une brique, et à 0.01 ouvre ses deutériums — comme
                   « CH2 ». On construit donc une Map, pas un nombre. */
                const ratioFor=new Map()
                for(const element of written.keys()) ratioFor.set(element,0)
                for(const state of root.isotopologues({ratio,ratioFor,limit:Infinity})){
                /* La clé n'abrège JAMAIS (règle de Formula.key): elle se relit
                   exactement, et c'est ce qui permet de reconstruire la
                   composition plus bas sans l'avoir stockée. */
                const composition=Formula.parseComposition(state.key,this.table,this.rule)
                /* LE FILTRE DU VERROU. Il se lit sur la composition qu'on vient
                   de relire, donc il ne peut pas se tromper d'élément ni
                   confondre 13 et 1: c'est le A qui compte, pas le rang. */
                let respects=true
                for(const [element,A] of written){
                    const byA=composition.get(element)
                    if(!byA||byA.get(A)!==root.composition.get(element).get(A)){
                        respects=false
                        break
                    }
                }
                if(!respects) continue
                this.combinables.push({
                    groupIndex:groupKeyOf(true,index),
                    groupKey:root.key,
                    groupNotation:String(root),
                    key:state.key,
                    notation:state.notation,
                    atomicMass:atomicMassOf(composition),
                    logProbability:state.logProbability,
                    /* LES BORNES DU GROUPE, sur la brique. Elles voyagent avec
                       elle parce que `capsFor` ne connaît que les briques: c'est
                       le seul moyen de borner un GROUPE, qui est fait de
                       plusieurs briques, alors qu'une brique n'a qu'un compte. */
                    groupMin:entry.min,
                    groupMax:entry.max
                })
                produced++
                }
            }
            if(!produced){
                this.diagnostics.push(`${label}: "${root}" has no combinable mass`)
            }
        })
    }

    /* Une saisie de la liste IONISANTE -> une Formula, ou un diagnostic.

       Le chemin est `parseIonisationOnly` et NON `parse`: un adduit se tape
       sans squelette (« [H+] », « [Na+] », « [2+] »), parce qu'il n'en a pas.
       `parse` refuse cette écriture — à juste titre, une molécule sans
       composition n'est pas une molécule — donc c'est l'autre porte qu'il faut
       emprunter, et le plan n'emprunte que celle-là. Une brique, elle, est un
       squelette et passe par `asRoot`.

       C'est la seule place où les deux listes se lisent différemment, et la
       raison est dans ce que les listes REPRÉSENTENT: un adduit est une charge
       et rien d'autre, une brique est une masse et rien d'autre. */
    asIoniser(input,label){
        if(!this.table){
            this.diagnostics.push(`${label}: no periodic table, cannot read "${input}"`)
            return null
        }
        try{
            if(typeof input==="string") return Formula.parseIonisationOnly(input,this.table,this.rule)
            /* Un objet déjà construit passe par `asRoot` s'il a une
               composition, et par le refus ci-dessous sinon: on ne peut pas
               fabriquer un adduit à partir d'un neutre. */
            if(input instanceof Formula||input instanceof Stoichiometry){
                if(input.charge) return input
                this.diagnostics.push(
                    `${label}: "${input}" carries no charge, so it ionises nothing — write it as [H+], [Na+] or [2+]`
                )
                return null
            }
        }catch(error){
            this.diagnostics.push(`${label}: ${error.message}`)
            return null
        }
        this.diagnostics.push(`${label}: ${input?.constructor?.name??typeof input} is not an adduct`)
        return null
    }

    /* On lit la masse de l'ION et non la somme des atomes NEUTRES.

       C'est une correction par rapport à une brique de masse, et elle est
       nécessaire: le proton nu pèse 1.007276 en ion (1.007825 moins l'électron),
       pas 1.007825. Plafonner l'espace à 1.00728 sur un spectre dont le plus
       haut point est à 1.00728 exclurait donc le proton lui-même — la seule
       combinaison que la liste ionisante autorise.

       `Formula.mass` applique déjà cette correction, puisque sa formule est
       `somme des masses - charge * m_e`. On la réutilise telle quelle plutôt
       que de la refaire ici: deux corrections de l'électron qui ne tombent pas
       juste s'annulent, et le symptôme — une formule absente sans raison
       visible — ne renvoie à aucun des deux sites. */
    readIonising(entries){
        entries.forEach((entry,index)=>{
            const label=`ionising group ${index+1}`
            const root=this.asIoniser(entry.group,label)
            if(!root) return
            if(entry.min>entry.max){
                this.diagnostics.push(`${label}: min ${entry.min} is above max `+
                    `${Number.isFinite(entry.max)?entry.max:"∞"} — it will match nothing`)
            }
            this.ionisers.push({
                groupIndex:groupKeyOf(false,index),
                groupMin:entry.min,
                groupMax:entry.max,
                //`group` est l'équivalent de `groupNotation` pour une brique de
                //masse: TOUTE brique se nomme, sinon la recette affiche « null »
                //sur les adduits — c'est-à-dire précisément sur ce que
                //l'utilisateur a lui-même écrit dans la liste ionisante
                group:root.key,
                groupNotation:String(root),
                key:root.key,
                notation:String(root),
                atomicMass:root.mass,
                charge:root.charge,
                /* un adduit n'a pas de distribution isotopique propre ici: il
                   est pris tel qu'il est écrit, ce qui est la lecture naturelle
                   de « [Na+] ». */
                logProbability:0,
                /* LA COMPOSITION DÉJÀ LUE, et elle est ici pour une raison
                   précise: `key` ne peut PAS servir.

                   `parseComposition("1H[H+]")` rend DEUX hydrogènes, parce que la
                   clé porte l'atome dans le core ET dans le groupe entre crochets.
                   C'est le défaut que chemistry.js signale déjà — une formule à
                   adduit ne se relit pas depuis sa clé — et il mordrait exactement
                   ici, dans `stateToFormula`, qui fusionne `parseComposition` de
                   chaque brique: chaque proton compterait deux fois et le proton
                   nu deviendrait "H2[+]".

                   On transporte donc la Map DÉJÀ lue, qui ne compte chaque atome
                   qu'une fois, et `stateToFormula` l'utilise telle quelle quand la
                   brique est ionisante. Une clé qui ne peut pas se relire ne peut
                   pas non plus servir de source. */
                composition:root.composition,
                /* ET L'ADDUCT NE GARDE QUE SA CHARGE, sinon `brackets` réécrirait
                   un second [H+] au-dessus d'un hydrogène déjà présent: "H[H+]"
                   pour un seul proton. La forme sans atome est ce que la formule
                   sait rendre ([+], [2+]), et c'est celle que les chimistes
                   écrivent quand ils ne répètent pas un atome déjà présent. */
                ionisation:[{group:new Map(),charge:root.charge}]
            })
        })
    }

    /* LES BRIQUES, À PLAT.

       Les deux listes sont CONCATÉNÉES en un seul tableau indexé, parce que le
       crible ne connaît qu'un vecteur d'indices. Séparer les deux dans
       l'énumération coûterait une comparaison par état et n'apporterait rien:
       la différence de rôle est déjà portée par le CHAMP `charge` de chaque
       brique. */
    buildItems(){
        this.items=[]
        for(const piece of this.combinables){
            /* LA COMPOSITION EST LUE ICI, UNE SEULE FOIS.

               Elle était lue dans `stateToFormula`, donc pour CHAQUE état et
               chaque brique: 17 689 formules × 4 briques ≈ 70 000 appels à
               `parseComposition` sur des chaînes qui ne changent jamais. Mesuré,
               c'était 221 ms des 955 ms du chemin complet à 10 000 pics.

               Une brique à combiner s'écrit sans adduit, donc sa clé se relit
               exactement — c'est ce qui rendait le chemin correct. Il reste
               correct: c'est le MÊME appel, fait une fois au lieu de 70 000.
               `mergeComposition` lit sa source sans jamais l'écrire, donc la Map
               partagée reste intacte.

               Le prix de ce partage: `items[i].key` ne doit plus être modifié
               après le plan. Personne ne le fait, et le plan est reconstruit à
               chaque resolve. */
            this.items.push({
                ...piece,
                composition:piece.composition
                    ??Formula.parseComposition(piece.key,this.table,this.rule),
                charge:0,
                kind:"combining"
            })
        }
        for(const piece of this.ionisers){
            /* Un adduit garde SA composition, qui n'est PAS celle qu'un re-parsing
               de sa clé donnerait: `parseComposition("1H[H+]")` rend deux
               hydrogènes, l'atome du core et celui du groupe, alors que l'adduit
               n'en apporte qu'un. C'est pour ça que la brique ionisante transporte
               sa Map plutôt que de la relire. */
            this.items.push({...piece,kind:"ionising"})
        }
        /* LA DÉPENDANCE, une fois les briques en place, et une seule fois: elle
           se lit dans les items, donc après le concaténer. Un plan sans
           dépendance — ratio 0.1, ou une liste sans groupe et sous-groupe — en
           porte `null`, et tous les chemins canoniques deviennent des no-ops. */
        this.dependence=findDependence(this.items)
        if(this.dependence){
            const {take,give}=this.dependence
            this.dependence.notation=
                take.map(i=>this.items[i].notation).join(" + ")
                +" == "+give.map(i=>this.items[i].notation).join(" + ")
            this.diagnostics.push(
                `combining: ${this.dependence.notation} give the same formula, `+
                "so the sieve keeps one recipe out of each — the readings themselves are unchanged")
        }
        return this.items
    }

    /* LA FORME CANONIQUE d'un vecteur, et elle se lit AVEC les bornes.

       La relation dit qu'on peut retirer une unité de chacune des deux briques
       `take` et en rendre une à chacune des deux `give`. Un vecteur est
       canonique quand ce retrait devient IMPOSSIBLE.

       On pourrait croire qu'il suffit de regarder les deux `take`, et qu'un état
       canonique est donc celui dont une `take` est à zéro. Ce serait FAUX, et
       c'est mesuré: une règle qui ignore les bornes perd 168 420 compositions
       sur la fixture. La raison est que le représentant canonique d'une
       composition n'est pas toujours atteignable — poussé jusqu'au bout, il
       dépasse la borne d'une brique `give`, et le seul état réellement
       atteignable de cette composition est alors précisément celui qu'on venait
       d'écarter. Les bornes sont donc PARTIE DE LA RÈGLE, pas un détail.

       D'où les TROIS issues, toutes lisibles sur les bornes qu'on nous passe:
       une `take` est vide, ou une `give` est pleine. */
    canonicalWithin(counts,caps){
        const dependence=this.dependence
        if(!dependence) return true
        const [a,b]=dependence.take
        const [c,d]=dependence.give
        if(counts[a]===0||counts[b]===0) return true
        if(counts[c]>=caps[c]||counts[d]>=caps[d]) return true
        return false
    }

    get itemCount(){ return this.items.length }

    /* Les bornes de multiplicité, pour une masse maximale donnée.

       Le nombre maximal de copies d'une brique de masse a dans une molécule
       qui ne dépasse pas maxMass est `maxMass // a`. C'est la borne que la
       consigne énonce, et elle est exacte: au-delà, la seule somme possible
       dépasserait déjà le plafond.

       Pour un adduit, la charge borne EN OUTRE la multiplicité, sinon un [2+]
       en fenêtre ±10 donnerait un volume absurde. On retient donc le plus petit
       des deux plafonds.

       ASSUMPTION, et elle est réelle: les adduits d'une même liste sont
       supposés de même signe. La borne ignore donc les annulations entre un
       [H+] et un [Cl-]. Ce n'est pas un oubli, c'est un choix, et il est dit
       ici parce qu'il borne le domaine exploré. */
    capsFor(maxMass){
        /* LES BORNES D'UN GROUPE, ET ELLES SONT PARTAGÉES.

           Un GROUPE est fait de plusieurs BRIQUES — « CH2 » donne 12CH2 et 13CH2,
           et plus encore si on ouvre l'isotopie — et chacune a son propre compte
           dans le vecteur de multiplicités. Or `max:4` sur « CH2 » veut dire QUATRE
           CH2 AU TOTAL, pas quatre de chaque isotope.

           La borne d'une brique ne peut donc pas se lire seule: elle dépend de ce
           que ses sœurs ont déjà pris. On désigne donc, pour chaque groupe, la
           brique qui PORTE le budget — la PREMIÈRE du groupe — et elle seule
           reçoit `max`. C'est arbitraire mais DÉTERMINISTE, parce qu'une
           répartition qui dépendrait de l'ordre de parcours ferait varier le même
           plan d'une exécution à l'autre.

           Et c'est un CHOIX DE PERFORMANCE, pas une physique: cela change
           quels multiensembles sont énumérés, jamais la composition qu'ils
           produisent. La vérité du budget est vérifiée au rendu par
           `groupWithin`, qui voit toutes les multiplicités. L'élagage
           accélère; le filtre décide. */
        const caps=this.items.map((item,index)=>{
            /* Un adduit SANS ATOME n'a pas de masse: un [2+] ne perd que deux
               électrons, donc sa masse est légèrement NÉGATIVE, et
               `maxMass / masse` serait un quotient négatif qui le ferait
               disparaître de tout plan — alors qu'il est précisément ce qui
               produit une charge multiple, donc l'adduit le plus utile des
               deux listes.

               On ne retient donc le plafond de masse que pour une masse
               STRICTE POSITIVE. C'est la seule ligne qui distingue une brique
               d'un adduit par la physique, et non par la case du menu. */
            const byMass=item.atomicMass>0
                ?Math.floor(maxMass/item.atomicMass)
                :Infinity
            /* Pour un adduit, la charge borne EN OUTRE la multiplicité, sinon un
               [2+] en fenêtre ±10 donnerait un volume absurde. On retient donc le
               plus petit des deux plafonds.

               ASSUMPTION, et elle est réelle: les adduits d'une même liste sont
               supposés de même signe. La borne ignore donc les annulations entre
               un [H+] et un [Cl-]. Ce n'est pas un oubli, c'est un choix, et il est
               dit ici parce qu'il borne le domaine exploré. */
            const byCharge=item.charge
                ?Math.floor(this.chargeMax/Math.abs(item.charge))
                :Infinity
            let cap=Math.max(0,Math.min(byMass,byCharge))
            /* LE BUDGET DU GROUPE, sur la brique qui le porte. C'est ce qui fait
               qu'un `max` borne le GROUPE entier, et non chaque isotope. */
            if(this.leadsItsGroup(index)&&Number.isFinite(item.groupMax??Infinity)){
                cap=Math.min(cap,item.groupMax)
            }
            return cap
        })
        return caps
    }

    /* LA PREMIÈRE BRIQUE D'UN GROUPE, et c'est elle qui porte le budget. */
    leadsItsGroup(index){
        const group=this.items[index].groupIndex
        for(let i=0;i<index;i++) if(this.items[i].groupIndex===group) return false
        return true
    }

    /* LE VRAI BUDGET D'UN GROUPE, AU RENDU.

       `capsFor` répartit le budget pour ne pas énumérer plus que nécessaire,
       mais cette répartition est arbitraire: elle ne dit pas si l'utilisateur a
       vraiment autorisé cinq CH2. Ce contrôle dit la vérité, et il s'applique au
       moment du RENDU, où toutes les multiplicités sont connues. */
    groupWithin(counts){
        const totals=new Map()
        for(let i=0;i<this.items.length;i++){
            const times=counts[i]
            if(!times) continue
            const group=this.items[i].groupIndex
            totals.set(group,(totals.get(group)??0)+times)
        }
        for(const [group,total] of totals){
            /* On lit les bornes sur N'IMPORTE QUELLE brique du groupe: elles sont
               identiques sur toutes, sinon le budget n'aurait pas de sens. */
            const sample=this.items.find(i=>i.groupIndex===group)
            if(!sample) continue
            const min=sample.groupMin??0
            const max=Number.isFinite(sample.groupMax)?sample.groupMax:Infinity
            if(total<min||total>max) return false
        }
        return true
    }

    /* La charge d'un vecteur de multiplicités: la somme des charges des
       briques IONISANTES employées. Une brique de masse n'en porte pas, donc
       elle n'y contribue pas — et c'est ce qui rend les deux listes additives
       sans jamais les confondre. */
    chargeOf(counts){
        let charge=0
        for(let i=0;i<this.items.length;i++){
            if(counts[i]) charge+=this.items[i].charge*counts[i]
        }
        return charge
    }

    /* LE PLUS GRAND NOMBRE DE MASSE qu'une combinaison peut atteindre ici.

       Un m/z est une MASSE DIVISÉE par la charge, donc un 2+ à 800 correspond à
       1600 de masse: lire le plus grand m/z et s'arrêter là tronquerait d'emblée
       toutes les charges multiples.

       Le produit ne suffit pourtant pas, et le proton en donne l'exemple: un
       point à 1.00728 donne un plafond de 1.00728, alors que le proton nu pèse
       1.007276 en ion et son ADDUCT 1.007276 aussi — juste dessous. Le plafond
       doit donc monter d'au moins la masse du plus lourd adduit, parce que
       l'adduit ne vient pas du spectre: il vient de la liste ionisante, et
       l'utilisateur l'a choisi sans le voir.

       On prend le plus grand des deux: le produit par la charge, et le plus
       lourd adduit. Une liste ionisante sans adduit — un plan sans charge
       possible — donne 0, et le plafond reste le produit, ce qui est le cas
       normal. */
    massCeiling(points){
        const maxMz=points.massAt(points.length-1)
        const byCharge=maxMz*Math.max(1,Math.abs(this.chargeMax))
        const heaviestAdduct=this.items.reduce(
            (heaviest,item)=>item.kind==="ionising"
                ?Math.max(heaviest,item.atomicMass)
                :heaviest,
            0
        )
        return Math.max(byCharge,heaviestAdduct)
    }

    /* LE PLANCHER, RAMENÉ SOUS LE PREMIER POINT DU SPECTRE.

       Une formule n'a pas besoin d'ATTEINDRE le premier pic pour être
       intéressante — il suffit qu'elle SOIT SOUS, parce que c'est une borne et
       non un seuil. Mais surtout, une formule à 1.007276 atteint un pic mesuré à
       1.00728, et 1.007276 < 1.00728: le plancher brut, pris au point, exclut
       donc l'exacte formule que le pic désigne. L'écart est de quatre
       milli-millionièmes de masse, invisible partout — et suffisant pour vider la
       liste.

       On descend donc d'une TOLÉRANCE DE MASSE, large et constante. Elle ne sert
       pas à « laisser passer un peu » — elle sert à dire que le plancher est
       une frontière, pas un mur, et qu'une formule située dessus est dans la
       fenêtre. Une tolérance proportionnelle serait pire : elle dépendrait du
       pic, donc deux spectres de la même molécule donneraient deux listes
       différentes.

       Le plancher reste 0 quand le point le plus bas n'est pas exploitable, et
       c'est le cas quand `chargeMin` vaut 0: sans borne basse de charge, la
       division n'a plus de minimum, donc borner serait faux. */
    massFloor(points){
        const minMz=points.massAt(0)
        if(!Number.isFinite(minMz)||minMz<=0) return 0
        return Math.max(0,minMz*Math.max(1,this.chargeMin)-MASS_FLOOR_TOLERANCE)
    }

    /* La fenêtre d'ionisation, comme prédicat. Un vecteur est-il dans la
       fenêtre d'ionisation? La fenêtre est en valeur absolue: un 2+ et un 2-
       sont la même chose à mesurer. */
    withinCharge(counts){
        const magnitude=Math.abs(this.chargeOf(counts))
        return magnitude>=this.chargeMin&&magnitude<=this.chargeMax
    }
}

/* -------------------------------------------------------------------------
   LE CRIBLE — stratégie « tas ».

   Énumère les multiensembles de briques dont la masse totale ne dépasse pas
   maxMass, par masse croissante, SANS doublon et SANS jamais matérialiser
   l'espace entier.

   `accept` filtre ce qui est RENDU, jamais ce qui est DÉVELOPPÉ. Un état rejeté
   mais dont les voisins sont légitimes doit être étendu quand même, sinon la
   marche s'arrêterait dessus — c'est exactement le piège que documente
   `isotopologues` sur sa fenêtre, et il se reproduirait ici à l'identique.

   LA RÈGLE ANTI-DOUBLON: depuis un état, on n'ajoute la brique i que si TOUS les
   indices SUPÉRIEURS à i sont nuls — donc si i est le plus petit indice non
   nul. Chaque multiensemble se lit alors comme une suite d'indices CROISSANTS,
   et cette suite est son seul chemin d'arrivée dans le tas. La mémoire reste
   celle du FRONTIÈRE, pas celle de l'espace. C'est le point sur lequel la
   force brute d'Igor se paie: `trouvemass` devait sans cesse reconstruire ses
   coefficients, et sa vitesse était bornée par ce travail, pas par le volume.

   La masse croît le long de toute arête (chaque brique pèse > 0), donc le
   minimum du tas est bien le plus léger état encore atteignable, et la sortie
   est rigoureusement triée. Un test le vérifie, il ne se contente pas de
   l'affirmer. */
function cribleHeap(plan,{maxMass,minMass=0,limit=Infinity,accept=null,emit=null}={}){
    /* `emit` EST UN ÉVACUAIRE ALTERNATIF, et il existe parce que le chemin
       SÉLECTIONNÉ n'a besoin d'aucun des états.

       Sans sélection, le crible rend tout, et `states` est la réponse. Avec
       sélection, l'appelant range chaque état dans un seau par point et n'en
       garde que trois: les 350 816 objets de `states` — et le tri final qui les
       remet par masse — sont alors du travail jeté. Mesuré sur la fixture à
       ratio 0.01: 445 ms en construisant le tableau, 143 ms en vidant au fil de
       l'eau. Le même espace, la même réponse, trois fois moins de temps.

       `emit` reçoit l'état et peut rendre `false` pour tout arrêter, exactement
       comme le fait `states.length>=limit`. Les deux sortie coexistent: un
       appelant qui veut la liste demande `states`, un appelant qui veut classer
       demande `emit`. */
    const collect=!emit
    const items=plan.items
    const count=items.length
    if(!count) return {states:[],visited:0,truncated:false}
    const caps=plan.capsFor(maxMass)
    //aucune brique ne peut entrer: le plafond les exclut toutes
    if(caps.every(cap=>cap===0)) return {states:[],visited:0,truncated:false}
    /* LE GERME EST POUSSÉ QUOI QU'IL ARRIVE, même sous le plancher. C'est la
       seule exception, et elle est nécessaire: tout état s'atteint en partant
       de la masse 0, donc ne pas pousser le germe ne donnerait aucun état du
       tout — pas « moins d'états », AUCUN. Un élagage appliqué au germe au lieu
       de la croissance viderait le crible sans qu'on le voie. */
    const heap=new MassHeap()
    /* LA SIGNATURE D'UN VECTEUR EST UN ENTIER, et c'est la seule chose que le
       `seen` change. Une base MIXTE: le chiffre d'une brique est sa multiplicité,
       chaque position a son poids, et le vecteur entier s'additionne comme un
       nombre. Deux vecteurs donnent le même nombre exactement quand ils sont le
       même vecteur — c'est une bijection, donc exactement le même ensemble de
       signatures qu'avant, et donc exactement le même espace couvert.

       Ce n'était pas un goût, c'était un choix qui cachait un CRASH. La version
       qui joignait les multiplicités en CHAÎNE coûtait 24,4 s sur la fixture à
       ratio 0.01. Elle pouvait aussi, à ratio 0, ne rien rendre du tout:
       `RangeError: Set maximum size exceeded` — un `Set` ne peut pas contenir
       plus d'entrées que V8 n'en alloue. CE CRASH N'EST PAS CORRIGÉ: le tableau
       ci-dessous est un `Uint8Array`, donc il a sa propre limite, et au-delà on
       retombe sur un `Set`. Ratio 0 échoue donc toujours. Je le dis ici, parce
       que ce commentaire est précisément l'endroit où quelqu'un croirait le
       problème réglé.

       LE BITMAP EST JUSTE CE QU'IL FAUT POUR LE TRAVAIL QUOTIDIEN. La signature
       EST une base mixte, donc l'espace entier a `∏(caps[i]+1)` positions, et on
       peut réserver un octet par multiensemble adressable. La mémoire devient
       PRÉVISIBLE — un octet, contre une trentaine par entrée de `Set` — et « déjà
       vu » devient une lecture au lieu d'un hachage. On réserve jusqu'à 64 MiB,
       ce qui couvre largement une fenêtre de travail. */
    const strides=new Int32Array(count)
    let span=1
    for(let i=0;i<count;i++){
        strides[i]=span
        span*=caps[i]+1
    }
    /* LE BITMAP A UNE LIMITE, et elle se atteint. `span` est le nombre de
       multiensembles ADRESSABLES, pas le nombre de multiensembles_visités: à
       ratio 0 sur la fixture il vaut 2,5·10²¹, alors que le plafond de masse n'en
       rend qu'un million. Réserver tout l'espace serait donc pire que le `Set`.

       On réserve donc le bitmap quand il tient — jusqu'à 64 MiB, soit 6,7·10⁷
       positions, ce qui couvre largement les fenêtres de travail — et on TOMBE
       sur un `Set` au-delà. Les deux répondent à la même question par le même
       chemin (`seen[signature]`), donc le reste du crible ne fait pas la
       différence, et le choix se fait une fois, ici. */
    const bitmap=span<=1<<26?new Uint8Array(span):null
    /* UN OBJET PLUTÔT QUE DEUX FONCTIONS: `alreadySeen` et `markSeen` sont
       appelées une fois par multiensemble — 725 429 fois sur la fixture — et une
       fermeture appelée à chaque itération se paie. Un objet dont la forme ne
       change jamais garde la même icône de code, donc le test de la branche
       bitmap/Set devient une lecture de propriété. */
    const setOf=bitmap?null:new Set([0])
    const ledger=bitmap
        ?{has:s=>bitmap[s]===1,add:s=>{bitmap[s]=1}}
        :{has:s=>setOf.has(s),add:s=>setOf.add(s)}
    ledger.add(0)
    heap.push({mass:0,counts:new Int32Array(count),signature:0})
    /* LA CANONIQUE, à la POUSSÉE et pas au rendu.

       Élaguer au rendu ne servirait à rien: le tas CONTINUERAIT de parcourir
       les 2 248 847 états, dont 1 098 942 ne sont que des doublons — mesuré, un
       `accept` qui les refuse coûte toujours 20 s. Il faut donc refuser de les
       ENTRER DANS LE TAS.

       Et c'est sûr ici, contrairement au plancher: ajouter une brique ne peut
       qu'AUGMENTER les multiplicités, donc un état non canonique (dont les deux
       `take` sont pleines) a des descendants non canoniques — l'ensemble écarté
       est fermé par l'ajout, et écarter un état ne peut donc cacher aucun de ses
       voisins. Réciproquement, un état canonique reste atteignable: il suffit
       d'ajouter les briques dans un ordre où les deux `take` ne sont jamais
       toutes deux pleines, ce qui est toujours possible. */
    const dependence=plan.dependence
    const [takeA,takeB]=dependence?dependence.take:[0,0]
    const [giveA,giveB]=dependence?dependence.give:[0,0]
    const states=[]
    let visited=0
    let truncated=false
    while(heap.size){
        const state=heap.pop()
        visited++
        /* LE PLANCHER FILTRE AU RENDU, jamais à la poussée, et la distinction est
           la seule chose qui rende ce réglage correct.

           La version qui coupait la croissance vidait le crible: « 1 CH2 » à
           14.016 mène à « CH2 + H+ » à 15.022 par l'ajout d'une brique de 1.007,
           donc un plancher à 15.022 rendait ce premier état et, avec lui, tout
           ce qu'il aurait pu atteindre. Les briques n'ont pas toutes la même
           taille, et « sous le plancher » ne veut pas dire « ne mène nulle part ».

           Ici l'état est DÉJÀ sorti et sa masse est définitive: rien ne viendra
           l'alléger. Le refuser ne peut donc rien perdre — et il n'y a pas
           d'économie à faire de toute façon, puisque la marche s'arrête au
           plafond de toute façon. Ce que le plancher apporte est une liste plus
           courte, pas une recherche plus rapide. */
        const withinFloor=state.mass>=minMass
        if(withinFloor&&(!accept||accept(state))){
            /* `emit` PREND LE PAS SUR `states`: c'est le même état, au même
               endroit du parcours, et il n'est stocké nulle part. */
            if(emit){ if(emit(state)===false){ truncated=true; break } }
            else states.push(state)
            if(collect&&states.length>=limit){ truncated=true; break }
        }
        /* LA RÈGLE ANTI-DOUBLON, et elle est celle de `isotopologues`: un `seen` des
       signatures déjà visitées, et on n'étend que les états qu'on n'a pas
       encore sortis.

       Le `seen` se remplit au moment où un état est POUSSÉ, pas lorsqu'il est
       sorti. La nuance est décisive: ajouter une signature au `seen` n'a pas
       encore interdit de pousser cet état — cela interdit seulement d'en
       pousser une deuxième fois, ce qui est exactement le doublon qu'on cherche
       à éviter. L'état germe a sa signature, et il n'est jamais re-poussé.

       On ne peut pas remplacer ce `seen` par une contrainte d'ordre sur les
       indices — j'en ai essayé deux formulations — parce que la masse n'est pas
       une fonction monotone du vecteur: le tas rend le plus léger état
       ATTEIGNABLE, il ne garantit pas l'ordre croissant de TOUS les états, et
       c'est cet ordre qui est demandé. Une contrainte d'ordre limiterait
       l'espace à un sous-ensemble trié mais faux — 4915 au lieu de 25080 dans
       nos mesures, un sous-ensemble qui a l'air parfaitement correct et ne
       couvre pas l'espace.

       Le `seen` reste donc, et c'est en Rust qu'il doit vivre: une table de
       hachage de u32 n'y coûte rien de mesurable, alors qu'en JS une chaîne par
       état devient le facteur limitant dès que le plafond est celui d'un spectre
       entier. C'est une raison de fond de faire ce calcul en Rust. */
        for(let i=0;i<count;i++){
            if(state.counts[i]>=caps[i]) continue
            const mass=state.mass+items[i].atomicMass
            if(mass>maxMass) continue
            /* LE PLANCHER NE POUV PAS ÉLAGUER ICI, et l'erreur est instructive.

               On pourrait croire qu'un état sous le plancher est inutile, puisque
               les briques ne font qu'ajouter de la masse. C'est FAUX, et la
               raison est que les briques n'ont pas toutes la même taille: [H+]
               pèse 1.007, si bien que l'état « 1 CH2 » à 14.016 mène à « CH2 + H+ »
               à 15.022. Élaguer le premier supprimerait le second — et avec lui
               toute la moitié basse de l'espace.

               Concrètement, sur un spectre dont le premier pic est à 15.0229, le
               plancher vaut 15.0229, et élaguer à la croissance rendait le crible
               TOTALEMENT VIDE: zéro état, au lieu d'un. Le plancher se.day
               contenterait donc de supprimer ce qui est legitimate.

               C'est la différence entre le tas et le crible mixte qui decide ici.
               Le tas rend par masse croissante: tout état lourd a un chemin qui
               passe par des états plus légers, donc couper la croissance est
               sûr. PAS ICI: on ne sait pas à l'avance si un préfixe léger mènera
               au-dessus.

               Le plancher s'applique donc à l'ACCEPT, au moment du rendu, où la
               masse est définitive. C'est le seul endroit où il est exact — et il
               reste exact dans les deux stratégies, ce qui compte davantage que
               l'économie qu'il ne fait pas. */
            const counts=new Int32Array(count)
            counts.set(state.counts)
            counts[i]+=1
            /* LA CANONIQUE, refusée ICI, à la poussée. Un plan sans dépendance
               (`dependence` null) ne teste rien: les deux index portent 0,0 et la
               comparaison passe toujours. Ce test coûte quatre comparaisons sur
               des entiers, et il remplace 748 126 états. */
            if(dependence&&counts[takeA]>0&&counts[takeB]>0
                &&counts[giveA]<caps[giveA]&&counts[giveB]<caps[giveB]) continue
            const signature=state.signature+strides[i]
            //déjà dans la file ou déjà sorti: inutile de le repousser
            if(ledger.has(signature)) continue
            ledger.add(signature)
            heap.push({mass,counts,signature})
        }
    }
    return {states,visited,truncated}
}

/* -------------------------------------------------------------------------
   LE CRIBLE — stratégie « base mixte », celle de trouvemass.

   L'Igor parcourait un compteur MIXTE: chaque brique a son chiffre, de 0 à sa
   borne, et le compteur avance comme un compteur d'horloge. C'est plus simple
   que le tas et cela donne le même ensemble, mais l'ordre n'est pas croissant —
   d'où le tri final, qu'Igor payait déjà.

   On la garde pour deux raisons. D'abord elle est l'ORACLE du tas: un test
   compare les deux sur un cas dont la force brute est calculable, et ils
   doivent trouver exactement le même ensemble. Ensuite elle est souvent plus
   rapide quand le plafond est large et que l'ordre importe peu.

   Le comblement par la masse la plus faible, lui, n'est PAS reproduit: la
   fenêtre doit être couverte en entier, pas approchée par le bas. C'est la
   seule différence de fond avec trouvemass, et c'est celle que la consigne
   demande. */
function cribleMixedRadix(plan,{maxMass,minMass=0,limit=Infinity,accept=null,emit=null}={}){
    const items=plan.items
    const count=items.length
    if(!count) return {states:[],visited:0,truncated:false}
    const caps=plan.capsFor(maxMass)
    /* LA CANONIQUE, ici comme dans le tas, mais à un AUTRE moment — et c'est la
       seule nuance qui compte.

       Dans le tas, on refuse de POUSSER un état non canonique: les multiplicités
       ne font qu'augmenter le long d'une arête, donc aucun descendant d'un état
       non canonique ne peut être canonique, et rien de légitime n'est caché. Ici
       le compteur avance par chiffres CROISSANTS, donc un préfixe non canonique
       peut très bien avoir des COMPLÉMENTS canoniques — les chiffres suivants
       sont libres. Élaguer à ce moment-là supprimerait des formules, et c'est
       mesuré: élaguer trop tôt perd 168 420 compositions.

       On n'élague donc qu'au chiffre où les QUATRE briques de la relation sont
       déjà décidées: `decidedAt` est leur indice le plus grand. Avant ce chiffre
       la dépendance est ignorée; à ce chiffre — et à lui seul — le test est
       définitif, puisque plus rien ne bouge ensuite. */
    const dependence=plan.dependence
    const decidedAt=dependence
        ?Math.max(dependence.take[0],dependence.take[1],dependence.give[0],dependence.give[1])
        :-1
    const [takeA,takeB]=dependence?dependence.take:[0,0]
    const [giveA,giveB]=dependence?dependence.give:[0,0]
    /* LES GROUPES FIXES, et c'est LA question « ça coûte combien? ».

       Un groupe à `min === max` ne varie pas: il est présent exactement N fois,
       quoi qu'il arrive. Or chaque brique a sa place dans le compteur, donc une
       borne `0..N` laisse le compteur CHOISIR entre N+1 valeurs alors qu'il n'y en
       a qu'une de possible — et trois groupes fixes à 1..1 multiplient l'espace
       par 2×2×2 pour un résultat unique.

       La question de l'utilisateur — « forcer 1 Mg, 1 SO4, 1 CH3OH » — veut dire
       DÉCALER la masse à criblée d'une constante, pas explorer trois dimensions de
       plus. Donc un groupe fixe ne doit coûter qu'UNE case: celle du groupe, pas
       celle de chaque isotope.

       LA RÈGLE, donc: à la PREMIÈRE brique d'un groupe fixe, on ne boucle pas sur
       le compte — on boucle sur LES BRIQUES DU GROUPE, en n'en allumant qu'une à
       la valeur N. Les briques suivantes du groupe sont forcées à zéro, parce que
       le compte est déjà placé. Un groupe de `ratio:1` n'a qu'une brique, donc
       aucune boucle du tout: une case de plus dans le plan, pas dans la boucle.

       On ne le fait QUE dans le crible mixte, qui parcourt les chiffres
       directement et peut donc sauter une dimension. Le tas, lui, marche par
       arêtes: il devrait porter la même optimisation, et ne la porte pas — on le
       dit dans le readout plutôt que de le laisser croire. */
    const fixedGroups=new Map()
    for(const [index,item] of items.entries()){
        const group=item.groupIndex
        if(fixedGroups.has(group)) continue
        const min=item.groupMin??0
        const max=item.groupMax??Infinity
        if(!Number.isFinite(max)||min!==max) continue
        const members=[]
        for(let i=0;i<count;i++) if(items[i].groupIndex===group) members.push(i)
        fixedGroups.set(group,{count:min,members})
    }
    /* `fixedAt` DIT QUEL GROUPE EST DÉCIDÉ À CE CHIFFRE — et il ne peut PAS être
       UN `Int32Array`, parce qu'une clé de groupe est une CHAÎNE.

       C'était un `Int32Array(count).fill(-1)` recevant `fixedAt[first]=group`.
       Une chaîne dans un tableau d'entiers devient `NaN` puis `0`: donc
       `fixedAt[première]` valait 0, et `fixedGroups.get(0)` — la Map étant
       indexée par « combining#0 » / « ionising#0 » — renvoyait `undefined`.

       Résultat : `fixed` restait toujours `undefined`, la branche « groupe fixe »
       n'était jamais prise, et la branche d'après forçait le compte de CHAQUE
       membre à zéro. Un adduit `[H+] 1..1` était donc mis à zéro partout, la
       charge valait toujours 0, et le nœud ne trouvait RIEN. Le réglage par
       défaut de la liste ionisante étant précisément `1..1`, tout le nœud était
       mort. */
    const fixedAt=new Array(count).fill(null)
    for(const [group,fixed] of fixedGroups) fixedAt[fixed.members[0]]=fixed
    const collect=!emit
    const states=[]
    const counts=new Int32Array(count)
    let visited=0
    let truncated=false
    const step=(index,mass)=>{
        if(index===count){
            visited++
            /* LE PLANCHER, ICI ET NULLE PART AILLEURS. Le crible mixte ne peut
               pas élaguer sur le plancher comme le tas: sa masse ne croît PAS
               selon l'indice — un préfixe léger peut être suivi d'une brique
               lourde — donc élaguer un préfixe sous le plancher supprimerait des
               états qui dépassent. Le test qui compare les deux stratégies le
               verrait échouer, ce qui est exactement à quoi il sert.

               Sur un FEUILLET, en revanche, la masse est définitive: rien ne
               viendra l'alléger, donc un feuillet sous le plancher peut être
               rejeté sans risque. C'est le seul endroit sûr ici. */
            if(mass<minMass) return false
            if(!accept||accept({counts,mass,lastAdded:lastNonZero(counts)})){
                /* `emit` PREND LE PAS SUR `states`, comme dans le tas. Ici le gain
                   est même plus net: le crible mixte TRIE ses états à la fin,
                   donc un tableau rendu puis abandonné, c'est un tableau
                   construit pour être jeté ET un tri payé pour rien. */
                if(emit){ if(emit({mass,counts:Int32Array.from(counts)})===false){
                    truncated=true; return true
                } }
                else{
                    states.push({mass,counts:Int32Array.from(counts),lastAdded:lastNonZero(counts)})
                    if(states.length>=limit){ truncated=true; return true }
                }
            }
            return false
        }
        /* LE GROUPE FIXE, et il ne boucle pas sur le COMPTE.

           À la première brique d'un groupe à `min === max`, le choix n'est pas
           « combien de fois » — c'est DÉJÀ décidé — mais « quel isotope », donc
           on allume UNE brique du groupe à la valeur N et on récurse. Les briques
           suivantes du groupe tombent plus bas, à zéro forcé.

           C'est ce qui fait que `1 CH3OH` coûte une case et non une dimension:
           la masse est décalée d'une constante, et le nombre de combinaisons
           reste celui du reste du plan. */
        const fixed=fixedAt[index]??null
        if(fixed){
            /* On tente chaque isotope du groupe, et on n'allume que celui-là. */
            for(const member of fixed.members){
                if(fixed.count===0) break
                if(member<index) continue
                for(const other of fixed.members) counts[other]=0
                if(fixed.count>caps[member]) continue
                counts[member]=fixed.count
                const shifted=mass+fixed.count*items[member].atomicMass
                if(shifted<=maxMass&&step(index+1,shifted)) return true
                counts[member]=0
            }
            for(const member of fixed.members) counts[member]=0
            return false
        }
        /* UNE BRIQUE DU GROUPE FIXE, PAS LA PREMIÈRE: le compte est déjà posé, on
           ne peut donc plus que passer. Et c'est le seul cas où l'on EFFACE: sans
           cela la brique garderait le compte du tour d'essai précédent, et le
           crible trouverait des multiensembles impossibles. */
        if(fixedGroups.size){
            const owner=items[index].groupIndex
            if(fixedGroups.has(owner)&&!fixed){
                counts[index]=0
                const kept=step(index+1,mass)
                return kept
            }
        }
        for(let k=0;k<=caps[index];k++){
            counts[index]=k
            /* LA CANONIQUE, au chiffre `decidedAt` et à lui seul. Le plan sans
               dépendance met `decidedAt` à -1, donc ce test ne s'exécute jamais et
               le crible se comporte exactement comme avant. */
            if(index===decidedAt&&counts[takeA]>0&&counts[takeB]>0
                &&counts[giveA]<caps[giveA]&&counts[giveB]<caps[giveB]) continue
            const next=mass+k*items[index].atomicMass
            /* Le plafond de masse, comme dans le tas. On élague ICI: toute
               somme déjà trop lourde ne peut qu'empirer, donc continuer ne
               ramène rien — et le crible rendrait des états que le plafond
               interdit. C'est le seul endroit où les deux stratégies
               doivent coïncider, et c'est le test qui les compare. */
            if(next<=maxMass&&step(index+1,next)) return true
        }
        /* On ne laisse pas une valeur d'essai derrière soi: sans cette remise à
           zéro, une brique à borne 0 garderait un compte fantôme au tour
           suivant, et le crible trouverait des multiensembles impossibles. */
        counts[index]=0
        return false
    }
    step(0,0)
    /* Le tri final n'a de sens que si les états sont conservés. Un `emit` les a
       déjà pris au passage, dans l'ordre du compteur, donc trier ne servirait
       qu'à déplacer un tableau que personne ne lira. */
    if(collect) states.sort((a,b)=>a.mass-b.mass)
    return {states,visited,truncated}
}

/* Le plus grand indice non nul, -1 si le vecteur est nul.

   Le crible à base mixte n'a pas d'état dans le tas, donc aucune règle ne lui
   impose de porter cette information — il la recalcule à chaque frappe, ce qui
   est le bon calcul ici. Le nom dit ce qu'il renvoie, et c'est bien le dernier
   indice ajouté qui sert de règle dans l'autre stratégie. */
function lastNonZero(counts){
    for(let i=counts.length-1;i>=0;i--){
        if(counts[i]) return i
    }
    return -1
}
/* -------------------------------------------------------------------------
   L'APPARIEMENT — le point le plus proche, en O(log n).

   La question que pose un spectre: « de combien cette masse s'écarte-t-elle de
   ce que je vois? ». La réponse se cherche par dichotomie sur un index TRIÉ.

   LE TRI EST PAYÉ UNE FOIS, ET C'EST LA RÉPONSE À LA CRITIQUE DU TRI.
   Trier coûte O(n log n) sur les points du spectre, et il n'est refait qu'une
   fois par spectre. La comparaison, elle, est O(log n) par masse candidate —
   donc le coût total est O(n log n + k log n) en n points et k candidats, et
   NON O(k·n). Une recherche linéaire par candidate donnerait exactement ce
   qu'on veut éviter: un nœud mort sur un grand spectre.

   C'est le compromis explicite entre l'énumération NON triée d'Igor et le coût
   d'un tri: on paie une fois, on économise à chaque candidat. */
class SortedPoints{
    constructor(x,y=[]){
        this.x=x??[]
        this.y=y??[]
        /* L'index est un tableau d'indices PERMUTÉS, pas une copie des masses.
           Copier les masses coûterait deux fois la mémoire d'un spectre de
           plusieurs millions de points, alors que seul l'ordre relatif est
           nécessaire. */
        this.order=Array.from({length:this.x.length},(_,i)=>i)
        this.order.sort((a,b)=>this.x[a]-this.x[b])
    }
    get length(){ return this.order.length }
    //la masse du i-ème point DANS L'ORDRE TRIÉ
    massAt(rank){ return this.x[this.order[rank]] }
    /* Le point le plus proche de `mz`, ou null.

       Seuls les deux voisins peuvent l'être: tout ce qui précède est en
       dessous, tout ce qui suit au-dessus. C'est la même conclusion que
       `nearestByMz` dans chemistry.js, et pour la même raison. */
    nearest(mz){
        const n=this.order.length
        if(!n) return null
        let low=0
        let high=n
        while(low<high){
            const middle=(low+high)>>1
            if(this.massAt(middle)<mz) low=middle+1
            else high=middle
        }
        let bestIndex=-1
        let bestDistance=Infinity
        for(const rank of [low-1,low]){
            if(rank<0||rank>=n) continue
            const index=this.order[rank]
            const mass=this.x[index]
            /* une masse nulle n'a pas de ppm: la diviser rendrait l'écart infini
               et le point le plus proche d'une formule deviendrait le premier du
               spectre, qui n'est pas une mesure. */
            if(!Number.isFinite(mass)||mass===0) continue
            const distance=Math.abs(mass-mz)
            if(distance<bestDistance){
                bestDistance=distance
                bestIndex=index
            }
        }
        if(bestIndex<0) return null
        const mass=this.x[bestIndex]
        return {
            index:bestIndex,
            mz:mass,
            intensity:this.y[bestIndex]??0,
            //le défaut de masse RELATIF, en ppm, comme partout ailleurs
            errorPpm:(mass-mz)/mz*1e6
        }
    }
}

/* -------------------------------------------------------------------------
   L'ÉTAT → LA FORMULE.

   Un état du crible est un vecteur de multiplicités, rien de lisible. Il faut
   le rendre à la chimie, et le faire par la COMPOSITION, pas par une chaîne:
   accumuler les briques dans une Map puis la passer à Formula est exact, alors
   que fabriquer une notation puis la relire ferait dépendre le résultat d'une
   grammaire d'écriture.

   La charge vient des adduits EMPLOYÉS, et non d'une hypothèse: c'est la somme
   des charges des briques ionisantes retenues. Le manque de l'électron, lui,
   n'est appliqué qu'ici — une fois, au moment de la masse de l'ion. */
function stateToFormula(plan,state){
    const composition=new Map()
    /* La charge et la probabilité viennent des estimateurs, pas d'un second
       calcul: c'est la sélection par point qui a déjà décidé de garder cet
       état sur la foi de CES chiffres, donc les recalculer ici risquerait de
       contredire le classement — et le symptôme serait une liste qui garde une
       formule qu'elle venait de rejeter. */
    const charge=estimateCharge(plan,state.counts)
    const logProbability=estimateLogProbability(plan,state.counts)
    const ionisation=[]
    const recipe=[]
    for(let i=0;i<plan.items.length;i++){
        const times=state.counts[i]
        if(!times) continue
        const item=plan.items[i]
        /* LA COMPOSITION EST DÉJÀ LUE, pour les deux genres de briques.

           Elle l'est toujours maintenant, parce que `buildItems` la lit une fois
           pour chacune. Les deux branches qui coexistaient — « l'adduit
           apporte sa Map, la brique se relit » — se réduisent à une seule, et
           c'est la conséquence directe de la prélecture: le chemin lent
           disparaît au lieu d'être évité.

           `mergeComposition` additionne la source dans la cible et ne l'écrit
           jamais, donc la Map du plan est partagée sans être altérée. */
        mergeComposition(composition,item.composition,times)
        if(item.kind==="ionising"&&item.ionisation){
            for(let k=0;k<times;k++) ionisation.push(...item.ionisation)
        }
        recipe.push({
            group:item.groupNotation,
            key:item.key,
            notation:item.notation,
            kind:item.kind,
            times
        })
    }
    //ni squelette ni charge: il n'y a rien à écrire, et une formule vide
    //aurait une masse de zéro qui s'attacherait au premier point du spectre
    if(!composition.size&&!charge) return null
    const formula=new Formula({
        composition,
        ionisation,
        charge,
        rule:plan.rule,
        table:plan.table
    })
    return {formula,recipe,logProbability,charge}
}

/* -------------------------------------------------------------------------
   L'ATTRIBUTION — le geste complet, pour UN spectre.

   L'ordre des étapes est celui de la physique, et il n'est pas négociable:

     1. le plan lit les deux listes et fige les fenêtres
     2. le plafond de masse est la PLUS GRANDE masse du spectre
     3. le crible énumère les combinaisons par masse croissante
     4. la fenêtre d'ionisation ÉLIMINE ce qui n'a pas la bonne charge
     5. chaque survivant devient une formule, puis un point, puis une erreur

   La 2 mérite un mot: le plafond est une MASSE, et le spectre donne des m/z.
   On convertit par la charge la plus forte qu'on autorise, parce que c'est elle
   qui donne le plus grand nombre de masse possible dans la fenêtre: un 2+ à
   800 a besoin de 1600 de masse, un 1+ à 800 de 800. On prend donc la borne
   large, et la borne étroite raterait toutes les charges multiples. */
/* DEUX ESTIMATEURS, et ils sont EXACTS — donc des FONCTIONS, pas des
   approximations.

   La sélection par point doit comparer le m/z d'un état à celui du suivant AVANT
   que quiconque ne sache de quoi il s'agit: si l'estimation était fausse, la
   dichotomie chercherait au mauvais endroit, donc chaque formule serait
   attribuée au mauvais pic, donc le classement serait faux — et le résultat
   aurait l'air plausible.

   La charge d'un état est la somme des charges des briques ionisantes EMPLOYÉES.
   La probabilité est la somme des log-probabilités, multipliées par leur
   multiplicité. Ce sont exactement les deux lignes que `stateToFormula` fait
   déjà, donc `stateToFormula` les APPELLE au lieu de les recalculer: les
   dupliquer ici ferait deux sources de vérité, capables de se contredire le
   jour où l'une change — et le symptôme serait un classement faux, sans aucun
   signal. Une fonction ne « partage » rien dans le sens de l'héritage: elle
   donne la même réponse à la même question, et c'est tout ce qu'on lui demande. */
/* L'IDENTITÉ D'UN ÉTAT, et c'est la COMPOSITION, pas le vecteur.

   Deux multiensembles de briques qui donnent la même composition donnent la même
   formule — donc le même m/z, donc le même pic, donc le même écart en ppm. Ce
   sont deux CHEMISES d'une lecture, pas deux lectures.

   On s'en sert pour désambiguïser `bestMatches`, et le calcul se fait par
   ADDITION des compositions des briques déjà lues: pas de chaîne à construire,
   pas de `Formula` à instancier. Le vecteur de multiplicités ne suffirait pas —
   c'est exactement le défaut qu'il doit corriger. */
function stateSignature(plan,counts){
    const total=new Map()
    for(let i=0;i<plan.items.length;i++){
        const times=counts[i]
        if(!times) continue
        for(const [element,byA] of plan.items[i].composition)
            for(const [A,n] of byA){
                const slot=element.symbol+A
                total.set(slot,(total.get(slot)??0)+n*times)
            }
    }
    /* Le TRI des slots n'est pas décoratif: deux chemins d'accumulation
       différents visiting the same atoms must not produce two strings,
       or "same formula" would depend on the order the bricks were merged. */
    return [...total].sort((a,b)=>a[0]<b[0]?-1:a[0]>b[0]?1:0)
        .map(([slot,n])=>slot+":"+n).join("|")
}

function estimateCharge(plan,counts){
    let charge=0
    for(let i=0;i<plan.items.length;i++){
        if(counts[i]) charge+=plan.items[i].charge*counts[i]
    }
    return charge
}
function estimateLogProbability(plan,counts){
    let logProbability=0
    for(let i=0;i<plan.items.length;i++){
        if(counts[i]) logProbability+=plan.items[i].logProbability*counts[i]
    }
    return logProbability
}

/* LA STRATÉGIE PAR DÉFAUT EST « base mixte », et c'est un CHANGEMENT DE
   DÉFAUT, donc il se justifie par la mesure.

   Les deux cribles rendent EXACTEMENT le même ensemble — un test les compare, et
   je l'ai vérifié à ratio 0.01 sur la fixture: 350 816 états de part et d'autre,
   mêmes vecteurs. Ce n'est donc pas un arbitrage entre deux réponses différentes,
   c'est le même calcul par deux chemins.

   Sur cette fixture, en minimum de 7 exécutions:

       ratio   tas      base mixte
       0.01    1 359 ms     468 ms
       0.02       52 ms      28 ms
       0.1        52 ms      24 ms

   Et à ratio 0 — le réglage que l'écran propose en premier — le tas ne rend
   RIEN: `RangeError: Set maximum size exceeded`. La base mixte, elle, termine.
   Elle n'a besoin d'aucune table de « déjà vu »: un compteur parcourt chaque
   multiensemble une fois par construction, donc rien à stocker, rien qui
   puisse saturer.

   CE QUE ÇA COÛTE, et il faut le dire: le tas rend par masse croissante SANS
   jamais matérialiser l'espace, sa mémoire est celle du FRONTIÈRE. La base
   mixte construit tous les états puis les trie. Sur un espace de 350 816 états
   cela va; sur un espace de dix millions cela coûterait de la mémoire que le
   tas n'aurait pas eu. C'est pourquoi `heap` reste disponible, et pourquoi
   `cribleHeap` n'est pas supprimé: c'est lui qui sait marcher quand l'espace
   dépasse la mémoire. */
function attributeSpectrum(plan,points,{limit=Infinity,ppm=null,bestMatches=null,strategy="mixedRadix"}={}){
    const started=Date.now()
    const sorted=points instanceof SortedPoints
        ?points
        :new SortedPoints(points?.x??[],points?.y??[])
    const attribution={
        entries:[],
        diagnostics:[...plan.diagnostics],
        visited:0,
        truncated:false,
        matched:0,
        pointCount:sorted.length,
        elapsedMs:0
    }
    if(!plan.itemCount){
        attribution.diagnostics.push("no group to combine: nothing to attribute")
        return attribution
    }
    if(!sorted.length){
        attribution.diagnostics.push("the spectrum has no point: nothing to match against")
        return attribution
    }
    const maxMass=plan.massCeiling(sorted)
    const minMass=plan.massFloor(sorted)
    const crible=strategy==="mixedRadix"?cribleMixedRadix:cribleHeap
    /* UNE SÉLECTION OU PAS, et la place du crible change avec.

       `bestMatches === null` veut TOUT: chaque état rendu devient une ligne, donc
       il faut la liste, donc le crible la construit.

       `bestMatches` numérique ne veut que quelques formules par pic, donc il lui
       suffit d'un crochet: le crible range chaque état au passage et n'en garde
       aucun. Les deux chemins partagent le même crible et la même
       `withinCharge`; seul l'appel change.

       On ne peut pas le savoir avant d'avoir lu `bestMatches`, alors la
       DÉCISION se prend ici et le `if` de la fin ne garde que le rendu direct. */
    const selecting=bestMatches!==null&&bestMatches!==undefined
    const keepMatches=selecting?Math.max(1,Math.trunc(bestMatches)||1):1
    const best=new Map()
    const rank=selecting?(state)=>{
        /* `state.counts`, et non `state`: les multiplicités sont dans le VECTEUR,
           pas sur l'état lui-même. Passer l'objet entier donnait `counts[i]`
           valant `undefined` à l'estimateur, donc une charge de NaN, donc un m/z
           de NaN, donc une dichotomie qui ne trouvait rien — et une sélection
           qui rendait zéro sans jamais se tromper visiblement. */
        const charge=estimateCharge(plan,state.counts)
        /* LE NEUTRE EST UNE LECTURE, PAS UNE DIVISION PAR ZÉRO.

           Le refus d'origine disait « une charge nulle n'a pas de m/z, donc
           `mass/0` vaut Infinity ». C'est FAUX, et c'était mesuré:
           `Formula.mz` fait `mass/Math.abs(charge||1)`, donc un neutre rend sa
           MASSE — la bonne valeur. L'obstacle réel était ce `return`.

           Et l'obstacle était un choix, pas une nécessité. Un utilisateur peut
           vouloir attribuer une liste de masses NEUTRES, ou sonder « 46.04186 »
           dans la sonde sans avoir à ajouter la masse du proton de tête. Dans
           les deux cas la réponse existe: la masse.

           Donc un neutre se range comme les autres, au m/z de sa masse. La
           fenêtre d'ionisation reste ce qui décide: un plan qui n'admet que
           des ions n'en produira pas, et un plan qui admet les deux rendra les
           deux. Rien n'est calculé « en plus » — un état à charge 0 était déjà
           produit et payé par le crible; on cessait de le jeter. */
        const target=sorted.nearest(state.mass/Math.max(1,Math.abs(charge)))
        if(!target) return
        const errorPpm=target.errorPpm
        /* hors fenêtre: cette formule n'est pas une proposition pour CE point,
           donc elle n'entre dans aucun classement */
        if(ppm!==null&&!(Math.abs(errorPpm)<=ppm)) return
        /* `point`, et non `rank`: le nom `rank` désigne la FONCTION qui range, et le
           lui laisser porter le rôle de l'indice du point serait une
           redéclaration dans sa propre portée — le fichier ne compilerait plus.
           Le nom dit ce que c'est: le point auquel la lecture est rattachée. */
        const point=target.index
        /* La probabilité est calculée ICI, pour chaque candidat, et non après
           le tri: elle sert de critère de départage, donc il faut la connaître
           avant de classer. C'est un parcours du vecteur de multiplicités — peu
           coûteux, et le crible le fait de toute façon pour chaque état. */
        const logProbability=estimateLogProbability(plan,state.counts)
        /* ON EMPILE LES CANDIDATS, on ne garde pas seulement le meilleur.

           C'est la condition pour que `bestMatches` ait un sens: sans empilement
           il n'y aurait qu'un gagnant par point et le réglage ne pourrait ni
           garder trois lectures d'un pic ambigu, ni rien faire d'autre que
           "j=1". Le seau par point est donc un TABLEAU, et le tri final le
           tronque — c'est le seul endroit où l'ordre par point existe. */
        const bucket=best.get(point)
        if(bucket) bucket.push({state,target,errorPpm,logProbability})
        else best.set(point,[{state,target,errorPpm,logProbability}])
    }:null
    /* LE CRIBLE, et il RANGE ou il LISTE selon ce qu'on lui demande. */
    const {states,visited,truncated}=crible(plan,{
        maxMass,
        minMass,
        limit,
        /* La fenêtre d'ionisation ne filtre que le RENDU: un état à charge 0
           doit être développé quand même, sinon il bloquerait l'accès à tous
           ses voisins — dont certains sont exactement à la bonne charge. */
        accept:state=>plan.withinCharge(state.counts)&&plan.groupWithin(state.counts),
        emit:selecting?rank:null
    })
    attribution.visited=visited
    attribution.truncated=truncated
    /* WHAT the truncation cut at, so a diagnostic can name a number instead of
       echoing a setting that may since have changed. The old wording read
       `parameters.limit` at render time, which is the user's CURRENT value, not
       the one the run used — so a report could accuse a run of a limit it never
       had. */
    if(truncated) attribution.truncationLimit=limit
    /* SÉLECTION PAR POINT — ou PAS, et le « pas » est le cas par défaut.

       `bestMatches` vaut `null` par défaut, et ça change tout: sans sélection,
       le crible rend TOUTES ses combinaisons admissibles, chacune avec son point
       le plus proche et son écart mesuré. C'est le comportement que le moteur
       avait avant, et c'est celui dont les tests ont la trace.

       Avec un nombre, on ne garde que les `bestMatches` meilleurs PAR POINT —
       et c'est un changement de NATURE, pas un réglage de confort: ça borne le
       travail en aval à `points × bestMatches` formules construites, au lieu de
       toutes. Mesuré sur une peak list de 95 ions : 29 381 combinaisons
       construites pour 344 utiles, contre 344 construites — donc un facteur 85
       sur la poste la plus chère.

       `null` et non `1` par défaut, parce que « une seule meilleure par pic » et
       « toutes les propositions » sont deux résultats DIFFÉRENTS, et un défaut
       qui en choisirait un pour l'utilisateur lui prendrait la décision sans le
       dire. Le nœud, lui, passe un nombre explicite. */
    if(!selecting){
        /* LE RENDU DIRECT: une formule par état rendu, avec son point et son
           écart. C'est le chemin d'origine, et il n'y a pas de sélection parce
           qu'il n'y en a pas demandé — donc le crible a construit la liste, et
           `states` est pleine. */
        for(const state of states){
            const built=stateToFormula(plan,state)
            if(!built) continue
            const {formula,recipe,logProbability}=built
            const mz=formula.mz
            if(!Number.isFinite(mz)||mz<=0) continue
            const target=sorted.nearest(mz)
            const errorPpm=target?target.errorPpm:null
            attribution.entries.push({
                formula,
                key:formula.key,
                notation:String(formula),
                mz,
                mass:formula.mass,
                charge:formula.charge,
                molecule:formula.moleculeKey,
                logProbability,
                recipe,
                target,
                errorPpm,
                inWindow:errorPpm!==null&&ppm!==null&&Math.abs(errorPpm)<=ppm
            })
            if(target) attribution.matched++
        }
        attribution.keptMatches=null
        attribution.survived=attribution.entries.length
        attribution.elapsedMs=Date.now()-started
        return attribution
    }
    /* LE TRI ET LA TRONCATURE, et c'est le seul endroit où l'ordre compte.

       Un seau par point, trié par écart croissant, puis à écart égal par
       PROBABILITÉ DÉCROISSANTE. Le second critère n'est pas un raffinement: sans
       lui, deux formules au même ppm seraient départagées par l'ordre
       d'énumération du crible, donc le résultat dépendrait de la marche, donc
       deux spectres identiques donneraient deux listes différentes. Le même pic
       lu par deux formules est ambigu, et l'ambiguïté doit se trancher sur ce
       que le plan croit probable — pas sur le hasard.

       Le seau n'est PAS trimé en mémoire pendant l'empilement: on garde tout par
       point, puis on trie, puis on coupe. Ça paraît contre-intuitif puisque
       l'empilement est précisément ce qu'on cherche à éviter, mais tronquer
       pendant l'empilement coûterait un tri à chaque insertion, donc un tri par
       CANDIDAT — 29 381 tris au lieu de 95. Ici il n'y a qu'un tri par point,
       donc au plus autant de tris que de pics, ce qui est négligeable. */
    const kept=[]
    for(const bucket of best.values()){
        bucket.sort((a,b)=>{
            const byError=Math.abs(a.errorPpm)-Math.abs(b.errorPpm)
            if(byError) return byError
            return b.logProbability-a.logProbability
        })
        /* LA DÉSAMBIGUÏTÉ, ET ELLE SE FAIT ICI, APRÈS LE TRI.

           Une lecture retenue doit être une formule DIFFÉRENTE de celles déjà
           retenues pour ce pic. Sans ce test, `bestMatches:3` peut rendre trois
           fois la même formule — c'est ce qui arrivait, et c'est mesuré: 285
           lectures pour 115 clés distinctes, dont 95 vues exactement trois fois.

           On trie D'ABORD par écart puis probabilité, puis on saute les doublons
           en gardant l'ordre. L'ordre est donc préservé, et le champion reste le
           champion: c'est le PREMIER de la liste qui part, jamais un suivant.

           `stateSignature` est une COMPOSITION, pas une chaîne d'un état: elle
           additionne les briques de l'état. C'est la même identité que
           `formula.key` sans la construction de la formule — donc on ne paie la
           formule qu'une fois, pour les `bestMatches` qu'on garde vraiment. C'est
           le genre de détail qui rend le test de désambiguïté réalisable au lieu
           d'idéal. */
        const signatures=new Set()
        let taken=0
        for(const candidate of bucket){
            if(taken>=keepMatches) break
            const signature=stateSignature(plan,candidate.state.counts)
            if(signatures.has(signature)) continue
            signatures.add(signature)
            taken++
            kept.push(candidate)
        }
    }
    attribution.keptMatches=keepMatches
    attribution.candidates=best.size
    attribution.survived=kept.length
    for(const candidate of kept){
        const {state,target,errorPpm,logProbability}=candidate
        const built=stateToFormula(plan,state)
        if(!built) continue
        const {formula,recipe}=built
        const mz=formula.mz
        /* un m/z non fini ne se compare à rien: une charge nulle donnerait une
           division par zéro, et une masse négative n'est pas un ion. */
        if(!Number.isFinite(mz)||mz<=0) continue
        /* NI `target` NI `errorPpm` ne sont recalculés: ce sont ceux de la
           SÉLECTION, calculés sur le m/z ESTIMÉ. Les recalculer ici ferait deux
           dichotomies par formule et — pire — le classement se baserait sur une
           valeur et l'affichage en montrerrait une autre. La sélection a déjà
           fait le travail, et sa valeur est celle qu'on affiche. */
        attribution.entries.push({
            formula,
            key:formula.key,
            notation:String(formula),
            mz,
            mass:formula.mass,
            charge:formula.charge,
            molecule:formula.moleculeKey,
            logProbability,
            recipe,
            target,
            errorPpm,
            /* « dans la fenêtre » ne se décide pas ici. Une attribution est un
               PROPOSITION, et le seuil de ppm appartient à celui qui affiche.
               Ce qu'on note ici est le fait brut. */
            inWindow:errorPpm!==null&&ppm!==null&&Math.abs(errorPpm)<=ppm
        })
        if(target) attribution.matched++
    }
    attribution.elapsedMs=Date.now()-started
    return attribution
}

/* Le plan complet, lectures de listes comprises, prêt à être sérialisé.

   Un nœud ne construit pas son plan à la main: il appelle ceci, qui lit les
   deux listes, remplit `items` et rend un objet qui ne contient AUCUNE formule
   vivante — seulement des clés et des nombres. C'est ce qui permet de le
   garder dans une session sans ytrainer la table périodique. */
function buildPlan({combining=[],ionising=[],ratio=0,chargeMin=1,chargeMax=1,table=null,rule="mostProbable",chargeAuto=false}={}){
    const plan=new AttributionPlan({
        combining,ionising,ratio,chargeMin,chargeMax,table,rule,chargeAuto
    })
    plan.buildItems()
    return plan
}

/* LE PONT: ce que le plan transmet au kernel, et RIEN D'AUTRE.

   Le kernel ne connaît ni la chimie, ni les groupes par leur nom, ni les
   estimateurs: il reçoit les nombres que le plan a DÉJÀ résolus. Les recomposer
   ici serait un second oracle — et le test de parité le verrait tout de suite,
   puisque deux estimateurs qui divergent à l'arrondi donnent deux classements
   différents sur une égalité de ppm. */
function planForKernel(plan){
    const fixedGroups=new Map()
    for(const [index,item] of plan.items.entries()){
        const group=item.groupIndex
        if(fixedGroups.has(group)) continue
        const min=item.groupMin??0
        const max=item.groupMax??Infinity
        if(!Number.isFinite(max)||min!==max) continue
        const members=[]
        for(let i=0;i<plan.items.length;i++) if(plan.items[i].groupIndex===group) members.push(i)
        fixedGroups.set(group,{count:min,members})
    }
    const bridge={
        itemMasses:plan.items.map(item=>item.atomicMass),
        itemCharges:plan.items.map(item=>item.charge),
        logProbs:plan.items.map(item=>item.logProbability),
        /* Les MEMBRES par groupe, la tête en PREMIER — c'est la convention que le
           kernel attend, et elle est la même que celle du crible JS. */
        fixed:[...fixedGroups.values()]
    }
    /* LA CLÉ EST OMISE, PAS MISE À NULLE: le kernel distingue « pas de
       dépendance » de « dépendance présente mais illisible ». Un `null` ferait
       échouer le kernel sur un plan parfaitement valide — et le message dirait
       « dépendance vide », ce qui enverrait chercher un bug de plan inexistant.
       C'est le même soin que `plan.dependence` à null côté plan. */
    if(plan.dependence){
        bridge.dependence={take:plan.dependence.take,give:plan.dependence.give}
    }
    return bridge
}

export {
    AttributionPlan,
    SortedPoints,
    MassHeap,
    atomicMassOf,
    mergeComposition,
    lastNonZero,
    normaliseGroups,
    saneBound,
    saneRatio,
    cribleHeap,
    cribleMixedRadix,
    stateToFormula,
    attributeSpectrum,
    planForKernel,
    buildPlan
}

/* ===========================================================================
   LA PROPAGATION DANS UN RÉSEAU — et ce n'est PAS une attribution.

   Un lien du réseau dit une chose très précise: les pics `u` et `v` diffèrent
   d'exactement la masse de référence `s`. Ce n'est pas une ressemblance, c'est
   une ÉGALITÉ que le noyau a vérifiée dans la fenêtre de lien.

   DONC, si l'on connaît la formule d'un seul pic d'un groupe, la formule de
   tous les autres s'en DÉDUIT: on ajoute ou on retire la référence du lien, et
   on recommence. Ce n'est pas une hypothèse, c'est de l'arithmétique — et c'est
   ce qui rend la chose utile: chaque sommet reçoit une formule PRÉDITE, qu'on
   compare à sa masse MESURÉE, et l'écart se lit en ppm.

   C'est un contrôle qualité, et il est le seul des trois qui puisse échouer:

     — l'attribution du crible part des masses balayées et remonte vers les
       formules: elle peut se tromper de formule;
     — la propagation part d'une formule et descend le long d'égalités vérifiées:
       elle peut se tromper de RACINE, et c'est tout. Si elle se trompe, elle se
       trompe d'un facteur de formule entier pour TOUT le groupe, et chaque
       sommet le dira dans le même sens.

   LA CHARGE N'EST PAS VÉRIFIÉE ICI, et c'est volontaire. Les références sont
   déjà divisées par z, donc un écart de m/z de `masse_s / z` signifie « masse
   plus masse_s, à la même charge ». Si un voisin est réellement doublement
   chargé, la formule propagée est fausse — et elle le dira à hauteur de la
   demie masse de l'électron, soit 0.0005 Da. Refuser ce cas ici serait cacher
   l'information qui compte; la laisser apparaître, c'est la laisser juger.
   =========================================================================== */

/* UNE COMPOSITION COPIÉE, parce qu'une Map d'atomes mutée en place ferait
   remonter l'addon chez le parent: tous les sommets du groupe finiraient par
   porter la formule du plus gros. C'est le genre de faute qui n'apparaît qu'à
   la deuxième image. */
function copyComposition(source){
    const copy=new Map()
    for(const [element,byA] of source??[]){
        copy.set(element,new Map(byA))
    }
    return copy
}


/* LA FORMULE D'UN SOMMET, ou null si elle n'a pas pu être construite.

   Un `Formula` sans charge ne donne pas de m/z — il donnerait Infinity — donc
   une formule sans charge n'est pas une formule d'ion et ne vaut rien. Elle est
   rendue nulle, et le sommet sera compté parmi ceux que la propagation n'a pas
   atteint. Une exception sur une composition bizarre ne tue pas la propagation
   non plus: elle rend ce sommet nul, et le groupe continue autour de lui. */
function formulaFrom(composition,charge,rootFormula,table){
    const filled=[...(composition?.values()??[])]
        .some(byA=>[...byA.values()].some(n=>n>0))
    if(!filled) return null
    const chargeOf=charge??rootFormula?.charge
    if(!Number.isFinite(chargeOf)||chargeOf===0) return null
    try{
        return new Formula({
            composition,
            charge:chargeOf,
            ionisation:rootFormula?.ionisation??[],
            rule:rootFormula?.rule??"mostProbable",
            table:table??rootFormula?.table??null
        })
    }catch{
        return null
    }
}

/* LA PROPAGATION, et elle rend aussi ce qu'elle n'a PAS su faire.

   `references` est indexé comme `link.standard`: l'entrée i est la formule de la
   référence i. Un lien dont la référence est absente ou illisible arrête la
   propagation AU-DELÀ — il ne la fausse pas. Un groupe coupé en deux par une
   référence inconnue est un groupe qu'on a mal construit, pas un groupe dont on
   a inventé la fin. */
export function propagateForest(graph,rootFormula,references,{table=null}={}){
    const vertices=graph?.vertices??[]
    if(!vertices.length||!rootFormula) return null
    const byIndex=new Map(vertices.map(vertex=>[vertex.index,vertex]))
    const startIndex=byIndex.has(graph.rootIndex)
        ?graph.rootIndex
        :vertices[0].index
    const charge=rootFormula.charge
    const rootFormulaBuilt=formulaFrom(
        copyComposition(rootFormula.composition),charge,rootFormula,table)
    if(!rootFormulaBuilt) return null
    const assigned=new Map([[startIndex,{formula:rootFormulaBuilt,sign:0,depth:0}]])

    /* LA FILE, et elle porte le SENS du lien. Chaque sommet reçoit le lien par
       lequel on l'a atteint et le signe de ce lien, donc un cycle ne peut pas
       faire osciller une formule: le second passage trouve le sommet déjà
       attribué et s'arrête.
       LA TABLE D'ADJACENCE: l'ancien balayage re-parcourait TOUS les liens à
       chaque sommet dépilé — O(V×E), ~10⁶ tours sur un arbre de 1000 sommets,
       d'où le freeze au changement de racine. Ici chaque lien est visité au
       plus deux fois (une par bout) — O(V+E). La file avance par index, pas
       par `shift()` (O(n) à chaque pas). Même ordre de visite, même résultat:
       les voisins d'un sommet sont lus dans l'ordre des liens, et chaque lien
       n'est franchi qu'une fois (`reachedLinks`). */
    const neighbours=new Map()
    for(const link of graph.links??[]){
        if(!neighbours.has(link.u)) neighbours.set(link.u,[])
        if(!neighbours.has(link.v)) neighbours.set(link.v,[])
        neighbours.get(link.u).push(link)
        if(link.v!==link.u) neighbours.get(link.v).push(link)
    }
    const queue=[startIndex]
    let head=0
    const reachedLinks=new Set()
    const edges=[]
    let unattributed=0
    while(head<queue.length){
        const current=queue[head++]
        const here=assigned.get(current)
        for(const link of neighbours.get(current)??[]){
            if(reachedLinks.has(link)) continue
            const isU=link.u===current
            if(!isU&&link.v!==current) continue
            const reference=references?.[link.standard]
            /* UNE RÉFÉRENCE INCONNUE ARRÊTE ICI, et elle n'est pas devinée: la
               formule d'une brique qu'on n'a pas lue serait un mensonge, et il
               se propagerait à tout l'arbre avec l'air d'une mesure. */
            if(!reference) continue
            reachedLinks.add(link)
            /* LE SENS. `u < v` dans les masses, et l'écart vaut la référence:
               donc v est u PLUS la référence. Atteint par u on ajoute, atteint
               par v on retire — et c'est la seule chose que le lien porte. */
            const child=isU?link.v:link.u
            if(assigned.has(child)) continue
            const composition=copyComposition(here.formula.composition)
            /* `mergeComposition` additionne la source dans la cible sans jamais
               l'écrire, donc la composition de la référence — celle du PLAN,
               partagée — reste intacte. */
            mergeComposition(composition,reference.composition,isU?1:-1)
            const built=formulaFrom(composition,charge,rootFormula,table)
            if(!built){ unattributed++; continue }
            assigned.set(child,{formula:built,sign:isU?1:-1,depth:here.depth+1})
            edges.push({
                u:link.u,v:link.v,standard:link.standard,
                label:link.label??null,sign:isU?1:-1
            })
            queue.push(child)
        }
    }


    /* L'ERREUR, SOMME ET NON MOYENNE. Un groupe est une chaîne de pics liés, et
       chaque maillon peut se tromper dans le même sens; la somme s'accumule
       donc, et la moyenne la diviserait par le nombre de sommets — ce qui ferait
       passer un groupe de cent maillons faux pour un groupe à un pic juste.
       C'est la somme qui répond à « cette molécule tient-elle debout ? ». */
    const rows=[]
    let totalAbs=0
    for(const vertex of vertices){
        const hit=assigned.get(vertex.index)
        if(!hit) continue
        const mz=hit.formula.mz
        const errorPpm=Number.isFinite(mz)&&mz>0
            ?(vertex.mass-mz)/mz*1e6
            :null
        const absolute=errorPpm===null?Infinity:Math.abs(errorPpm)
        if(Number.isFinite(absolute)) totalAbs+=absolute
        rows.push({
            index:vertex.index,
            mass:vertex.mass,
            formula:hit.formula,
            notation:String(hit.formula),
            mz,
            errorPpm,
            depth:hit.depth,
            sign:hit.sign
        })
    }
    unattributed+=vertices.length-rows.length
    rows.sort((a,b)=>(b.depth-a.depth)||(a.mass-b.mass))
    return {
        rootIndex:startIndex,
        rows,
        edges,
        unattributed,
        totalAbsPpm:totalAbs,
        meanAbsPpm:rows.length?totalAbs/rows.length:0,
        worstAbsPpm:rows.reduce(
            (n,row)=>Math.max(n,Math.abs(row.errorPpm??Infinity)),0)
    }
}
