/* =========================================================================
   LE FUNNEL MASK — le centre de calcul et de choix isotopique.

   Le crible propose, pour un pic, plusieurs formules classées par écart en
   masse. Deux compositions isobares restent indistinguables sur ce seul
   critère. Ce qu'elles ne partagent pas, c'est leur RAPPORT ISOTOPIQUE : le
   nombre de carbones se lit dans `I(M+1)/I(M)`, le soufre dans `I(M+2)/I(M)`,
   etc.

   Un rapport isotopique met TOUJOURS en jeu deux pics et deux formules qui ne
   diffèrent que d'un atome. C'est pourquoi ce module ne juge pas une lecture
   seule : il apparie des lectures entre elles.

   RÈGLE DE DIRECTION. On ne compare que l'espèce de BASE — celle qui ne porte
   aucun atome de l'isotope lourd choisi (13C0) — à son premier enrichissement
   (13C1). Un rapport calculé entre 13C1 et 13C2 mesurerait autre chose que
   l'abondance naturelle, et n'a rien à faire dans la valeur théorique.

   TROIS SOURCES, dans cet ordre :

     1. une permutation DÉJÀ PROPOSÉE : les deux formules sont dans le crible ;
     2. une permutation SIMULÉE : la formule lourde est calculée (masse du pic
        de base + écart isotopique), puis on cherche le pic réel dans la
        fenêtre ppm. L'erreur mesurée de la base est reportée sur la prédiction,
        parce que la calibration décale les deux satellites de la même façon ;
     3. rien : le pic n'a pas de partenaire, il ne produit aucun rapport.

   Tout est pur ici : aucun DOM, aucun état, aucune collection. Les entrées
   sont celles du crible (`entries`), le spectre est un objet qui sait rendre
   `nearest(mz)`. Le rendu et la décision restent à l'appelant.
   ========================================================================= */

/* L'ÉTAT D'UNE FORMULE, en comptes PAR ISOTOPE.

   `formula.composition` est une Map<Element, Map<A,count>>. On la recopie en
   Map<symbole, Map<A,count>>, parce que tout le module compare des symboles et
   jamais des objets Element : deux instances de la table sont égales par ce
   qu'elles écrivent, pas par leur identité. */
function atomsOf(formula){
    const atoms=new Map()
    for(const [element,byA] of formula?.composition??[]){
        const counts=new Map()
        for(const [A,count] of byA) if(count) counts.set(A,count)
        atoms.set(element.symbol,counts)
    }
    return atoms
}

/* Une composition ÉCRITE, stable et comparable. Les 0 sont écartés pour que
   deux Map qui ne diffèrent que par une clé nulle tombent ensemble. */
function atomsSignature(atoms){
    const symbols=[...atoms.keys()].sort()
    const parts=[]
    for(const symbol of symbols){
        const byA=atoms.get(symbol)
        const codes=[...byA.entries()].filter(([,count])=>count)
            .sort((a,b)=>a[0]-b[0])
        if(!codes.length) continue
        parts.push(`${symbol}:${codes.map(([A,count])=>`${A}=${count}`).join(",")}`)
    }
    return parts.join("|")
}

/* La même composition, avec UN atome converti. `null` si l'élément est absent
   ou si l'isotope source manque : il n'y a alors rien à convertir. */
function convertOne(atoms,symbol,fromA,toA){
    const byA=atoms.get(symbol)
    if(!byA) return null
    const from=byA.get(fromA)??0
    if(from<1) return null
    const copy=new Map()
    for(const [key,value] of atoms){
        copy.set(key,new Map(value))
    }
    const target=copy.get(symbol)
    const remaining=from-1
    if(remaining>0) target.set(fromA,remaining)
    else target.delete(fromA)
    target.set(toA,(target.get(toA)??0)+1)
    return copy
}

function countOf(atoms,symbol,A){
    return atoms.get(symbol)?.get(A)??0
}

function totalOf(atoms,symbol){
    let total=0
    for(const count of atoms.get(symbol)?.values()??[]) total+=count
    return total
}

/* L'ABONDANCE D'UN ISOTOPE, avec la convention de la table : `null` vaut 1
   pour un élément mono-isotopique, qui n'est pas « d'abondance inconnue » mais
   certain. */
function abundanceOf(element,A){
    const isotope=element?.isotope?.(A)
    return isotope?(isotope.abundance??1):null
}

function massOf(element,A){
    const isotope=element?.isotope?.(A)
    return isotope&&Number.isFinite(isotope.mass)?isotope.mass:null
}

/* La clé d'un point + d'une lecture, pour ne compter qu'une fois la même
   proposition qu'un crible peut produire deux fois. */
function candidateId(point,key){
    return `${point}\u0000${key}`
}

/* LES LECTURES DU CRIBLE, normalisées et DÉDUPLIQUÉES.

   Une entrée du crible est déjà un couple (formule, pic) : `target.index`
   désigne le pic, `target.intensity` sa hauteur, `errorPpm` l'écart. On ne
   garde que les lectures qui ONT un pic — une formule sans cible n'a pas
   d'intensité, donc pas de rapport.

   Le doublon (même formule, même pic) ne compte pas deux fois : le chemin
   kernel peut le produire quand deux compositions dépendantes se ressemblent,
   et le compter deux fois doublerait silencieusement une intensité. */
export function normaliseCandidates(entries){
    const seen=new Set()
    const candidates=[]
    for(const entry of entries??[]){
        const point=entry?.target?.index
        const key=entry?.key
        if(point===undefined||point===null) continue
        if(typeof key!=="string") continue
        if(!entry.formula) continue
        const id=candidateId(point,key)
        if(seen.has(id)) continue
        seen.add(id)
        const atoms=atomsOf(entry.formula)
        const measuredMz=Number.isFinite(entry.target?.mz)?entry.target.mz:entry.mz
        candidates.push({
            point,
            key,
            formula:entry.formula,
            entry,
            atoms,
            signature:atomsSignature(atoms),
            mz:Number(entry.mz),
            measuredMz:Number(measuredMz),
            intensity:Number(entry.target?.intensity??0),
            errorPpm:Number.isFinite(entry.errorPpm)
                ?entry.errorPpm
                :(Number.isFinite(entry.target?.errorPpm)?entry.target.errorPpm:null),
            charge:Number(entry.charge??entry.formula?.charge??0)
        })
    }
    return candidates
}

/* LES ÉLÉMENTS PRÉSENTS DANS LES PROPOSITIONS, avec leurs isotopes observés.

   L'écran ne propose que ce qui peut être lu : un élément qui n'apparaît dans
   aucune proposition ne produira jamais de paire, et l'offrir serait promettre
   un calcul qui ne rendra rien. Les isotopes sont ceux de la table, ordonnés
   par A croissant — c'est l'ordre où l'on écrit ¹²C puis ¹³C. */
export function elementsInProposals(entries){
    const found=new Map()
    for(const entry of entries??[]){
        for(const [element,byA] of entry?.formula?.composition??[]){
            let record=found.get(element.symbol)
            if(!record){
                /* TOUS les isotopes de la table, pas seulement ceux observés :
                   choisir « 13C » doit rester possible alors qu'aucune
                   proposition ne le porte encore — c'est précisément le cas
                   que la simulation doit couvrir. `count` dit, à côté, ce que
                   les propositions contiennent réellement. */
                record={
                    symbol:element.symbol,
                    element,
                    proposalCount:0,
                    isotopes:[...element.isotopes]
                        .sort((a,b)=>a.A-b.A)
                        .map(isotope=>({
                            A:isotope.A,
                            count:0,
                            mass:isotope.mass,
                            abundance:isotope.abundance??1
                        }))
                }
                found.set(element.symbol,record)
            }
            record.proposalCount++
            for(const [A,count] of byA){
                if(!count) continue
                const known=record.isotopes.find(isotope=>isotope.A===A)
                if(known) known.count+=count
            }
        }
    }
    const list=[...found.values()]
    return list.sort((a,b)=>b.proposalCount-a.proposalCount||(a.symbol<b.symbol?-1:1))
}

/* LA MOITIÉ DU TRAVAIL : trouver les paires DÉJÀ proposées.

   Une paire est valide si la base ne porte aucun atome de l'isotope lourd et si
   une lecture de même molécule porte EXACTEMENT un atome de cet isotope, le
   reste de la composition étant identique. On ne compare pas les formules
   entre elles : on calcule la composition attendue du frère lourd, puis on la
   cherche dans un index. Chaque base coûte donc une recherche, pas un parcours
   de toutes les autres. */
function indexBySignature(candidates){
    const index=new Map()
    for(const candidate of candidates){
        const list=index.get(candidate.signature)
        if(list) list.push(candidate)
        else index.set(candidate.signature,[candidate])
    }
    return index
}

export function findProposedPermutations(candidates,{symbol,lightA,heavyA}={}){
    const index=indexBySignature(candidates)
    const pairs=[]
    for(const candidate of candidates){
        if(countOf(candidate.atoms,symbol,heavyA)!==0) continue
        const sibling=convertOne(candidate.atoms,symbol,lightA,heavyA)
        if(!sibling) continue
        const matches=index.get(atomsSignature(sibling))
        if(!matches) continue
        for(const heavy of matches){
            if(heavy===candidate) continue
            if(heavy.point===candidate.point) continue
            if(countOf(heavy.atoms,symbol,heavyA)!==1) continue
            pairs.push({light:candidate,heavy,simulated:false})
        }
    }
    return pairs
}

/* LE RAPPORT, ET SON ÉCART À LA PHYSIQUE.

   `N` est le nombre TOTAL d'atomes de l'élément dans la molécule : la
   probabilité qu'un atome donné soit lourd est `p`, donc le rapport
   `I(M+1)/I(M)` vaut environ `N·p/q`. Le ratio isotopique cherché est donc
   `(I(M+1)/I(M))/N`, et `delta` est son écart RELATIF au rapport naturel. */
export function isotopeRatio({lightIntensity,heavyIntensity,atoms,theoretical}){
    if(!(lightIntensity>0)||!(heavyIntensity>=0)||!(atoms>0)) return null
    if(!(theoretical>0)) return null
    const ratio=(heavyIntensity/lightIntensity)/atoms
    return {ratio,delta:ratio/theoretical-1}
}

function compositionDiff(fromAtoms,toAtoms){
    const symbols=new Set([...fromAtoms.keys(),...toAtoms.keys()])
    const terms=[]
    for(const symbol of [...symbols].sort()){
        const from=fromAtoms.get(symbol)
        const to=toAtoms.get(symbol)
        const As=new Set([...(from?.keys()??[]),...(to?.keys()??[])])
        let total=0
        const shifts=[]
        for(const A of [...As].sort((a,b)=>a-b)){
            const delta=countOf(toAtoms,symbol,A)-countOf(fromAtoms,symbol,A)
            total+=delta
            if(delta) shifts.push({symbol,A,delta})
        }
        if(total) terms.push({symbol,delta:total})
        else terms.push(...shifts)
    }
    const encode=list=>list
        .map(term=>term.A===undefined
            ?`${term.symbol}:${term.delta>0?"+":""}${term.delta}`
            :`${term.symbol}${term.A}:${term.delta>0?"+":""}${term.delta}`)
        .join(",")
    const signed=encode(terms)
    const negated=encode(terms.map(term=>({...term,delta:-term.delta})))
    return {terms,signed,negated,key:signed<negated?signed:negated}
}

/* LE CŒUR : tous les rapports d'un spectre pour un couple d'isotopes.

   `peakList` n'est requis que pour la simulation : il doit exposer
   `nearest(mz)` rendant `{index,mz,intensity,errorPpm}` ou null. `ppm` est la
   fenêtre de lecture, appliquée aux satellites simulés — une permutation
   proposée, elle, a déjà été retenue par le crible.

   `marriageByPoint` est optionnel : sans lui, le « mariage temporaire » est la
   meilleure proposition en masse du pic, ce qui est exactement le défaut du
   crible. Le passer explicitement permet de tenir compte des choix de
   réinspection. */
export function computeFunnelMask({
    entries,peakList=null,element,lightA,heavyA,ppm=10,marriageByPoint=null
}={}){
    const candidates=normaliseCandidates(entries)
    const symbol=typeof element==="string"?element:element?.symbol
    const record=typeof element==="string"
        ?(elementsInProposals(entries).find(item=>item.symbol===symbol)?.element??null)
        :element
    const lightMass=massOf(record,lightA)
    const heavyMass=massOf(record,heavyA)
    const lightAbundance=abundanceOf(record,lightA)
    const heavyAbundance=abundanceOf(record,heavyA)
    const theoretical=(lightAbundance>0&&heavyAbundance!==null)
        ?heavyAbundance/lightAbundance
        :null
    const mask={
        element:symbol,
        lightA,heavyA,
        lightMass,heavyMass,
        adjacentMass:null,
        theoretical,
        lightAbundance,heavyAbundance,
        ppm:Number(ppm)>0?Number(ppm):10,
        ratios:[],
        points:[],
        candidates:candidates.length,
        available:!!(record&&lightMass!==null&&heavyMass!==null)
    }
    if(!mask.available||!(theoretical>0)) return mask

    const adjacentMass=heavyMass-lightMass
    mask.adjacentMass=adjacentMass
    const proposed=findProposedPermutations(candidates,{symbol,lightA,heavyA})

    const pushRatio=(pair)=>{
        const {light,heavy}=pair
        if(!(light.intensity>0)||!(heavy.intensity>0)) return
        const atoms=totalOf(light.atoms,symbol)
        const measured=isotopeRatio({
            lightIntensity:light.intensity,
            heavyIntensity:heavy.intensity,
            atoms,
            theoretical
        })
        if(!measured) return
        /* L'ERREUR DE MASSE PORTÉE PAR CHAQUE PIC, en valeur absolue et en ppm.
           On la déduit de `errorPpm` quand le crible la fournit; sinon de la
           masse mesurée et de la masse théorique. La somme des deux est
           l'erreur cumulée des pics qui entrent RÉELLEMENT dans le rapport:
           sans elle, un ratio peut sembler cohérent alors que ses deux masses
           ont dérivé du même côté. Leur DIFFÉRENCE, elle, annule un décalage de
           calibration commun: elle ne garde que ce qui est propre à la paire. */
        const signedPpmOf=item=>{
            if(Number.isFinite(item?.errorPpm)) return item.errorPpm
            const target=Number(item?.mz)
            const measuredMz=Number(item?.measuredMz)
            if(Number.isFinite(target)&&Number.isFinite(measuredMz)&&target!==0)
                return (measuredMz-target)/target*1e6
            return null
        }
        const lightSignedPpm=signedPpmOf(light)
        const heavySignedPpm=signedPpmOf(heavy)
        const known=lightSignedPpm!==null&&heavySignedPpm!==null
        const lightErrorPpm=known?Math.abs(lightSignedPpm):null
        const heavyErrorPpm=known?Math.abs(heavySignedPpm):null
        const massErrorPpm=known?lightErrorPpm+heavyErrorPpm:null
        const massErrorDiffPpm=known?heavySignedPpm-lightSignedPpm:null
        const massErrorDa=known
            ?(lightErrorPpm*light.measuredMz
                +heavyErrorPpm*heavy.measuredMz)*1e-6
            :null
        mask.ratios.push({
            symbol,
            lightA,heavyA,
            lightPoint:light.point,
            lightKey:light.key,
            lightMz:light.measuredMz,
            lightIntensity:light.intensity,
            heavyPoint:heavy.point,
            heavyKey:heavy.key,
            heavyMz:heavy.measuredMz,
            heavyIntensity:heavy.intensity,
            simulated:!!pair.simulated,
            atoms,
            theoretical,
            ratio:measured.ratio,
            delta:measured.delta,
            lightErrorPpm,
            heavyErrorPpm,
            massErrorPpm,
            massErrorDiffPpm,
            massErrorDa,
            totalIntensity:light.intensity+heavy.intensity
        })
    }
    for(const pair of proposed) pushRatio(pair)
    /* Une base n'est « déjà appariée » que si la paire a réellement produit un
       rapport : un frère proposé à intensité nulle ne dispense pas d'aller
       chercher le satellite par la masse. */
    const matchedLight=new Set(
        mask.ratios.filter(ratio=>!ratio.simulated)
            .map(ratio=>candidateId(ratio.lightPoint,ratio.lightKey)))

    /* LA SIMULATION, POUR LES BASES SANS FRÈRE PROPOSÉ.
       La prédiction part du pic MESURÉ de la base, pas de sa masse théorique :
       l'erreur de calibration est déjà dans la mesure, et l'ignorer décalerait
       le satellite simulé d'autant. `heavyMass-lightMass` est divisé par la
       charge, un satellite se lisant en m/z. */
    if(peakList&&typeof peakList.nearest==="function"){
        for(const light of candidates){
            if(countOf(light.atoms,symbol,heavyA)!==0) continue
            if(countOf(light.atoms,symbol,lightA)<1) continue
            if(matchedLight.has(candidateId(light.point,light.key))) continue
            if(!(light.intensity>0)) continue
            const z=Math.max(1,Math.abs(light.charge||1))
            const predicted=light.measuredMz+adjacentMass/z
            const hit=peakList.nearest(predicted)
            if(!hit) continue
            if(hit.index===light.point) continue
            if(!Number.isFinite(hit.errorPpm)||Math.abs(hit.errorPpm)>mask.ppm) continue
            if(!(hit.intensity>0)) continue
            pushRatio({
                light,
                heavy:{
                    point:hit.index,
                    key:null,
                    measuredMz:hit.mz??predicted,
                    mz:predicted,
                    errorPpm:Number.isFinite(hit.errorPpm)?hit.errorPpm:null,
                    intensity:hit.intensity
                },
                simulated:true
            })
        }
    }

    /* PAR PIC, LES DELTAS DE CHAQUE PROPOSITION.

       Le delta d'une base est connu des deux côtés : la base elle-même, et son
       frère lourd quand celui-ci est une VRAIE proposition (une simulation n'a
       pas de clé à opposer). On en déduit, pour chaque pic, la proposition la
       plus cohérente isotopiquement — celle que le mariage temporaire aurait
       dû choisir. */
    const deltasByPoint=new Map()
    const note=(point,key,ratio)=>{
        if(typeof key!=="string"||!Number.isFinite(ratio?.delta)) return
        let byKey=deltasByPoint.get(point)
        if(!byKey){ byKey=new Map(); deltasByPoint.set(point,byKey) }
        const existing=byKey.get(key)
        if(!existing||Math.abs(ratio.delta)<Math.abs(existing.delta))
            /* ON GARDE LE CONTEXTE DE LA PAIRE, pas seulement son écart: la
               lecture en abscisse peut se faire sur le signal, sur la masse
               moyenne des deux pics ou sur le nombre d'atomes de l'élément
               étudié. Ces trois grandeurs sont donc portées par chaque delta,
               pour que le rendu n'ait pas à retourner chercher le ratio. */
            byKey.set(key,{
                delta:ratio.delta,
                ratio:ratio.ratio,
                totalIntensity:ratio.totalIntensity,
                lightMz:ratio.lightMz,
                heavyMz:ratio.heavyMz,
                lightIntensity:ratio.lightIntensity,
                heavyIntensity:ratio.heavyIntensity,
                lightErrorPpm:ratio.lightErrorPpm,
                heavyErrorPpm:ratio.heavyErrorPpm,
                massErrorPpm:ratio.massErrorPpm,
                massErrorDiffPpm:ratio.massErrorDiffPpm,
                massErrorDa:ratio.massErrorDa,
                atoms:ratio.atoms,
                /* LE DRAPEAU DIT D'OÙ VIENT LE DELTA. Un delta issu d'une
                   simulation ne doit pas se présenter comme une paire proposée:
                   c'est ce qui sépare les swaps « déjà dans le crible » des
                   remplacements que seule la lecture isotopique justifie. */
                simulated:!!ratio.simulated
            })
    }
    for(const ratio of mask.ratios){
        note(ratio.lightPoint,ratio.lightKey,ratio)
        note(ratio.heavyPoint,ratio.heavyKey,ratio)
    }

    const defaultMarriage=new Map()
    for(const candidate of candidates){
        const previous=defaultMarriage.get(candidate.point)
        const better=previous===undefined
            ||Math.abs(candidate.errorPpm??Infinity)<Math.abs(previous.errorPpm??Infinity)
        if(better) defaultMarriage.set(candidate.point,candidate)
    }

    for(const [point,byKey] of deltasByPoint){
        let bestKey=null
        let best=null
        for(const [key,value] of byKey){
            if(!best||Math.abs(value.delta)<Math.abs(best.delta)){ best=value; bestKey=key }
        }
        const married=marriageByPoint?.get?.(point)??defaultMarriage.get(point)?.key??null
        mask.points.push({
            index:point,
            married,
            bestKey,
            bestDelta:best?.delta??null,
            mismatch:typeof married==="string"&&typeof bestKey==="string"&&married!==bestKey,
            deltas:[...byKey.entries()].map(([key,value])=>({key,...value}))
                .sort((a,b)=>Math.abs(a.delta)-Math.abs(b.delta))
        })
    }
    mask.points.sort((a,b)=>a.index-b.index)

    const candidateByPointKey=new Map()
    for(const candidate of candidates)
        candidateByPointKey.set(candidateId(candidate.point,candidate.key),candidate)

    /* DEUX FAMILLES DE SWAPS, ET ELLES NE SE MÉLANGENT PLUS.

       Un swap né d'une paire PROPOSÉE ne fait que déplacer un mariage entre deux
       formules que le crible connaît déjà. Un swap né d'une SIMULATION remplace
       une attribution qui gagnait en masse mais n'expliquait aucun rapport
       isotopique. Ce sont deux gestes de nature différente, et les compter
       ensemble laisserait croire que le crible avait déjà tout proposé. */
    const swaps=[]
    const simulatedReplacements=[]
    for(const point of mask.points){
        if(!point.mismatch) continue
        if(typeof point.bestKey!=="string") continue
        const deltaByKey=new Map((point.deltas??[]).map(delta=>[delta.key,delta]))
        const toDelta=deltaByKey.get(point.bestKey)
        if(!toDelta) continue
        const fromDelta=deltaByKey.get(point.married)??null
        const from=candidateByPointKey.get(candidateId(point.index,point.married))
        const to=candidateByPointKey.get(candidateId(point.index,point.bestKey))
        const diff=from&&to?compositionDiff(from.atoms,to.atoms):null
        const swap={
            index:point.index,
            fromKey:point.married,
            toKey:point.bestKey,
            fromDelta:fromDelta?fromDelta.delta:null,
            toDelta:toDelta.delta,
            gain:fromDelta?Math.abs(fromDelta.delta)-Math.abs(toDelta.delta):null,
            signature:diff?diff.signed:null,
            groupKey:diff?diff.key:null,
            simulated:!!toDelta.simulated
        }
        if(swap.simulated) simulatedReplacements.push(swap)
        else swaps.push(swap)
    }
    mask.swaps=swaps

    const groupOf=(list,field)=>list.reduce((groups,item)=>{
        if(!item.groupKey) return groups
        let group=groups.get(item.groupKey)
        if(!group){
            /* La CLÉ groupe (forme canonique), la SIGNATURE affiche le sens:
               « C12:-1,C13:+1 » dit ce qui est réellement converti. */
            group={key:item.groupKey,signature:item.signature??item.groupKey,
                count:0,[field]:[]}
            groups.set(item.groupKey,group)
        }
        group.count++
        group[field].push(item)
        return groups
    },new Map())

    mask.swapGroups=[...groupOf(swaps,"swaps").values()]
        .sort((a,b)=>b.count-a.count||(a.key<b.key?-1:1))

    /* LES SATELLITES QUE LE CRIBLE N'A PAS PROPOSÉS — la seconde famille.

       Une simulation lit un pic par sa MASSE, pas par une formule du crible:
       elle crée donc une lecture qui n'existait pas. Ce qui se crée, c'est la
       permutation (l'isotopologue de la base), et on le mesure en cherchant si
       la signature du satellite figure déjà parmi les candidats de ce pic.

       `create` et `replace` sont DEUX FAITS INDÉPENDANTS et peuvent coexister:
       on peut à la fois ajouter le satellite manquant et remplacer la base mal
       mariée. Les grouper par permutation met côte à côte tous les pics que le
       même échange d'atome explique. */
    const signaturesByPoint=new Map()
    for(const candidate of candidates){
        let set=signaturesByPoint.get(candidate.point)
        if(!set){ set=new Set(); signaturesByPoint.set(candidate.point,set) }
        set.add(candidate.signature)
    }
    const simulatedCreations=[]
    for(const ratio of mask.ratios){
        if(!ratio.simulated) continue
        const light=candidateByPointKey.get(candidateId(ratio.lightPoint,ratio.lightKey))
        if(!light) continue
        const satellite=convertOne(light.atoms,symbol,lightA,heavyA)
        if(!satellite) continue
        const satelliteSignature=atomsSignature(satellite)
        const diff=compositionDiff(light.atoms,satellite)
        if(!diff.key) continue
        const existing=signaturesByPoint.get(ratio.heavyPoint)
        const replacement=simulatedReplacements.find(item=>
            item.index===ratio.lightPoint&&item.toKey===ratio.lightKey)??null
        simulatedCreations.push({
            index:ratio.heavyPoint,
            lightPoint:ratio.lightPoint,
            lightKey:ratio.lightKey,
            satelliteSignature,
            signature:diff.signed,
            groupKey:diff.key,
            atoms:ratio.atoms,
            lightMz:ratio.lightMz,
            heavyMz:ratio.heavyMz,
            lightIntensity:ratio.lightIntensity,
            heavyIntensity:ratio.heavyIntensity,
            delta:ratio.delta,
            ratio:ratio.ratio,
            massErrorPpm:ratio.massErrorPpm,
            massErrorDiffPpm:ratio.massErrorDiffPpm,
            create:!(existing&&existing.has(satelliteSignature)),
            replace:!!replacement
        })
    }
    /* Un swap de remplacement peut ne pas avoir de création associée, donc on
       regroupe aussi les remplacements: c'est la permutation de base, celle que
       la simulation vient corriger. */
    const replacementGroups=[...groupOf(simulatedReplacements,"swaps").values()]
        .sort((a,b)=>b.count-a.count||(a.key<b.key?-1:1))
    /* Les créations se groupent par la permutation ISOTOPIQUE (base -> satellite),
       pas par le changement de base: c'est elle qui décrit « le même M+1 ». */
    const creationGroups=simulatedCreations.reduce((groups,creation)=>{
        if(!creation.groupKey) return groups
        let group=groups.get(creation.groupKey)
        if(!group){
            group={key:creation.groupKey,signature:creation.signature,
                count:0,created:0,entries:[]}
            groups.set(creation.groupKey,group)
        }
        group.count++
        if(creation.create) group.created++
        group.entries.push(creation)
        return groups
    },new Map())

    mask.simulatedReplacements=simulatedReplacements
    mask.simulatedReplacementGroups=replacementGroups
    mask.simulatedCreations=simulatedCreations
    mask.simulatedCreationGroups=[...creationGroups.values()]
        .sort((a,b)=>b.count-a.count||(a.key<b.key?-1:1))
    return mask
}
