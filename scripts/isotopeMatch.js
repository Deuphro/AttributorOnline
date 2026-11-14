/* =========================================================================
   LE VÉRIFICATEUR D'ISOTOPOLOGUES.

   Le crible propose plusieurs formules pour un même pic, classées par écart en
   ppm. Deux compositions peuvent tomber à quelques dixièmes de ppm l'une de
   l'autre et rester indistinguables sur la seule masse exacte. Ce qu'elles ne
   partagent pas, c'est leur ENVELOPPE ISOTOPIQUE: le nombre de carbones, la
   présence d'azote ou de soufre se lisent dans les satellites M+1, M+2... et
   dans leurs intensités relatives.

   Ce module ne décide pas. Il CALCULE, pour une formule et un spectre, ce que
   l'enveloppe prédite dit des pics voisins réellement mesurés, et rend un
   score transparent. Le choix reste celui de l'utilisateur, dans l'écran de
   réinspection.

   Tout est pur ici: aucune formule n'est construite, aucun état n'est gardé.
   `isotopologueEnvelope` reçoit un objet qui sait énumérer ses isotopologues
   (`Formula`/`Stoichiometry` le font), et `scoreIsotopePattern` reçoit une
   fonction `nearest(mz)` fournie par l'appelant — le spectre peut être une
   `SortedPoints`, un tableau, ou un double de test.
   ========================================================================= */

const EPSILON=1e-12

/* L'ENVELOPPE PRÉDITE AUTOUR D'UN PIC.

   `isotopologues` rend les états par probabilité DÉCROISSANTE: s'arrêter à
   `limit` garde donc les plus probables, et le filtre de masse ne fait ensuite
   que découper la fenêtre utile. Un `limit` infini serait exact mais coûteux
   sur une grosse molécule; 500 états couvrent très largement M, M+1 et M+2.

   `marginDa` tolère que le pic mesuré soit un peu à gauche du germe calculé:
   l'écart en ppm est déjà une donnée du crible, et rogner l'enveloppe au m/z
   exact perdrait le germe d'une proposition légèrement décalée.

   `probability` est RELATIVE au plus probable de la tranche (le germe vaut 1).
   C'est cette échelle que la comparaison utilise: les intensités mesurées, elles
   aussi, se lisent relativement au pic central. */
export function isotopologueEnvelope(formula,{
    mz=null,spanDa=3,marginDa=0.5,ratio=1e-6,limit=500,mergePpm=10
}={}){
    if(!formula||typeof formula.isotopologues!=="function")
        throw new Error("isotopologueEnvelope needs a formula with isotopologues()")
    const centre=Number.isFinite(mz)?mz:Number(formula.mz)
    if(!Number.isFinite(centre))
        return {centre:null,peaks:[],maxLogProbability:null}
    const low=centre-marginDa
    const high=centre+spanDa
    const kept=[]
    let maxLogProbability=-Infinity
    for(const state of formula.isotopologues({ratio,limit})){
        const mass=Number(state?.mz)
        if(!Number.isFinite(mass)) continue
        if(mass<low||mass>high) continue
        if(state.logProbability>maxLogProbability) maxLogProbability=state.logProbability
        kept.push(state)
    }
    const sorted=kept.map(state=>({
        mz:state.mz,
        key:state.key,
        notation:state.notation,
        logProbability:state.logProbability,
        probability:Math.exp(state.logProbability-maxLogProbability)
    })).sort((a,b)=>a.mz-b.mz)
    /* LES ÉTATS DÉGÉNÉRÉS SONT UN SEUL PIC POUR LE SPECTROMÈTRE.
       13C et 17O tombent à quelques ppm l'un de l'autre: un seul pic mesuré les
       porte, et son intensité est leur SOMME. Les garder séparés ferait comparer
       deux fois la même intensité à deux abondances, donc gonfler la couverture
       d'une formule simplement parce qu'elle a des satellites qui se recouvrent.
       On fusionne donc les états dont les m/z sont dans la fenêtre de lecture, et
       la notation retenue est celle de l'état dominant. */
    const peaks=[]
    for(const peak of sorted){
        const last=peaks[peaks.length-1]
        if(last&&Math.abs(peak.mz-last.mz)<=peak.mz*mergePpm*1e-6){
            const total=last.probability+peak.probability
            last.mz=(last.mz*last.probability+peak.mz*peak.probability)/total
            last.probability=total
            if(peak.probability>last.dominantProbability){
                last.dominantProbability=peak.probability
                last.key=peak.key
                last.notation=peak.notation
            }
            continue
        }
        peaks.push({
            mz:peak.mz,
            key:peak.key,
            notation:peak.notation,
            logProbability:peak.logProbability,
            probability:peak.probability,
            dominantProbability:peak.probability
        })
    }
    for(const peak of peaks) delete peak.dominantProbability
    return {
        centre,
        peaks,
        maxLogProbability:Number.isFinite(maxLogProbability)?maxLogProbability:null
    }
}

/* LA COMPARAISON, ET CE QU'ELLE DIT.

   `nearest(mz)` doit rendre `{mz,intensity,errorPpm}` ou null. Quand il porte
   un `errorPpm`, le seuil `ppm` est appliqué ICI: un satellite prédit ne peut
   pas être « expliqué » par un pic à 4 000 ppm.

   LE SCORE EST UN PRODUIT DE DEUX CHOSES, et c'est volontaire:

     - `cosine` mesure la FORME: les abondances relatives prédites vont-elles
       dans le même sens que les intensités mesurées? Il est insensible à
       l'échelle, donc il ne dépend pas du réglage de gain du spectromètre.
     - `coverage` mesure la PRÉSENCE: quelle part de l'abondance prédite a
       réellement un pic mesuré? Une enveloppe qui prédit un M+2 fort et dont le
       spectre n'a rien à cet endroit doit perdre, même si les deux pics
       présents sont bien proportionnés.

   `score = cosine * coverage` reste donc dans [0,1]: 1 veut dire « tous les
   satellites attendus sont là, dans les bonnes proportions ». `residual` est
   l'écart moyen de log-intensité sur les seuls satellites appariés; il sert à
   lire POURQUOI un score est bas, pas à classer.

   Les pics mesurés qui n'ont pas de satellite prédit ne sont pas pénalisés:
   ils peuvent appartenir à une autre molécule, et l'enveloppe d'un ion n'a pas
   à expliquer tout le spectre. */
export function scoreIsotopePattern(envelope,nearest,{
    ppm=10,minRel=0.01
}={}){
    const peaks=(envelope?.peaks??[]).filter(peak=>
        Number.isFinite(peak.mz)
        &&Number.isFinite(peak.probability)
        &&peak.probability>=minRel)
    const empty={
        score:0,cosine:0,coverage:0,residual:null,
        bins:[],usable:0,matched:0,centre:envelope?.centre??null
    }
    if(!peaks.length||typeof nearest!=="function") return empty

    const hits=peaks.map(peak=>{
        const hit=nearest(peak.mz)
        if(!hit) return null
        if(Number.isFinite(hit.errorPpm)&&Math.abs(hit.errorPpm)>ppm) return null
        if(!Number.isFinite(hit.intensity)) return null
        return hit
    })

    /* LA RÉFÉRENCE D'INTENSITÉ EST LE PIC CENTRAL, pas le satellite le plus
       fort: c'est lui que le crible a apparié à la formule, et c'est donc à lui
       que les abondances prédites se rapportent. Si son intensité est nulle ou
       absente, on retombe sur le plus fort satellite mesuré, puis sur 1 — un
       spectre sans intensité ne doit pas produire un NaN silencieux. */
    const centreHit=Number.isFinite(envelope?.centre)?nearest(envelope.centre):null
    const centreUsable=centreHit
        &&(!Number.isFinite(centreHit.errorPpm)||Math.abs(centreHit.errorPpm)<=ppm)
    let reference=centreUsable&&Number.isFinite(centreHit.intensity)&&centreHit.intensity>0
        ?centreHit.intensity
        :0
    if(!(reference>0)){
        for(const hit of hits) if(hit&&hit.intensity>reference) reference=hit.intensity
    }
    if(!(reference>0)) reference=1

    let dot=0
    let predictedSquared=0
    let observedSquared=0
    let matchedAbundance=0
    let predictedAbundance=0
    let residualSum=0
    let residualWeight=0
    let matched=0
    const bins=[]
    for(let index=0;index<peaks.length;index++){
        const peak=peaks[index]
        const hit=hits[index]
        const predicted=peak.probability
        const observed=hit?hit.intensity/reference:0
        predictedAbundance+=predicted
        if(hit){
            matched++
            matchedAbundance+=predicted
            dot+=predicted*observed
            predictedSquared+=predicted*predicted
            observedSquared+=observed*observed
            residualSum+=predicted*Math.abs(
                Math.log((observed+EPSILON)/(predicted+EPSILON)))
            residualWeight+=predicted
        }else{
            predictedSquared+=predicted*predicted
        }
        bins.push({
            mz:peak.mz,
            notation:peak.notation,
            predicted,
            matched:!!hit,
            measuredMz:hit?.mz??null,
            measuredIntensity:hit?.intensity??null,
            observed,
            errorPpm:hit?.errorPpm??null
        })
    }
    const denominator=Math.sqrt(predictedSquared*observedSquared)
    const cosine=denominator>0?dot/denominator:0
    const coverage=predictedAbundance>0?matchedAbundance/predictedAbundance:0
    return {
        score:cosine*coverage,
        cosine,
        coverage,
        residual:residualWeight>0?residualSum/residualWeight:null,
        bins,
        usable:peaks.length,
        matched,
        centre:envelope?.centre??null
    }
}
