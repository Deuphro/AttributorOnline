import {NodeWithAccordion} from "../core/index.js"
import {Accordion} from "../ui/Accordion.js"
import {Dialog} from "../ui/Dialog.js"
import {Plot2DWebGL} from "../ui/Plot2DWebGL.js"
import {Wave,XYTrace} from "../formats.js"
import {Formula,Stoichiometry,FormulaCollection} from "../chemistry.js"
import {computePool} from "../workerPool.js"
import {CE,stylize} from "../util.js"
import {buildPlan,attributeSpectrum,SortedPoints,saneBound,saneRatio,planForKernel,stateToFormula,propagateForest} from "../attribution.js"
import {forestStandards,forestComponents,componentLine,growForest,suggestWeightCut,forestGraph,forestRoot,layoutForests,DEFAULT_LINK_TOLERANCE} from "../forest.js"
import {windowFor,wavesFromInput} from "../utils/index.js"
import {prettyNotation} from "./formulaCollectionHelpers.js"
import {AttributionForestMethods} from "./AttributionForestMethods.js"

export class AttributionNode extends NodeWithAccordion{
    constructor(title,origin,destinationFlow,position={x:180,y:10}){
        //one multiplexed input (XY waves), two outputs: attributions + forest FormulaCollections
        super(title,[[]],[[],[]],origin,destinationFlow,position)
        this.status="floating"
        /* THE TWO LISTS, as text. Text rather than formulas, for the same
           reason the reader does it: a session must not carry the periodic table
           along with it. */
        /* LES GROUPES PAR DÉFAUT, et ils viennent d'une MESURE, pas d'une
           intuition.

           Une peak list réelle de 95 ions entre 175 et 389, ionisation [H+] :

             CH2, O seulement  →  2 masses combinables, 0 correspondance à 10 ppm
             CH2, NH, O, C     →  4 masses combinables, 344 correspondances,
                                les 95 points couverts, médiane 4 par point

           La différence n'est pas un réglage de précision: `ratio` à 0.1 écarte
           les isotopologues de CH₂, et il ne reste que la masse la plus
           abondante de chaque groupe. Deux briques font une grille grossière —
           les écarts entre deux combinaisons sont de l'ordre du Dalton — donc
           la plus proche formule possible reste à 10 ppm du pic, et une fenêtre
           à 10 ppm ne peut rien accrocher. C'est le minimum géométrique, pas un
           mauvais dosage.

           NH et C densifient la grille. On ne le déduit pas: c'est le plan qui,
           sur ce spectre, couvre les 95 points. */
        /* THE GROUPS, and each one is a ROW with its own bounds.

           They used to be two text areas, one group per line, and that shape could
           not carry what a group needs: how many of it, and which isotopes. One
           global `ratio` had to cover every group at once, so opening the ¹³C
           opened the ¹⁷O with it — rare isotopes multiply bricks without ever
           being used, and the enumeration grew by three for nothing.

           So a group is `{group, min, max, ratio}` and each row owns its four.
           `ratio:1` is the default, which means "the most probable isotope only":
           an untouched list is a SHORT list. Opening ¹³C is then a per-row
           decision, which is what it always should have been. */
        this.parameters.combining=[
            {group:"CH2",min:0,max:Infinity,ratio:1},
            {group:"NH",min:0,max:Infinity,ratio:1},
            {group:"O",min:0,max:Infinity,ratio:1},
            {group:"C",min:0,max:Infinity,ratio:1}
        ]
        this.parameters.ionising=[
            /* Un adduit est OBLIGATOIRE par défaut: une attribution sans charge
               n'a pas de m/z, donc un adduct facultatif à 0..1 produirait des
               neutres que rien ne peut rattacher à un pic. 1..1 est donc la seule
               initialisation qui ait un sens ici. */
            {group:"[H+]",min:1,max:1,ratio:1}
        ]
        /* `ratio` reste en paramètre parce que des sessions enregistrées le
           portent, et parce qu'il sert de REPLI quand une ligne ne dit rien. Un
           écran qui le montre encore serait double emploi; il est donc lu, pas
           présenté. */
        this.parameters.ratio=0.1
        /* THE IONISATION WINDOW — bounds on |charge|, in absolute value: a 2+
           and a 2- are the same thing to measure. */
        this.parameters.chargeMin=1
        this.parameters.chargeMax=1
        /* HOW MANY READINGS TO KEEP, PER PEAK. This replaces the old `limit`.

           `limit` capped the sieve's OUTPUT — the enumeration, ordered by rising
           mass — so it kept the lightest combinations and cut the rest. On the
           95-peak list, `limit=2000` published the 2 000 lightest states and
           discarded 27 381, including the only candidates for the high-mass
           peaks. It read like "show me 2 000 results" and behaved like "show me
           the bottom of the pile", which are opposite things.

           This counts per PEAK, so no peak can be starved by a richer neighbour,
           and the walk is exhaustive: nothing is dropped for arriving late in the
           enumeration.

           3, and not 1: an exact-mass match inside 10 ppm is genuinely ambiguous
           at the CH₂/NH/O/C level — several compositions routinely land within a
           fraction of a ppm of each other. One reading per peak publishes a
           confident answer the data does not support; three shows the ambiguity
           without burying the reader. The window in ppm still decides WHO is a
           candidate, and this decides how many of them are shown. */
        this.parameters.bestMatches=3
        /* The match window, in ppm. It is BOTH an admissibility filter and a
           displayed measurement: a formula further off than this is not
           proposed at all, because a reader cannot act on a 4 000 ppm error, and
           keeping it would fill the ranking with values that are plainly wrong.
           Inside the window the raw offset is still reported, so the number the
           user reads is the real one and not merely a pass/fail. */
        this.parameters.ppm=10
        /* LE RÉSEAU DE MESURES — les trois réglages de `GRAPHTTRIBUTOR`.

           Ils vivent dans CE nœud et pas dans un nœud séparé, parce qu'ils
           répondent à la même question que le reste: « quelles masses cette
           liste de groupes peut-elle expliquer? ». Un nœud séparé imposerait
           de dupliquer les listes, et deux listes qui divergent donneraient
           un réseau calculé sur autre chose que ce qui est écrit à l'écran.

           LA FENÊTRE DE LIEN est le 0.5 qu'Igor avait écrit en dur, devenu un
           réglage : 0.5 Da sur un lien est une GÉOMÉTRIE (« près »), pas une
           physique, et une constante cachée dans une comparaison ne se règle
           pas. Au-delà, deux pics ne sont plus « voisins ».

           LE PLAFOND DE DEGRÉ est le `degmax` du même Igor: 0 = aucun
           plafond, ce qui est le mode `GrowForest`; 2 donne les « réticules »,
           où chaque pic n'accroche que deux voisins. C'est le SEUL réglage qui
           change la NATURE du réseau et pas sa taille — un graphe en chaîne
           et un graphe en étoile ne s'expliquent pas de la même façon, et on
           ne peut pas passer de l'un à l'autre sans y toucher.

           LA CHARGE des ions, parce qu'Igor comparait des masses à des écarts
           de m/z, ce qui n'est juste que pour des ions 1+. 0 = « la charge du
           plan », donc unplan à 1+ se comporte comme l'oracle. */
        this.parameters.forestTolerance=DEFAULT_LINK_TOLERANCE
        this.parameters.forestDegreeMax=0
        this.parameters.forestCharge=0
        /* LA LISTE DE LIAISON, ET ELLE EST AUTONOME.

           C'est l'équivalent du `Stds_Obs` d'Igor: la liste des masses qui
           servent à RELIER les pics, et elle ne dépend en rien de la liste des
           groupes à combiner. Les deux questions sont différentes, et les
           confondre oblige à choisir entre deux usages légitimes:

             — relier seulement les familles CH2, mais attribuer la formule de
               départ avec tout le jeu CH2/NH/O/C;
             — relier avec tout le jeu, et n'attribuer qu'avec CH2.

           Avec une liste partagée, une seule des deux est possible. Donc deux
           listes, deux panneaux, et AUCUN lien entre elles: changer la liste de
           gauche ne touche pas le réseau, et changer celle de droite ne touche
           ni le crible ni ses sorties.

           LE DÉFAUT EST CH2 SEUL, et c'est un choix de lecture: c'est le cas
           dont la lecture est la plus nette — des pics séparés d'une masse de
           CH2 forment une chaîne qu'on peut suivre à l'œil — et une liste
           courte rend les liens de la ligne de groupe lisibles. On l'ajoute
           depuis le champ, au-dessus des bornes. */
        this.parameters.forestGroups=[{group:"CH2"}]
        /* la liste de références du dernier calcul, et les arbres par entrée */
        this.forestPlan=null
        this.forestGraphsOf=null
        this.forestLayoutOf=null
        this.forestAnimationFrame=null
        this.forestPlotLeft=0.10
        this.forestPlotRight=0.01
        this.forestColors={
            curve:"#aef22e",
            suggestion:"#dfe6ee",
            cut:"#78b4ff",
            discarded:"#d9534f",
            wash:"rgba(217,83,79,0.10)"
        }
        this.forests=[]
        this.forestComponents=[]
        this.forestErrors=[]
        /* SELECTION ET FILTRE DU RÉSEAU.
        
           forestSelected: Set de rangs (component.rank) des arbres sélectionnés.
           forestMinSize: taille minimale pour afficher un arbre dans la liste.
           Les deux sont persistés dans serializeState/restoreState. */
        this.forestSelected=new Set()
        this.forestMinSize=1
        /* LE MONO TONIQUE DU RÉSEAU, comme celui du resolve.

           Un réseau lancé à la main sur trois spectres peut se croiser avec un
           autre: sans jeton, le résultat le plus ancien publierait par-dessus
           le plus récent, et l'écran montrerait un arbre calculé sur des
           réglages qui ne sont plus ceux affichés. */
        this.forestRun=0
        /* la liste des pics du dernier calcul, par entrée: le panneau affiche
           des m/z, et le noyau ne connaît que des indices */
        this.forestPoints=[]
        /* the plan, the table, and the diagnostics of the last resolve */
        this.plan=null
        this.loadedTable=null
        this.diagnostics=[]
        /* one attribution list per input wave, in input order — therefore in
           flow order, stable from one resolve to the next */
        this.attributions=[]
        /* LE DRAPEAU DU CALCUL, et il est le SEUL qui dise si les résultats
           correspondent aux réglages.

           Un changement de réglage ne relance rien: il met ce drapeau, et le
           bouton Resolve le remet à zéro en calculant. C'est ce qui permet de
           régler une liste de dix groupes sans payer dix cribles — et le nœud ne
           ment jamais, il AFFICHE qu'il est en retard. */
        this.needsResolve=false
        this.staleReason=null
        /* the kernel's complaints, per input. A kernel that fails on one
           spectrum must not stop the others. */
        this.kernelErrors=[]
        /* monotonic ticket: a newer resolve forbids an older one to publish,
           otherwise two spectra launched by hand would tread on each other */
        this.run=0
        const inputAnchors=this.DOMelt.querySelectorAll('.input.anchor')
        if(inputAnchors[0]){
            inputAnchors[0].innerHTML='<title>Input: one or more XY waves (X=mass, Y=intensity). Each is attributed separately.</title>'
        }
        const outputAnchors=this.DOMelt.querySelectorAll('.output.anchor')
        if(outputAnchors[0]){
            outputAnchors[0].innerHTML='<title>Output 0: one attribution list per input wave</title>'
        }
        if(outputAnchors[1]){
            outputAnchors[1].innerHTML='<title>Output 1: one FormulaCollection per selected forest tree</title>'
        }
    }

    /* The periodic table, ONCE and on demand.

       It belongs to the ORIGIN and is AWAITED, never read live: the App loads it
       in the background, so a node reading `origin.table` on waking would say
       "no table" about a table still in flight. The same shape as FKMDNode and
       the collection reader, on purpose.

       The cache is called `loadedTable`, and that is not a matter of taste: a
       node with a `table()` method cannot have a `table` field. The assignment
       in the constructor puts an OWN property on the instance which masks the
       method, and the next `this.table()` throws "this.table is not a
       function" — which is exactly what happened, and it took the node down at
       creation. The two names therefore have to differ, and the reason is worth
       more than the name. */
    async table(){
        if(this.origin.table){
            this.loadedTable=this.origin.table
            return this.loadedTable
        }
        const loaded=await this.origin.tableReady
        this.loadedTable=loaded??null
        return this.loadedTable
    }

    /* The lists, READ OVER SEVERAL LINES.

       A list of groups IS a list: the reader types one formula per line. It is
       the only reading that makes these two lists usable whatever their size —
       a single field can hold one group and nothing else.

       The EMPTY line does not show up in a final newline, hence the filter: a
       trailing newline is what an editor adds by itself, and it must not become
       an empty group — which would be a diagnostic per line. */
    readList(text){
        return String(text??"")
            .split(/[\n;]/)
            .map(line=>line.trim())
            .filter(line=>line.length>0)
    }

    /* UNE LISTE DE GROUPES, QUELLE QUE SOIT SON ÂGE.

       Trois écritures existent dans le monde, et les trois doivent marcher:

         "CH2\nNH"                    une chaîne, une ligne par groupe — les
                                      sessions enregistrées avant les bornes
         "CH2\nNH"                    passé par `readList`, donc un tableau
         {group:"CH2",min:0,max:∞}    une entrée, et c'est la forme courante

       La migration vit ICI, et pas dans le moteur, parce que c'est une question
       de FORMAT DE SESSION, pas de chimie: le moteur accepte déjà les deux
       écritures. Ce qui décide ici, c'est le DÉFAUT appliqué à une ligne qui ne
       dit rien — et il dépend de la liste: un groupe de masse à 0..∞, un adduit
       à 1..1, parce qu'une attribution sans adduit n'a pas de m/z. */
    readGroups(value,kind){
        const adducts=kind==="ionising"
        const fallback={
            min:adducts?1:0,
            max:adducts?1:Infinity,
            /* `ratio:1` — l'isotope le plus probable seulement. C'est le défaut
               qui rend une liste NEUVE petite; ouvrir l'isotopie devient un
               geste par ligne, et non une bascule globale. */
            ratio:1
        }
        const source=Array.isArray(value)
            ?value
            :this.readList(value).map(line=>({group:line}))
        /* LES BORNES SONT LUES ICI, et pas seulement relues.

           `saneBound` et `saneRatio` viennent du moteur, volontairement: ce qui
           décide du sens de « ∞ » doit être décidé UNE fois. Si le tableau
           affichait « ∞ » et que le moteur lise autre chose, la case mentirait
           — et elle mentirait seulement à l'écran, ce qui est le pire endroit.

           Donc `groupList` rend toujours des nombres ou `Infinity`, jamais la
           chaîne tapée. Le tableau, la session et le plan voient la même chose. */
        return source.map(entry=>{
            if(typeof entry==="string") return {group:entry,...fallback}
            if(entry&&typeof entry==="object"&&!(entry instanceof Formula)
                &&!(entry instanceof Stoichiometry)){
                const group=entry.group??entry.key
                if(group===undefined||group===null) return null
                return {
                    group,
                    min:saneBound(entry.min,fallback.min),
                    max:saneBound(entry.max,fallback.max),
                    ratio:saneRatio(entry.ratio,fallback.ratio)
                }
            }
            return {group:entry,...fallback}
        }).filter(Boolean)
    }

    /* La liste du nœud, normalisée, et c'est la SEULE source de vérité que
       `buildPlan` et le tableau voient. */
    groupList(kind){
        return this.readGroups(this.parameters[kind],kind)
    }
    /* The plan, rebuilt on every resolve.

       Rebuilt rather than kept incremental, on purpose: a list of groups is
       small, reading it costs a fraction of a millisecond, and an incremental
       plan would be one more state to maintain — to save less than maintaining
       it costs. A stale plan would yield masses that no longer match what is
       written on screen, which is the worst kind of bug: plausible, and wrong. */
    buildPlan(){
        this.plan=buildPlan({
            combining:this.groupList("combining"),
            ionising:this.groupList("ionising"),
            ratio:Number(this.parameters.ratio),
            chargeMin:Math.abs(Math.trunc(Number(this.parameters.chargeMin)||0)),
            chargeMax:Math.abs(Math.trunc(Number(this.parameters.chargeMax)||0)),
            /* `chargeAuto` demande au plan de CALCULER la fenêtre de charge à
               partir des min/max par adduit. La valeur obtenue est recopiée dans
               les paramètres juste après, donc elle reste modifiable à l'écran:
               c'est une valeur proposée, pas une valeur imposée. */
            chargeAuto:true,
            table:this.loadedTable
        })
        /* Les bornes par adduct SE DÉDUISENT d'elles-mêmes, et la fenêtre de
           charge s'affiche ensuite — déduite, puis modifiable.

           On ne SUPPRIME PAS le champ, parce qu'une borne automatique ne sait
           rien faire d'une liste d'adduits de signes OPPOSÉS: leurs charges
           s'annulent, et une somme de bornes n'y dit rien. Le champ reste donc;
           il est rempli par le plan, et une retouche manuelle tient jusqu'au
           prochain changement de liste. */
        this.diagnostics=[...this.plan.diagnostics]
        if(this.plan.chargeDerived&&this.chargeAuto!==false){
            this.parameters.chargeMin=this.plan.chargeDerived.min
            this.parameters.chargeMax=this.plan.chargeDerived.max
            this.plan.chargeMin=this.parameters.chargeMin
            this.plan.chargeMax=this.parameters.chargeMax
        }
        /* LA LIGNE DE CHARGE, et elle est une LECTURE du plan. Pas un champ,
           donc rien à saisir et rien à valider: elle ne peut pas diverger des
           réglages qui la produisent, ce qu'un champ finit toujours par faire.

           ELLE MONTRE LE NEUTRE, ET DIT POURQUOI IL NE DONNE PAS DE LECTURE.
           Un adduit en `min:0` autorise l'absence d'adduit, donc une somme de
           charges nulle; la ligne disait pourtant « 1 », ce qui était un
           ensemble plus étroit que les réglages de l'utilisateur. Le 0 est
           donc affiché — et il est impossible de ne pas se demander alors ce
           qu'il produit, alors qu'il ne produit RIEN: le m/z d'un neutre est
           une division par zéro. Le plan le dit dans ses diagnostics, et cette
           ligne le reprend. */
        if(this.chargeLabel){
            const set=this.plan.chargeSet
            this.chargeLabel.textContent=set
                ?`Reachable charge(s): ${set.join(", ")}`
                :"Reachable charge(s): none — the adducts cannot charge anything"
            this.chargeLabel.title=set
                ?`derived from the adducts and their min/max: |z| in {${set.join(", ")}}`
                :"no adduct gives a non-zero charge, so nothing can be attributed"
            /* ET LA DEMI-VÉRITÉ, DITE À CÔTÉ DU CHIFFRE. Un `min:0`
               se lit donc sans avoir à ouvrir quoi que ce soit. */
            if(this.plan.neutralPossible){
                /* LE NEUTRE EST DIT, ET CE N'EST PLUS UNE DEMI-VÉRITÉ.

                   Ce texte disait « un neutre n'a pas de m/z, donc il ne donne
                   aucune lecture ». C'était faux de bout en bout: `Formula.mz`
                   fait `mass/Math.abs(charge||1)`, donc un neutre se lit à sa
                   MASSE, et il donne une lecture comme un autre.

                   La phrase dit maintenant ce qui est vrai et ce qui reste vrai:
                   le 0 est atteignable, et il se lit à la masse. */
                this.chargeLabel.textContent+=
                    "\n0 = neutral: read at its own mass, no adduct needed"
                this.chargeLabel.title+=
                    "\nA neutral is matched on its own mass — no proton is added for you."
                this.chargeLabel.style.opacity="0.9"
            }else{
                this.chargeLabel.style.opacity="1"
            }
        }
        return this.plan
    }
    /* LA LISTE DE RÉFÉRENCES EST REBÂTIE AVEC LE PLAN, et jamais séparément.

       Elle en dérive entièrement — mêmes briques, même charge — donc la
       rebuilding dans le panneau de gauche la laisserait afficher les masses
       d'une liste de groupes qui n'est plus celle affichée. Or le panneau
       gauche se remplit à l'ouverture et après chaque resolve: ce sont deux
       moments où le plan change sans que l'utilisateur ait rien demandé, et
       deux fois où une liste de références périmée serait déjà à l'écran si
       elle vivait de son côté. */
    refreshForestPlan(){
        this.buildForestPlan()
        /* LA LISTE EST REDESSINÉE AVEC LE PLAN, et c'est la seule fois qu'elle
           change sans que l'utilisateur agisse. Sans cette ligne, la table
           attendrait le prochain « Grow network » pour montrer les blocs
           isotopiques d'un groupe ajouté — donc une ligne muette sous un nom
           qu'on vient de taper. */
        this.renderForestGroupTable()
        /* LA LECTURE SEULE, ET PAS LE RÉSEAU. `forestPlan` n'a qu'un lecteur:
           la première ligne de la lecture — le compte des masses de référence.
           Tout le reste de `renderForest` (courbe, liste, graphe, récapitulatif,
           mise en page force) ne le lit pas, et le relancer coûtait 130 ms à
           2,3 s à CHAQUE groupe ajouté, pour repeindre une ligne de texte. */
        this.renderForestReadout()
        return this.forestPlan
    }

    /* Every XY wave landed on the input anchor, in link order.

       The input is what the flow builds: Map<parent, Array<Array<Wave>>>, one
       inner list PER LINK, each holding the waves of that link's output slot.
       Three levels is not a choice, it is the shape the synapse leaves, and
       reading it at the wrong depth yields an output MISSING ONE LEVEL — so
       quietly too short.

       Several cables may land on the SAME anchor; the walk visits each, so each
       brings its waves and, later, its attribution list. A 1D wave is COUNTED
       and not thrown away: a node that silently dropped two spectra out of three
       looks exactly like a node that works. */
    collectInputWaves(){
        //same reader, same XY-only rule as F-KMD's: the sieve has masses to
        //match against, and a 1D wave has none
        const {waves,skipped}=wavesFromInput(this.inputs[0])
        const accepted=[]
        let refused=0
        for(const wave of waves){
            if(wave.degree===2&&wave.dims[1]===2){
                accepted.push(wave)
            }else{
                refused++
            }
        }
        return {waves:accepted,skipped:skipped+refused}
    }

    /* ONE spectrum -> ONE attribution list.

       The steps are the engine's, and their order is not negotiable: the plan
       fixes the windows, the point index is sorted ONCE, the sieve enumerates by
       rising mass, and the matching is O(log n) per candidate.

       The sorted index is built HERE, for this spectrum, and not handed to the
       kernel: sorting points is the job of the side that HOLDS the points, and
       the kernel only does combinatorics. The sort costs O(n log n) once and the
       binary search O(log n) per attribution, so the total stays in
       O(n log n + k log n) — not the O(k·n) a linear scan per candidate would
       give. */
    attributeWave(wave){
        const half=wave.size/2
        const x=new Float64Array(half)
        const y=new Float64Array(half)
        /* A 2D core is laid out [x0..xN, y0..yN] — two contiguous halves, not
           interleaved. That is the shape every kernel produces, so it is what we
           read. Fresh arrays rather than a `subarray` over the core: the core
           belongs to the parent node, and a view would share it, so a write here
           would be visible in the parent's data. */
        if(wave.core.length>=wave.size){
            for(let i=0;i<half;i++) x[i]=wave.core[i]
            for(let i=0;i<half;i++) y[i]=wave.core[i+half]
        }
        const points=new SortedPoints(x,y)
        /* `bestMatches` IS THE RESULT SELECTOR, and it replaced the old `limit`.

           A `limit` counted STATES — the crible's own output — and the crible
           emits them by rising mass, so a limit kept the LIGHTEST combinations
           and dropped the rest. Measured on the 95-point peak list: `limit=2000`
           published the 2 000 lightest and discarded 27 381 states, several of
           which were the only candidates for high-mass peaks. It was not a
           result selector at all — it was an enumeration cut, wearing the name
           of one. The list it produced was a PREFIX, and a prefix of formulas
           ordered by mass says nothing about which formulas explain the peaks.

           `bestMatches` counts PER PEAK instead, so no peak can be starved by a
           richer neighbour. The space is now walked whole; nothing is dropped for
           being late.

           `limit` is still honoured by the engine for callers that want a bound
           on the ENUMERATION (a preview of a huge spectrum), and the node simply
           stops asking for one: `Infinity`, so the walk is exhaustive and the
           truncation flag stays false — which is what makes the list trustworthy
           enough to publish. */
        const result=attributeSpectrum(this.plan,points,{
            limit:Infinity,
            bestMatches:Math.max(1,Math.trunc(Number(this.parameters.bestMatches))||3),
            ppm:Number(this.parameters.ppm)>0?Number(this.parameters.ppm):null
        })
        /* The ORIGINAL peak list rides along. The node has to hand the
           collection the spectrum's own points, not one duplicated point per
           surviving formula: a 95-peak spectrum with `bestMatches=3` would
           otherwise arrive as 240 points, so every peak would appear three times
           and the reader's tables, graphs and counts would all be tripled. The
           attributions are many-to-one BY CONSTRUCTION, and the points are the
           one-to-many side that must not be inflated. */
        result.peakList=points
        return result
    }
    /* LE CRIBLE, PAR LE WORKER — puis le même crible en JS si le worker ne répond pas.

       `attributeWave` appelait `attributeSpectrum` en direct. C'était synchrone, donc
       le thread principal restait occupé pendant tout le parcours: le navigateur ne
       pouvait pas peindre, et le nœud ne pouvait pas afficher qu'il calcule. Le
       kernel Rust fait le même calcul HORS du thread principal.

       LE REPLI EST LE MÊME CRIBLE, pas une approximation. En cas de wasm
       indisponible, de worker en erreur ou de délai dépassé, on repasse par
       `attributeSpectrum` — le chemin d'origine, dont la parité avec le kernel est
       prouvée par `attributionParity.test.mjs`. Un repli « approché » laisserait
       deux physiques dans le programme, et celle qui répondrait serait celle qu'on
       ne testerait pas. */
    async attributeWaveAsync(wave){
        const half=wave.size/2
        const x=new Float64Array(half)
        const y=new Float64Array(half)
        if(wave.core.length>=wave.size){
            for(let i=0;i<half;i++) x[i]=wave.core[i]
            for(let i=0;i<half;i++) y[i]=wave.core[i+half]
        }
        const points=new SortedPoints(x,y)
        const bestMatches=Math.max(1,Math.trunc(Number(this.parameters.bestMatches))||3)
        const ppm=Number(this.parameters.ppm)>0?Number(this.parameters.ppm):null
        const bridge=planForKernel(this.plan)
        const payload={params:{
            plan:{
                itemMasses:bridge.itemMasses,
                itemCharges:bridge.itemCharges,
                logProbs:bridge.logProbs,
                fixed:bridge.fixed,
                /* LA CLÉ EST OMISE SANS DÉPENDANCE: le kernel distingue l'absence
                   d'un `null`, et un plan valide n'en a pas toujours. */
                ...(bridge.dependence?{dependence:bridge.dependence}:{})
            },
            /* LE SPECTRE TRIÉ, et non `x`: la dichotomie du kernel suppose les
               masses CROISSANTES. Passer `x` brut lui donnerait un point voisin
               faux — donc un ppm faux, sans aucun signal d'erreur. */
            masses:Array.from(points.order.map(index=>points.x[index])),
            caps:Array.from(this.plan.capsFor(this.plan.massCeiling(points))),
            maxMass:this.plan.massCeiling(points),
            minMass:this.plan.massFloor(points),
            ppm,
            bestMatches
        }}
        let rows=null
        try{
            const answer=await computePool.run("attributionCriblemixed",payload)
            rows=answer?.rows??null
            if(rows===null) throw new Error(answer?.fallback??"le kernel n'a rien rendu")
        }catch(error){
            /* LE MOTIF EST NOMMÉ, puis on retombe. Un nœud qui perd le kernel en
               silence doit être indiscernable d'un nœud qui n'en a jamais eu — or il
               en a un, et l'utilisateur a le droit de le savoir. */
            console.warn("[attribution] mixed sieve unavailable, JS fallback:",error)
            rows=null
        }
        if(rows===null){
            const result=attributeSpectrum(this.plan,points,{limit:Infinity,bestMatches,ppm})
            result.peakList=points
            result.strategy="mixedRadix/js"
            return result
        }
        return this.publishableRows(rows,points,bestMatches,ppm)
    }
    /* LES LIGNES DU KERNEL, TRANSFORMÉES EN CE QUE LE NŒUD PUBLIE.

       Le kernel rend des MULTIPLICITÉS, et le nœud publie des FORMULES. La
       conversion se fait ici, en JS, par le même `stateToFormula` que le chemin
       synchrone — donc les deux produisent la même forme de résultat, et le panneau
       en aval ne peut pas distinguer les deux origines.

       Le pic est ramené de l'ordre TRIÉ à l'ordre du SPECTRE: le kernel ne voit que
       `masses`, trié, et rend donc un rang de tri, tandis que `SortedPoints` et ses
       cibles parlent d'indices de `x`. Sans cette conversion, chaque formule
       pointerait sur le mauvais pic — silencieusement, puisque l'indice serait
       bien un nombre. */
    publishableRows(rows,points,bestMatches,ppm){
        const attribution={
            entries:[],
            diagnostics:[...this.plan.diagnostics],
            visited:0,
            truncated:false,
            matched:0,
            pointCount:points.length,
            keptMatches:bestMatches,
            elapsedMs:0,
            strategy:"mixedRadix/rust"
        }
        const {order,x}=points
        for(const row of rows){
            const built=stateToFormula(this.plan,{
                counts:row.counts,
                mass:row.mass
            })
            if(!built) continue
            const {formula,recipe}=built
            const mz=formula.mz
            /* Un m/z non fini ne se range nulle part: une charge nulle donnerait une
               division par zéro, et une masse négative n'est pas un ion. */
            if(!Number.isFinite(mz)||mz<=0) continue
            const index=order[row.peak]
            attribution.entries.push({
                formula,
                key:formula.key,
                notation:String(formula),
                mz,
                mass:formula.mass,
                charge:formula.charge,
                molecule:formula.moleculeKey,
                logProbability:built.logProbability??row.logProbability,
                recipe,
                target:{
                    index,
                    mz:x[index],
                    intensity:points.y[index]??0,
                    /* L'ÉCART VIENT DU KERNEL et n'est PAS recalculé: le classement se
                       ferait sur une valeur et l'affichage en montrerait une autre. Le
                       kernel l'a calculé sur le m/z estimé, donc c'est celle-là. */
                    errorPpm:row.errorPpm
                },
                errorPpm:row.errorPpm,
                inWindow:row.errorPpm!==null&&ppm!==null&&Math.abs(row.errorPpm)<=ppm
            })
            attribution.matched++
        }
        attribution.survived=attribution.entries.length
        attribution.peakList=points
        return attribution
    }
    /* THE RESOLVE: one attribution list per input.

       SEQUENTIAL, and the pattern is FKMDNode's. A spectrum that fails is not a
       reason to abandon the rest: it is recorded and the resolve continues,
       because a broken spectrum is a broken RESULT, not a dead node. */
    async resolveAttributions(){
        const run=++this.run
        const {waves,skipped}=this.collectInputWaves()
        this.skippedInputs=skipped
        if(!this.plan?.items?.length||!waves.length){
            this.attributions=[]
            this.kernelErrors=[]
            this.renderReadout()
            return
        }
        const published=[]
        const errors=[]
        for(let i=0;i<waves.length;i++){
            if(run!==this.run) return        // superseded: publish nothing
            const wave=waves[i]
            /* LAISSER RESPIRER LE NAVIGATEUR ENTRE DEUX SPECTRES.

               C'était nécessaire parce que `attributeWave` était SYNCHRONE:
               plusieurs centaines de millisecondes, deux ou trois secondes sur un
               gros signal, pendant lesquelles le thread principal était occupé —
               donc rien ne se redessinait, le curseur se figeait, et le nœud ne
               pouvait même pas passer en « calcul ».

               Le kernel Rust travaille dans le WORKER, donc le thread principal est
               libre: l'interface redessine pendant que le crible avance. On rend
               donc la main entre deux spectres sans que ce soit une réparation —
               c'est une politesse qui garde la file de rendu dans un ordre connu. */
            if(i>0) await new Promise(resolve=>setTimeout(resolve,0))
            if(run!==this.run) return
            try{
                const result=await this.attributeWaveAsync(wave)
                published.push(result)
                for(const line of result.diagnostics??[]){
                    errors.push(`${wave.metadata?.title??"wave"}: ${line}`)
                }
            }catch(error){
                /* A failure is NAMED, not swallowed: a node that loses a
                   spectrum in silence looks exactly like a node that worked. */
                const message=error?.message??String(error)
                errors.push(`${wave.metadata?.title??"wave"}: ${message}`)
                published.push({entries:[],diagnostics:[message]})
            }
        }
        if(run!==this.run) return
        this.attributions=published
        this.kernelErrors=errors
        this.outputs[0]=this.publishable(published)
        /* "error" only if NOTHING came out. A partial success is a success, and
           a node painted red over three good results would be lying. */
        this.setStatus(errors.length&&!published.some(result=>result.entries.length)
            ?"error"
            :"resolved")
        this.renderReadout()
    }

    /* L'ÉTAT DU NŒUD, et surtout le FAIRE SAVOIR.

       Le nœud assignait `this.status` en silence. Or la couleur du nœud sur le
       graphe n'est pas lue dans le champ: elle vient de l'événement
       `nodeStatusChanged`. Un nœud qui change d'état sans le diffuser ne change
       donc pas d'apparence — et c'est exactement le défaut observé: à la
       re-resolve, le nœud restait VERT pendant tout le calcul, puis le virait
       quand le résultat était déjà là et que l'attente servait à rien.

       Le champ et l'événement doivent dire la MÊME chose au MÊME instant, sinon
       l'interface ment sur l'état réel. D'où une fonction unique, comme dans les
       nœuds voisins, qui pose l'état et le diffuse ensemble. */
    setStatus(status){
        this.status=status
        dispatchEvent(this.events.broadcast.nodeStatusChanged.call(this,status))
    }

    /* What the node PUBLISHES: a REAL FormulaCollection per input wave.

       This used to publish plain descriptors — `{key, notation, mz…}` — and the
       collection reader could do nothing with them. Its `asCollection` accepts
       Formula, Stoichiometry, an array of either, or `{name, formulas|entries|
       items}`, so a descriptor matched none of those four and the reader fell
       through to "nothing readable (Object)". The shape was not merely too
       nested: the ELEMENTS were the wrong TYPE. A descriptor carries a key and
       a notation; a collection holds Formulas.

       So this builds the real thing, and hands it over. Three reasons that is
       the right way round rather than a loosening of the reader's contract:

         - the ppm window, the closest-point rule, deduplication by key and the
           molecule family all LIVE in FormulaCollection. Re-implementing them
           here would give two answers to one question, and the two would
           disagree the day either changed.
         - the collection's OWN matching re-derives the targets from the points,
           so the reader gets the same "closest point wins" semantics everywhere
           instead of trusting ours.
         - a collection is a LIVE object: the reader's graphs, folding and notes
           act on it. A frozen descriptor would need all of that rebuilt.

       THE NOTATION IS WHAT WE HAND OVER, NOT THE KEY, and the reason is in
       FormulaCollection.asFormula: a formula carrying an adduct does not
       survive being re-read from its key, because the adduct's atom is counted
       once in the composition and again in the brackets. The notation we
       produced is the spelling that round-trips, so it is the one that travels.

       The window is left to the collection, so we pass the user's own ppm: two
       windows disagreeing would mean two answers to "is this measured?".

       Points carry their KEY when we found one, and `match()` takes a named
       point at its word rather than re-deriving it by proximity — our pairing
       already knows, and re-deciding it here would be second-guessing a better
       answer with a worse one. */
    publishable(published){
        const table=this.loadedTable
        const ppm=Number(this.parameters.ppm)>0?Number(this.parameters.ppm):10
        return published.map((result,index)=>{
            const wave=this.collectInputWaves().waves[index]
            const name=wave?.metadata?.title??"attribution"
            const collection=new FormulaCollection({name,table,ppm})
            /* `addAll`, and not a loop of `add`.

               `add` takes a STRING and re-reads it, because a human types a
               formula; we already HAVE the Formula, the crible built it. Re-reading
               240 notations is measured at ~106 µs each — about 25 ms — and `add`
               also calls `match()` on every single addition, so the loop would
               re-sort and re-match the whole collection 240 times, which is 97 % of
               the construction time. `addAll` takes the built Formula with its
               notation as the round-trip text, and matches ONCE at the end. Same
               entries, same keys, same targets: `match()` is idempotent. */
            collection.addAll((result.entries??[]).map(entry=>({
                formula:entry.formula,
                /* the notation, not the key — see above */
                sourceText:entry.notation
            })))
            /* The probability is OURS to carry: a collection has no notion of
               how likely the sieve thought a combination was, and dropping it
               would lose the ranking the sieve was built to produce. It rides
               along on the entry, which is a plain object. */
            for(const entry of result.entries??[]){
                const added=collection.find(entry.formula.key)
                if(!added) continue
                added.logProbability=entry.logProbability
                added.recipe=entry.recipe
                /* `inWindow` says whether WE matched it. The collection will
                   match again, on its own window; where the two disagree the
                   reader is right, and the flag is kept only so the readout
                   can say that a difference happened. */
                added.sievedInWindow=entry.inWindow
            }
            /* THE POINTS ARE THE SPECTRUM'S OWN, one per peak.

               The alternative — one point per surviving formula — is the bug this
               replaces. With `bestMatches=3` a 95-peak spectrum produced 240
               points, so every peak appeared three times: the reader's tables
               listed peaks that do not exist, the graphs drew them three times, and
               the point count stopped meaning "95 ions measured". The attributions
               are many-to-one BY CONSTRUCTION — three readings of one peak is the
               feature, not a defect — so the mapping is the other way round, and
               only the peaks that WERE matched appear at all.

               A peak gets its key from the BEST reading of itself, the one the
               sieve ranked first. The other `bestMatches-1` readings are left
               unkeyed rather than competing for it: a key names THE formula a
               peak was called, and three keys on one peak would be a claim the
               ranking does not support. The unkeyed readings are still in the
               collection, still readable, still ranked by `logProbability`. */
            const peakList=result.peakList
            const bestKeyFor=new Map()
            for(const entry of result.entries??[]){
                const pointIndex=entry.target?.index
                if(pointIndex===undefined||pointIndex===null) continue
                if(!bestKeyFor.has(pointIndex)) bestKeyFor.set(pointIndex,entry.key)
            }
            const points=[]
            if(peakList&&peakList.length){
                for(let i=0;i<peakList.length;i++){
                    const mz=peakList.x[i]
                    /* a mass of zero has no ppm and matches nothing, so it is not a
                       peak to publish — the crible's own `nearest` refuses it for
                       the same reason, and the two must agree. */
                    if(!Number.isFinite(mz)||mz===0) continue
                    const key=bestKeyFor.get(i)
                    points.push(key?{mz,key,intensity:peakList.y[i]??0}:{mz,intensity:peakList.y[i]??0})
                }
            }
            collection.setPoints(points)
            /* the sieve's own diagnostics survive the crossing: a refused adduct
               or a truncated sieve is a fact about the RUN, not about the
               collection, and the reader is where a user will look for it. */
            collection.diagnostics.push(...(result.diagnostics??[]))
            /* La troncature ne vient plus de ce nœud — il demande `Infinity` au
               moteur, parce qu'un plafond sur l'ÉNUMÉRATION produirait un préfixe
               trié par masse, pas une attribution. La branche reste donc
               inatteignable en pratique, et c'est bien ainsi qu'il en est.

               Elle est conservée parce que le MOTEUR accepte toujours un plafond,
               pour un appelant qui veut borner unePreview: si un jour quelqu'un
               reintroduit une borne ici, l'avertissement doit déjà exister, sinon
               la liste tronquée partirait sans un mot.

               Le repli lit `truncationLimit`, le nombre que la course a réellement
               utilisé, et non un réglage présent à l'affichage: afficher le
               réglage courant, c'est accuser une course d'une limite qu'elle n'a
               jamais eue. */
            if(result.truncated){
                collection.diagnostics.push(
                    `${name}: the sieve was truncated at ${result.truncationLimit??"an unknown number of"} states — the list is a prefix, not the whole space`
                )
            }
            /* The selection is REPORTED, because "how many readings per peak" is
               the difference between a list of 95 and a list of 285, and the user
               cannot tell those apart by looking. It says what was KEPT per peak
               and how many peaks had at least one candidate — if those two differ,
               some peaks have no explanation inside the window, which is a fact
               about the spectrum and not a failure. */
            if(result.keptMatches!==null&&result.keptMatches!==undefined){
                /* « kept up to N reading(s) per peak » — DISTINCT readings. The
                   word matters: `bestMatches` bounds the number of DIFFERENT
                   formulas kept for one peak, and the engine skips a candidate
                   whose composition is already there. Without that, a peak whose
                   bricks are dependent could return the same formula three times,
                   and the user would read one ambiguous formula as three. */
                collection.diagnostics.push(
                    `${name}: kept up to ${result.keptMatches} DISTINCT reading(s) per peak — ${result.entries.length} formula(s) for ${result.candidates} peak(s); the other ${(result.pointCount??0)-result.candidates} peak(s) had no formula within ${ppm} ppm`
                )
            }
            collection.attributionCount=result.entries.length
            collection.visited=result.visited
            collection.matched=result.matched
            collection.elapsedMs=result.elapsedMs
            collection.truncated=result.truncated
            return collection
        })
    }

    /* The public RESOLVE: the table, the plan, then the attribution. */
    async startResolve(){
        /* L'ÉTAT « CALCUL », DIFFUSÉ ET NON POSÉ EN SILENCE.

           `this.status="pending"` ne changeait RIEN à l'écran: la couleur vient
           de l'événement `nodeStatusChanged`, et un nœud qui écrit dans son
           champ sans diffuser reste peint avec son apparence précédente. À la
           première resolve le nœud était gris et le devenait à la fin, sans
           rien indiquer entre les deux; à la RE-resolve il restait VERT pendant
           tout le calcul — plus trompeur encore, parce que le vert se lisait
           « c'est fait » alors que le travail venait de commencer.

           Le statut est donc posé par `setStatus`, qui pose et diffuse. */
        this.setStatus("pending")
        /* LE DRAPEAU TOMBE ICI, ET LE BOUTON SE REPEINT.

           `resolveNow` ne fait que poser le drapeau, mais `startResolve` est
           aussi appelé par le graphe — une resolve de flux, une restauration de
           session — donc c'est lui, et lui seul, qui sait qu'un calcul vient
           d'aboutir. Sans cette ligne, un nœud résolu par le graphe gardait
           « Resolve (never run) » au-dessus d'un readout plein de résultats.

           Le drapeau part AVANT le calcul: pendant celui-ci, le nœud doit avoir
           l'air de ne plus être à jour, sinon on rejoue le défaut que
           `markStale` corrige. */
        this.needsResolve=false
        this.staleReason=null
        this.renderResolveButton()
        /* Le readout est repeint tout de suite, AVANT le calcul: il passe au
           plan courant et annonce la résolution, donc l'utilisateur a quelque
           chose à lire pendant que ça tourne. */
        this.renderReadout()
        await this.table()
        this.buildPlan()
        await this.resolveAttributions()
        /* `renderAll` est désormais async — il attend la table. On l'attend donc
           aussi: sans cela, `saveSessionSoon` partirait avant que l'affichage soit à
           jour, et une session relue pourrait enregistrer un état que l'écran n'a
           pas encore montré. */
        await this.renderAll()
        this.origin?.saveSessionSoon?.()
    }
    /* The INTERFACE, in the accordion.

       Two text areas (one per list), five number fields, and a readout. That is
       everything the node exposes, and everything it can: each setting bounds
       the sieve, and a setting that did not bound the sieve would not belong
       here. */
    setupUI(){
        if(!this.accordion) return
        const content=this.accordion.DOMelt.content
        content.replaceChildren()
        /* LE NŒUD EST ARMÉ ICI, ET C'EST SON SEUL POINT D'ENTRÉE.

           `setupUI` reconstruit le panneau entier: c'est le moment où le nœud
           apparaît, et aussi celui où il revient après une session rechargée. Or
           rien n'attendait la table à ce moment-là — donc la table arrivait plus
           tard, en silence, et personne ne redessinait: les blocs isotopiques
           restaient vides et la Probe muette jusqu'au premier Resolve.

           On demande donc la table dès maintenant. Elle est déjà en vol de toute
           façon (l'App la charge au démarrage), donc ceci ne coûte rien — et
           `armProbe` attendra qu'elle soit là pour répondre. Le nœud devient ainsi
           utilisable seul, ce qu'il doit être: une calculette doit répondre sans
           qu'on la connecte à quoi que ce soit. */
        this.armProbeOnTable()
        /* "content" sizing, not "viewport": the panel is two text areas and a
           few lines, so it must be as tall as what it holds. There is no plot
           here, and a 260 px box around five lines would be mostly empty. */
        this.accordion.setSizingMode("content")
        /* LA RÈGLE DU SPINNER, POSÉE UNE SEULE FOIS.

           Le navigateur ne donne aucun attribut pour masquer les flèches d'un
           `type=number`; il faut une règle CSS sur la pseudo-classe interne. On
           l'ajoute ici, au panneau, plutôt que dans `field`: la fonction est
           appelée à chaque reconstruction de tableau, et une règle par appel
           empilerait des `<style>` sans fin.

           Les DEUX sélecteurs sont dans la même règle parce qu'ils visent deux
           navigateurs différents — `-webkit-inner-spin-button` pour Chrome et
           Safari, `-moz-appearance` pour Firefox. N'en écrire qu'un laisserait
           les flèches sur la moitié des postes. */
        /* LE STYLE EST POSÉ DANS LE `<head>`, ET UNE SEULE FOIS.

   Le panneau est vidé par `replaceChildren()` à chaque `setupUI`, donc une règle
   posée dedans disparaît — et une règle recréée à chaque appel empilerait une
   balise par reconstruction de tableau. Le `<head>` survit au panneau, et le
   garde évite le doublon.

   `setAttribute`, ET NON `dataset`. `dataset.anUI` s'écrit `data-an-u-i` — le
   d de « UI » devient « u-i » — donc le sélecteur `style[data-an-ui]` ne
   retrouvait JAMAIS la balise. Le garde paraissait donc justifié alors qu'il ne
   l'était pas: chaque appel de `setupUI` empilait une règle, et le test
   « une seule règle » échouait sans qu'on comprenne pourquoi. Un attribut
   écrit en entier ne sufferte pas de cette conversion implicite. */
        if(!document.head.querySelector("style[data-an-ui]")){
            const uiStyle=document.createElement("style")
            uiStyle.setAttribute("data-an-ui","1")
            uiStyle.textContent=
                ".no-spin::-webkit-inner-spin-button,"+
                ".no-spin::-webkit-outer-spin-button{-webkit-appearance:none;margin:0}"+
                ".no-spin{-moz-appearance:textfield}"
            document.head.appendChild(uiStyle)
        }
        stylize(content,{
            display:"grid",
            "grid-template-columns":"minmax(0, 1fr)",
            padding:"4px",
            gap:"4px"
        })
        /* LE CHAMP DE SAISIE, AU-DESSUS DE SA LISTE, ET PAS À CÔTÉ DE L'AUTRE.

           Le champ ne remplace pas le tableau: il AJOUTE une ligne. Les deux
           vivent ensemble parce qu'ils font deux gestes différents — taper un
           groupe nouveau, ou régler un groupe existant.

           Et ils doivent être LUS ENSEMBLE. Les deux champs d'abord, puis les
           deux tableaux, obligeait l'œil à sauter d'une liste à l'autre pour
           savoir à quoi le champ se rapporte: « Add an ionising group » était
           collé à la liste des groupes NEUTRES, qu'il ne concernait pas.

           Donc chaque bloc est le champ PUIS son tableau, et les deux blocs
           sont séparés visuellement. Le second porte d'ailleurs son propre
           titre de liste, alors que le premier dépendait du seul libellé du
           champ — on ne lit plus une liste orpheline. */
        this.combiningInput=this.field(content,
            "Add a group to combine",
            "",
            {
                onCommit:(value)=>this.addGroup("combining",value)
            },
            "CH2, O, NH... Adds one row to the table below. Enter applies it"
        )
        this.combiningTable=this.groupTable(content,"combining","Groups to combine")
        /* LA SÉPARATION. Un simple `gap` ne disait rien — les deux blocs avaient
           la même apparence, et rien n'indiquait qu'on passait d'une liste à
           l'autre. Un filet de rien, plus une marge au-dessus du second bloc,
           donne la séparation sans ajouter de titre: les titres sont déjà là. */
        this.groupDivider=CE("div",{className:"an-divider"},[])
        stylize(this.groupDivider,{
            height:"1px",
            margin:"6px 2px 2px",
            background:"rgba(255,255,255,0.18)"
        })
        content.appendChild(this.groupDivider)
        this.ionisingInput=this.field(content,
            "Add an ionising group",
            "",
            {
                onCommit:(value)=>this.addGroup("ionising",value)
            },
            "[H+], [Na+], [2+]... Adducts must carry a charge. Enter adds one row"
        )
        this.ionisingTable=this.groupTable(content,"ionising","Ionising groups")
        /* `field` returns its input, and the numeric ones are KEPT: `syncUI` has to
           be able to write a restored value back into the field it came from,
           otherwise the screen shows one setting and the sieve uses another. The
           five numbers are kept for that reason, and a reload used to move them
           on screen only. */
        /* LE « ISOTOPIC WINDOW » GLOBAL A DISPARU DE L'ÉCRAN, et c'est la
           conséquence directe du ratio par ligne.

           Un seuil unique devait couvrir tous les groupes à la fois, donc ouvrir
           le ¹³C ouvrait le ¹⁷O, et les deux multipliaient le nombre de briques
           pour rien. Le seuil est maintenant une case de chaque ligne du tableau.
           Le PARAMÈTRE reste — des sessions l'ont, et il sert de repli quand une
           ligne ne dit rien — mais l'afficher serait un double emploi: deux
           réglages pour une seule chose, dont un que personne ne devrait avoir à
           toucher. */
        /* LES CHARGES ATTEIGNABLES, ET ELLES SE LISENT — PLUS DE DEUX CHAMPS.

           Un « Charge min » et un « Charge max » donnaient un INTERVALLE, donc
           « entre 1 et 2 » — ce qui laisse croire que 1,5 existe. Les adduits ne
           donnent que des charges entières, et l'ensemble réel est souvent plus
           court que l'intervalle: [H+] seul donne « 1 »; [H+] et [Na+] donnent
           « 1, 2 ».

           Une LIGNE, donc, parce que la question n'est pas « quelles bornes? »
           mais « quelles charges ai-je? ». Et elle est déduite, pas saisie: elle
           ne peut pas mentir sur les réglages qui la produisent.

           Elle reste le seul endroit où la charge se lit, donc elle doit aussi
           dire ce qui n'est PAS possible — les bornes restent appliquées par le
           plan, et c'est le readout qui annonce le refus. */
        this.chargeLabel=CE("div",{className:"an-charges"},[])
        stylize(this.chargeLabel,{fontSize:"0.8em",lineHeight:"1.35"})
        content.appendChild(this.chargeLabel)
        /* L'ANCIEN CHAMP « Attributions per spectrum » ÉTAIT MORT.

           Il écrivait `parameters.limit`, un réglage que le renommage a retiré de
           la lecture — le champ s'affichait, acceptait la frappe, et ne
           produisait aucun effet: le pire genre de contrôle, parce qu'il a
           l'air de faire son travail. Personne ne l'aurait signalé de lui-même,
           puisque changer la valeur ne changeait rien — c'est exactement le
           défaut qu'on ne voit pas.

           Il est remplacé par ce qui existe réellement: combien de lectures
           GARDER par pic. Le plafond était de 1 à 1e6 parce qu'il comptait des
           états de crible; ici 1 à 20 suffit, parce qu'au-delà le tableau
           devient illisible de toute façon. Une borne honnête vaut mieux qu'une
           borne copier-coller. */
        /* LES DEUX RÉGLAGES DE LECTURE, SUR UNE MÊME RANGÉE.

           Ils posaient chacun DEUX lignes — un libellé puis une case — pour
           dire deux choses voisines: combien de lectures garder par pic, et à
           quelle erreur elles sont encore acceptées. Rien ne les oppose, et
           rien ne les sépare à l'écran non plus.

           Une grille à deux colonnes les met côte à côte et rend le couple
           visible. Les libellés raccourcis — « Matches per mass » et
           « Tolerance » — disent la même chose en deux mots; le détail long
           reste dans l'infobulle, qui n'a pas bougé.

           `field` reçoit une cible optionnelle: sans elle, il se comporte
           exactement comme avant. C'est ce qui permet de garder une seule
           fonction pour les champs sur une ligne et ceux sur deux. */
        const readingRow=CE("div",{className:"an-row"},[])
        stylize(readingRow,{
            display:"grid",
            "grid-template-columns":"1fr 1fr",
            gap:"6px",
            "align-items":"start"
        })
        content.appendChild(readingRow)
        this.bestMatchesInput=this.field(readingRow,"Matches per mass",this.parameters.bestMatches,{
            tag:"number",
            onCommit:(raw)=>this.commitNumber("bestMatches",raw,1,20)
        },"How many readings of EACH PEAK to keep, ranked by mass error. The sieve is walked whole, so this never truncates the search — it only bounds the list you read")
        this.ppmInput=this.field(readingRow,"Tolerance",this.parameters.ppm,{
            tag:"number",
            onCommit:(raw)=>this.commitNumber("ppm",raw,0,10000)
        },"Match window, in ppm. A formula further off than this is not proposed at all; inside it, the measured offset is reported")
        /* LE BOUTON RESOLVE, et il EXISTE POUR UNE RAISON MESURÉE.

           Chaque changement de case relançait tout le crible. Sur une liste de
           groupes c'est insupportable — et surtout inutile: changer le `max` de
           CH2 n'a rien à voir avec la formule qu'on cherche, et payer le plan
           complet à chaque frappe est du temps brûlé.

           Donc les réglages MARQUENT le nœud comme à recalculer, et le bouton
           fait le calcul. Le bouton se lit « Resolve » quand il y a quelque chose
           à faire et « up to date » quand il n'y a rien — un bouton qu'on peut
           cliquer sans effet apparent apprend à ne pas être cliqué. */
        this.resolveButton=CE("button",{type:"button"},["Resolve"])
        stylize(this.resolveButton,{
            fontSize:"0.85em",padding:"3px 10px",cursor:"pointer",
            color:"inherit",background:"rgba(255,255,255,0.08)",
            border:"1px solid rgba(255,255,255,0.2)",borderRadius:"3px"
        })
        this.resolveButton.addEventListener("click",()=>this.resolveNow())
        content.appendChild(this.resolveButton)
        /* LE BOUTON EST PEINT TOUT DE SUITE, et pas seulement quand un
           réglage change. `renderResolveButton` n'était appelé que par
           `markStale` et `resolveNow` — donc un nœud qui n'avait jamais rien
           calculé gardait l'étiquette peinte à la construction, « Resolve »,
           alors que le test de `resolveNow` le faisait sortir sans rien
           calculer. Le bouton et son comportement disaient deux choses
           différentes dès la première seconde. On le rend donc ici, une fois,
           dans l'état réel. */
        this.renderResolveButton()

        /* LE CHAMP DE MASSE, et il ne dépend d'aucun pic mesuré.

           Les autres réglages répondent à « qu'est-ce que MES pics sont? ». Celui-ci
           répond à « qu'est-ce que CETTE masse pourrait être? » — la question
           inverse, celle qu'on se pose devant un pic inconnu. Le même plan et le
           même crible répondent aux deux; seule l'entrée change.

           LA FENÊTRE EST DE ±0,5, et c'est un choix de GÉOMÉTRIE: à CH₂/NH/O/C
           une substitution d'un atome léger pèse 1 à 16 Da, donc 0,5 ne peut pas
           confondre deux formules voisines — et une masse exacte a cinq chiffres
           décimaux, donc un intervalle plus serré n'aurait rien à montrer. */
        /* LA SONDE: UN FOND, UN NOM COURT, ET PAS DE FLÈCHES.

           « Probe a mass (m/z) » disait trois choses dont une inutile — le
           m/z est ce que le champ attend, et l'infobulle le dit. « Probe » seul
           suffit, et le fond le détache du reste du panneau: c'est la seule
           partie de ce nœud qui ne décrit PAS les réglages en cours mais
           répond à une question posée au coup par coup. Elle se lit donc
           autrement, et c'est utile quand le panneau fait quinze lignes.

           LES FLÈCHES DISPARAISSENT. Une masse n'est pas un entier: le spinner
           du navigateur l'avance de 1 à chaque cran, ce qui est absurde entre
           46.04186 et 46.04187, et il fait perdre la main sur une saisie au
           dixième de dalton. Le champ reste `type=number` — donc la validation
           reste celle du navigateur — mais sans les boutons.

           Le `step` est mis très fin, parce qu'un `type=number` sans flèches
           utilise le pas du navigateur pour les touches ↑/↓, qui resteraient
           sinon par crans de 1. */
        this.massInput=this.field(content,"Probe",this.parameters.probeMass??"",{
            tag:"number",
            noSpinner:true,
            step:"0.00001",
            onCommit:(raw)=>this.probeMass(raw)
        },"Type one m/z to see what the current plan makes of it. Enter runs it over ±0.5")
        stylize(this.massInput,{
            background:"rgba(120,180,255,0.10)",
            border:"1px solid rgba(120,180,255,0.28)"
        })
        this.probeOutput=CE("div",{className:"an-probe"},[])
        stylize(this.probeOutput,{
            fontSize:"0.8em",lineHeight:"1.35",whiteSpace:"pre-wrap",opacity:"0.9",
            background:"rgba(120,180,255,0.06)",
            padding:"3px 5px",
            borderRadius:"3px"
        })
        content.appendChild(this.probeOutput)
        this.renderGroupTables()
        /* LA LISTE DE RÉFÉRENCES SUIT LE PLAN, ici et partout où le plan change.

           Un plan se reconstruit à l'ouverture du panneau, au resolve et quand
           une liste de groupes change. Trois endroits, donc trois appels — ou
           un seul, si c'est la FIN de `renderGroupTables`, que tous trois traversent.
           La liste de références est une DÉRIVÉE du plan, et une
           dérivée rafraîchie à la main est une dérivée qui finira périmée. */
        this.refreshForestPlan()
        /* LA SONDE PART TOUTE SEULE, après les tableaux: le plan existe donc, et si
           elle a à attendre la table, elle attend sur un panneau déjà dessiné — pas
           sur un panneau vide. */
        this.armProbe()
        this.readout=CE("div",{style:{fontSize:"0.8em",lineHeight:"1.35",whiteSpace:"pre-wrap"}},[])
        content.appendChild(this.readout)
    }

    /* LE TABLEAU DES GROUPES, et il est reconstruit à chaque changement.

       Une ligne par groupe: la formule, min, max, le ratio, la suppression. Les
       deux listes partagent la MACHINE, pas les valeurs par défaut — un adduit
       s'exige, un groupe de masse se propose.

       LE TABLEAU EST REDESSINÉ ENTIÈREMENT à chaque fois, et c'est un choix: une
       liste de groupes fait cinq à dix lignes, donc virtualiser serait du travail
       pour rien, et le redessin garantit qu'aucune ligne ne garde l'état d'un
       groupe supprimé. */

    /* Une case. `∞` est affiché POUR `Infinity`, parce que c'est ce que la case
       contient: si elle dit « ∞ », taper remplace l'infini par un nombre, ce
       qui est exactement ce qu'on veut. « Infinity » obligerait à deviner quoi
       taper. */
    boundCell(value,onCommit,{title}={}){
        const input=CE("input",{
            type:"text",spellcheck:false,
            value:value===Infinity?"∞":String(value),title
        },[])
        stylize(input,{
            width:"100%",boxSizing:"border-box",fontSize:"0.85em",
            padding:"1px 3px",borderRadius:"2px",fontFamily:"monospace",
            textAlign:"center",background:"rgba(255,255,255,0.06)",
            border:"1px solid rgba(255,255,255,0.15)"
        })
        input.addEventListener("keydown",(event)=>{
            if(event.key==="Enter"){ event.preventDefault(); onCommit(input.value) }
        })
        /* LE BLUR VALIDE AUSSI: on ne laisse pas une valeur saisie sans effet,
           parce qu'un réglage affiché et jamais appliqué est le défaut qu'on ne
           voit pas — il a l'air de fonctionner. */
        input.addEventListener("blur",()=>onCommit(input.value))
        /* ET TOUTE CORRECTION AU CLAVIER, POUR LA MÊME RAISON.

           Ces cases sont en `type="text"` — la borne admet « ∞ », qui n'est pas
           un nombre — donc elles n'ont pas de spinner natif. En revanche elles
           se corrigent au clavier, et une case où l'on peut écrire une valeur
           qui n'est jamais appliquée est exactement le défaut que ce fichier
           dénonce à longueur de chapitre. */
        input.addEventListener("change",()=>onCommit(input.value))
        return input
    }

    groupRowStyle(){
        return {
            display:"grid",gap:"3px",alignItems:"center",
            gridTemplateColumns:"1fr 3.2em 3.2em 3.6em 1.6em"
        }
    }

    /* UN ENCADRE PAR LISTE, et c'est ce qui rend la séparation lisible.

       Les deux listes se ressemblaient — même grille, mêmes colonnes, même
       police — et rien ne disait à l'œil que « combining » et « ionising » sont
       deux étapes différentes, avec deux conséquences différentes. Une ligne mal
       placée ne se voyait qu'à la lecture du texte.

       Le cadre ne sert qu'à ça. Les deux cadres se ressemblent parce que le code qui
       les dessine est le même: l'égalité des formes est donc lisible, et non un
       hasard de décoration. */
    groupTable(content,kind,label){
        const box=CE("div",{className:"an-group-table"},[])
        const caption=CE("div",{className:"an-caption"},[label])
        const head=CE("div",{},["group","min","max","isotope",""])
        const rows=CE("div",{className:"an-group-rows"},[])
        stylize(caption,{fontSize:"0.8em",opacity:"0.85"})
        stylize(head,this.groupRowStyle())
        for(const cell of head.children) stylize(cell,{
            fontSize:"0.7em",opacity:"0.7",textAlign:"center",overflow:"hidden"
        })
        /* L'ENCADRE: une bordure, un fond à peine détaché, et de la marge en bas
           pour que deux cadres voisins ne se touchent pas. Le fond est presque
           nul — il n'est là que pour que la bordure se lise sans dépendre du
           contraste du texte. */
        stylize(box,{
            display:"flex",flexDirection:"column",gap:"3px",
            padding:"5px 6px 6px",
            border:"1px solid rgba(255,255,255,0.14)",borderRadius:"4px",
            background:"rgba(255,255,255,0.025)",
            marginBottom:"8px"
        })
        /* L'ADDUIT EST ENCADRÉ DIFFÉREMMENT, et c'est délibéré: c'est la seule
           liste où la ligne doit exister. `min:1` signifie « un adduit est
           obligatoire » — une liste ionisante vide ne rend aucun m/z, donc le
           nœud ne trouve rien. Un cadre différent dit « attention ici » avant
           même d'avoir lu le mode d'emploi. */
        if(kind==="ionising"){
            stylize(box,{
                borderColor:"rgba(120,180,255,0.34)",
                background:"rgba(120,180,255,0.055)"
            })
        }
        box.append(caption,head,rows)
        content.appendChild(box)
        return {box,rows,kind}
    }

    /* LES BLOCS ISOTOPIQUES DE LA LIGNE, et c'est l'info qui rend le `ratio`
       pilotable au lieu d'être deviné.

       Le `ratio` de la troisième case ne prend son sens qu'une fois qu'on voit ce
       qu'il a produit: `0.01` ne veut rien dire tant qu'on ne sait pas si ça a
       ouvert le 13C, le deutérium, ou les deux. L'utilisateur qui tatonne n'a pas
       besoin d'une nouvelle notion — la profondeur — il a besoin de la LISTE, qui
       est déjà calculée.

       On lit donc `plan.combinables` / `plan.ionisers` et on regroupe par
       `groupIndex`, qui est la clé de LIGNE (`combining#2`), pas la clé de groupe:
       c'est ce qui permet de rattacher chaque bloc à la ligne qu'il vient, y
       compris quand deux lignes nomment le même groupe.

       UNE LIGNE SANS AUCUN BLOC EST UN CAS RÉEL — un `ratio` trop serré sur un
       groupe isotopiquement pauvre, ou un groupe qui ne parse pas. On l'affiche
       donc quand même, sinon l'utilisateur verrait une ligne muette et ne
       comprendrait pas pourquoi elle ne contribue rien. */
    isotopeBlocks(table,index){
        const key=(table.kind==="ionising"?"ionising#":"combining#")+index
        const source=table.kind==="ionising"
            ?(this.plan?.ionisers??[])
            :(this.plan?.combinables??[])
        return source
            .filter(block=>block.groupIndex===key)
            .map(block=>({
                /* LA NOTATION, ET ELLE SE DESSINE.

                   C'est le même geste que la liste de formules du lecteur, et
                   pour la même raison: `notation` abrège l'isotope par défaut —
                   "C H2" — et c'est cette forme qu'un humain écrit. La clé, elle,
                   dit "12C 1H2", ce qui est exact mais n'est pas une écriture:
                   personne n'écrit un A sur chaque atome d'un groupe, et la
                   ligne devenait illisible au moment précis où l'utilisateur
                   cherche à voir CE QUE SON `ratio` A OUVERT.

                   Le titre garde la notation et non la clé, pour la même
                   cohérence: les deux se lisent dans la même colonne. */
                notation:prettyNotation(block.notation),
                key:block.key,
                mass:block.atomicMass,
                logProbability:block.logProbability
            }))
    }

    /* UNE LIGNE, neuve à chaque redessin — donc aucun état ne survit à la
       suppression d'une autre ligne. */
    drawGroupRow(table,entry,index){
        const adducts=table.kind==="ionising"
        const fallback={min:adducts?1:0,max:adducts?1:Infinity,ratio:1}
        const row=CE("div",{},[])
        stylize(row,this.groupRowStyle())
        const name=CE("span",{},[String(entry.group)])
        stylize(name,{
            fontSize:"0.85em",fontFamily:"monospace",overflow:"hidden",
            textOverflow:"ellipsis",whiteSpace:"nowrap"
        })
        row.appendChild(name)
        const commit=(field,raw)=>{
            const groups=this.groupList(table.kind)
            const target=groups[index]
            if(!target) return
            target[field]=raw
            this.commitGroups(table.kind,groups)
        }
        row.appendChild(this.boundCell(entry.min??fallback.min,
            (raw)=>commit("min",raw),
            {title:"Fewest copies of this group. For an adduct, 1 means it is required"}))
        row.appendChild(this.boundCell(entry.max??fallback.max,
            (raw)=>commit("max",raw),
            {title:"Most copies of this group, counted over ALL its isotopes. ∞ means no limit"}))
        row.appendChild(this.boundCell(entry.ratio??fallback.ratio,
            (raw)=>commit("ratio",raw),
            {title:"Isotopic window for THIS group alone. 1 keeps only the most probable isotope, 0 keeps every one"}))
        const remove=CE("button",{type:"button",title:"Remove this group"},["✕"])
        stylize(remove,{
            fontSize:"0.8em",lineHeight:"1",padding:"2px",cursor:"pointer",
            color:"inherit",background:"rgba(255,255,255,0.08)",
            border:"1px solid rgba(255,255,255,0.15)",borderRadius:"2px"
        })
        remove.addEventListener("click",()=>{
            const groups=this.groupList(table.kind)
            groups.splice(index,1)
            this.commitGroups(table.kind,groups)
        })
        row.appendChild(remove)
        /* LA LIGNE DES BLOCS, ET ELLE EST DANS LA CELLULE DU GROUPE.

           Elle ne devient pas une colonne: elle n'a pas de titre et n'en veut pas,
           n'étant pas une donnée saisie mais la CONSÉQUENCE du `ratio` de cette
           ligne. Elle passe donc sur la rangée suivante, en pleine largeur, pour
           qu'on la lise comme le prolongement du groupe. */
        const blocks=this.isotopeBlocks(table,index)
        const listing=CE("div",{},[
            blocks.length
                ? blocks.map(block=>block.notation).join("  ·  ")
                : "— no isotope block —"
        ])
        stylize(listing,{
            /* LA GRILLE A 5 COLONNES, et c'est elle qui décide de la forme. Une ligne
               sur toute la largeur se déclare `gridColumn: "1 / -1"`. Un `flexBasis`
               n'aurait rien fait ici, et la liste se serait retrouvée tassée dans la
               colonne du nom du groupe.

               Le `minWidth:0` est nécessaire: sans lui, une liste longue refuse de
               rétrécir et pousse les colonnes min/max/isotope hors du panneau. */
            gridColumn:"1 / -1",
            minWidth:0,
            fontSize:"0.72em",fontFamily:"monospace",
            opacity:"0.72",paddingTop:"1px",paddingBottom:"3px",
            lineHeight:"1.5",wordBreak:"break-word",textAlign:"left"
        })
        if(!blocks.length){
            stylize(listing,{fontStyle:"italic"})
        }
        /* Le titre porte le DÉTAIL que la ligne seule ne montre pas: les masses et
           les probabilités relatives, qui sont ce qui permet de juger si un bloc vaut
           le coup d'être gardé. */
        listing.title=blocks.length
            ? blocks.map(block=>
                `${block.notation} — ${block.mass.toFixed(4)} Da`+
                `, P relative ${Math.exp(block.logProbability).toExponential(2)}`
            ).join("\n")
            : "This group produced no combinable mass: check its spelling, or loosen "+
              "its isotopic window"
        row.appendChild(listing)
        return row
    }

    /* LA SONDE DE MASSE, ET ELLE EST ASYNCHRONE.

       Elle construit cette fenêtre de trois points et appelle le moteur dessus.

       ELLE ATTEND LA TABLE, parce qu'elle doit RÉPONDRE. Sans table, le plan n'a
       aucune masse, le crible ne trouve rien, et la sonde affichait « no formula
       within 10 ppm » — un résultat FAUX, prononcé avec l'apparence d'un calcul
       fait. C'est le pire genre de défaut pour une calculette: l'utilisateur tape
       46.04186, lit « aucune formule », et conclut que sa masse n'existe pas.

       Un nœud d'attribution se doit d'être opérationnel SEUL, pour son seul Probe,
       sans spectre et sans resolve. Donc la sonde attend `tableReady`, puis
       reconstruit le plan sur la table obtenue, puis répond. Elle est donc
       `async` — et c'est le seul endroit du nœud qui l'est pour cette raison. */
    /* LE NŒUD SE REMPLIT TOUT SEUL, et c'est ce qui le rend utilisable sans rien.

       La table arrive en arrière-plan: au moment où le panneau se dessine, elle
       n'est pas encore là. Attendre ici — et redessiner quand elle est arrivée —
       est donc la seule façon que la Probe réponde et que les blocs isotopiques
       s'affichent SANS qu'aucun clic n'ait eu lieu.

       Sans cela, le nœud posé était visuellement mort: deux cadres vides et une
       Probe muette, alors qu'il était prêt. C'est exactement ce qu'il ne faut pas
       à une calculette.

       CET APPEL EST FAIT EN TÊTE DE `setupUI`, donc AVANT que le champ et la
       sortie de la sonde existent. C'est sans conséquence: la fonction est async,
       elle rend la main à l'instant de l'appel, et le `await this.table()` se
       résout après que le panneau a été construit. Le test ci-dessous n'en est pas
       moins nécessaire — une table déjà en cache se résout dans la microtâche
       suivante, ce qui peut donc arriver avant la fin du montage. */
    async armProbeOnTable(){
        await this.table()
        /* LE PANNEAU EXISTE-T-IL ENCORE? Il a pu être redessiné ou détruit pendant
           l'attente — une session rechargée, un nœud retiré du graphe. Sans ce
           test, on écrirait dans un `probeOutput` détaché: sans effet, et sans
           erreur. Le nœud resterait muet sans jamais rien signaler. */
        if(!this.probeOutput) return
        this.buildPlan()
        this.renderGroupTables()
        this.armProbe()
    }

    /* LA SONDE EST ARMÉE À LA CRÉATION, et c'est ce qui rend le nœud utilisable SEUL.

       Un nœud d'attribution est une petite calculette autant qu'un lecteur de
       spectres: on doit pouvoir y taper une masse et lire une formule, sans
       connecter d'entrée, sans cliquer Resolve, et sans attendre quoi que ce soit.
       Or la sonde ne répondait qu'après une frappe — donc un nœud fraîchement posé
       était visuellement mort, alors qu'il était prêt.

       On la déclenche donc ici, au montage, si bien sûr il y a une masse à sonder.
       Elle attend la table toute seule, et affiche « Loading the periodic
       table… » pendant ce temps — donc le nœud se remplit tout seul, sans que
       l'utilisateur ait rien demandé.

       L'absence de masse est un CAS NORMAL, pas un oubli: une session relue peut
       avoir un champ vide. On n'invente donc rien, et on attend la saisie. */
    armProbe(){
        const raw=this.parameters.probeMass
        if(raw===undefined||raw===null||raw==="") return
        this.probeMass(raw)
    }

    async probeMass(raw){
        const mass=Number(raw)
        const output=this.probeOutput
        if(!Number.isFinite(mass)||mass<=0){
            if(output) output.textContent=mass<=0
                ?"That m/z must be above zero."
                :"Type a number to probe."
            return
        }
        this.parameters.probeMass=mass
        /* L'ATTENTE EST VISIBLE. Un champ vide pendant 400 ms ressemblerait à un
           nœud mort; on dit donc ce qui se passe, plutôt que de laisser l'utilisateur
           deviner s'il a mal tapé. */
        if(output&&!this.loadedTable){
            output.textContent="Loading the periodic table…"
        }
        /* On attend SI, ET SEULEMENT SI, la table manque. Quand elle est là — cas
           ordinaire après le premier chargement — la sonde reste synchrone et ne
           coûte aucun tour de boucle. */
        if(!this.loadedTable){
            await this.table()
        }
        /* Si la table a ÉCHOUÉ, on le dit, au lieu de SONDER SUR UN PLAN VIDE. Le
           solveur serait muet, donc la réponse « aucune formule » serait à nouveau
           fausse — cette fois pour une cause qu'on connaît. */
        if(!this.loadedTable){
            if(output){
                output.textContent="The periodic table did not load, so no formula "+
                    "can be attributed to this mass."
            }
            return
        }
        /* LE PLAN EST RECONSTRUIT ICI, et pas réutilisé tel quel: il a pu être
           bâti sans table, au premier dessin des tableaux. Reconstruire sur la
           table obtenue est une fraction de milliseconde, et garantit que la sonde
           répond avec les réglages ET la table réellement en vigueur. */
        let result
        try{
            result=attributeSpectrum(this.buildPlan(),windowFor(mass),{
                limit:Infinity,ppm:this.parameters.ppm,
                bestMatches:this.parameters.bestMatches
            })
        }catch(error){
            if(output) output.textContent=`The sieve refused this mass: ${error.message}`
            return
        }
        const centre=result.entries
            .filter(entry=>entry.target?.index===1)
            .sort((a,b)=>Math.abs(a.errorPpm)-Math.abs(b.errorPpm))
        if(!output) return
        if(!centre.length){
            output.textContent=`${mass} — no formula within `+
                `${this.parameters.ppm} ppm. Loosen the isotope windows, or the counts.`
            return
        }
        const lines=centre.map(entry=>
            `${prettyNotation(entry.notation)}  ${entry.mz.toFixed(5)}  `+
            `${entry.errorPpm>=0?"+":""}${entry.errorPpm.toFixed(2)} ppm`)
        output.textContent=`${mass} — ${centre.length} reading(s):\n${lines.join("\n")}`
    }

    /* LE TABLEAU, encore. Il est redessiné après chaque resolve parce que le plan
       peut avoir changé sous les pieds du lecteur — une session relue avec des
       groupes que le plan ne connaît pas doit le montrer. */
    /* LE PLAN EXISTE AVANT LES TABLEAUX, et c'est ce qui rend les blocs isotopiques
       visibles dès le premier affichage.

       Le tableau se dessine au montage du panneau, alors que le plan ne naissait
       qu'au resolve: la ligne des blocs était donc vide — ou absente — tant que
       l'utilisateur n'avait pas lancé un calcul. C'est absurde, parce que les
       blocs isotopiques ne dépendent QUE des listes de groupes: ils ne demandent ni
       spectre, ni attribution, ni résolution. Les fabriquer est le travail même de
       `buildPlan`, qui est une fraction de milliseconde.

       On construit donc le plan si besoin, ici, et seulement s'il manque. Le plan
       du resolve reste maître : quand il existe déjà, c'est lui qu'on affiche, donc
       l'affichage et la résolution ne peuvent pas diverger. */
    renderGroupTables(){
        if(!this.plan){
            try{
                this.buildPlan()
            }catch(error){
                /* LE PANNEAU DOIT S'AFFICHER QUAND MÊME. Un plan qui échoue — pas de
                   table périodique chargée, un groupe illisible — est un PROBLÈME À
                   PARTIR, pas une raison de laisser un cadre vide à l'écran: le
                   défaut serait invisible, et l'utilisateur croirait l'application
                   cassée alors que c'est sa liste qui l'est.

                   On laisse donc `this.plan` à null: les tableaux se rendent sans
                   blocs, et le resolve, lui, refusera proprement plus tard. */
                this.plan=null
            }
        }
        for(const table of [this.combiningTable,this.ionisingTable]){
            if(!table) continue
            table.rows.replaceChildren()
            const groups=this.groupList(table.kind)
            if(!groups.length){
                const empty=CE("div",{},["— no group yet —"])
                stylize(empty,{fontSize:"0.8em",opacity:"0.5",padding:"2px"})
                table.rows.appendChild(empty)
                continue
            }
            groups.forEach((entry,index)=>{
                table.rows.appendChild(this.drawGroupRow(table,entry,index))
            })
        }
    }

    /* AJOUTER UN GROUPE, et le champ se vide après coup — parce que la ligne
       reste visible dans le tableau. Sans ça, taper « CH2 » puis « NH » laisserait
       les deux dans le champ, et il faudrait deviner lequel a été ajouté. */
    addGroup(kind,value){
        const text=String(value??"").trim()
        if(!text) return
        const groups=this.groupList(kind)
        groups.push(this.readGroups([text],kind)[0])
        this.commitGroups(kind,groups)
        if(kind==="combining"&&this.combiningInput) this.combiningInput.value=""
        if(kind==="ionising"&&this.ionisingInput) this.ionisingInput.value=""
    }

    /* MARQUER « À RECALCULER », ET NE PAS RECALCULER.

           C'est le comportement que demande l'écran: régler une case ne lance
           rien, le bouton lance. Le nœud passe donc en « floating » — qui veut
           dire « ses résultats ne correspondent plus à ses réglages » — et le
           bouton s'allume.

           `needsResolve` est le FIL réel de l'état, et pas la couleur: une
           couleur peut mentir (elle vient d'un événement), un drapeau non. */
    markStale(reason){
        this.needsResolve=true
        this.staleReason=reason??this.staleReason
        this.setStatus("floating")
        this.renderResolveButton()
        this.renderReadout()
        return this
    }

    resolveNow(){
        /* « RIEN À FAIRE » ET « JAMAIS CALCULÉ » NE SONT PAS LA MÊME CHOSE.

           Le test était `!this.needsResolve`, et `needsResolve` vaut faux tant
           que personne n'a changé un réglage. Un nœud qui n'a JAMAIS été
           résolu est donc dans le même cas qu'un nœud à jour: le bouton se
           nommait « Resolve », s'affichait actif, et sortait ici sans rien
           calculer. C'est le défaut 1, reproduit dans un vrai Chromium: un
           nœud créé, une liste de pics branchée, readout « no plan yet », et
           un clic qui ne change rien — parce que le crible n'avait jamais
           tourné.

           La question utile n'est donc pas « un réglage a-t-il changé ? » mais
           « l'écran montre-t-il des résultats qui correspondent aux réglages ? ».
           Sans plan, il n'y a rien qui corresponde: il y a donc quelque chose
           à faire. */
        if(!this.needsResolve&&this.plan){
            /* Cliquer sur un bouton qui n'a rien à faire ne doit PAS coûter un
               calcul complet — sinon l'utilisateur finit par ne plus croire le
               bouton, et il aura raison. */
            this.renderReadout()
            return Promise.resolve()
        }
        /* Le drapeau et le bouton sont posés par `startResolve` lui-même: c'est
           le seul endroit qui sait qu'un calcul a eu lieu, et il est appelé
           aussi par le graphe. Les poser ici comme avant faisait deux fois le
           même travail et laissait les deux chemins libres de diverger. */
        return this.startResolve().then(()=>this.resolveChildren())
    }

    renderResolveButton(){
        const button=this.resolveButton
        if(!button) return
        /* LE LIBELLÉ SUIT LA MÊME VÉRITÉ QUE LE TEST. Sans plan, le nœud n'a
           rien à jour: il n'a jamais rien calculé. Afficher « up to date » au
           dessus d'un readout « no plan yet » serait un panneau qui se
           contredit lui-même — et c'est le genre de mensonge qui donne envie
           de ne plus cliquer sur rien. */
        const pending=this.needsResolve||!this.plan
        button.textContent=pending
            ?(this.plan?"Resolve":"Resolve (never run)")
            :"up to date"
        button.disabled=!pending
        button.style.opacity=pending?"1":"0.55"
        button.title=pending
            ?`${this.plan
                ?this.staleReason??"settings changed"
                :"nothing has been attributed yet"} — click to attribute`
            :"nothing has changed since the last attribution"
    }

    commitGroups(kind,groups){
        /* ON NE POSE PAS SUR `commitNumber`, et c'est un choix CORRIGÉ.

           J'avais d'abord appelé `commitNumber(kind, groups, …)` en comptant sur
           lui pour valider et relancer. Il fait `Number(raw)` — donc
           `Number([{…},{…}])` vaut `NaN`, la garde `!Number.isFinite` renvoie,
           et la fonction SORT AVANT `setStatus` et `startResolve`.

           Résultat : le tableau affichait la nouvelle valeur, le paramètre la
           prenait, et le crible ne relançait JAMAIS. Un réglage qui change sans
           rien recalculer — exactement le défaut que ce fichier dénonce à
           longueur de chapitre, et que je venais d'introduire en le portant à
           son propre exemple. */
        /* LE « AVANT » EST LA LISTE LUE, et pas le paramètre brut. Une session
           ancienne porte une chaîne; la comparer à la liste normalisée la
           déclarerait toujours différente, et le moindre clic relancerait pour rien. */
        const before=JSON.stringify(this.groupList(kind))
        this.parameters[kind]=groups
        /* LE REDESSIN EST ICI, et pas ailleurs: la case qu'on vient de valider
           doit redevenir la case validée. Sans ça, taper « 40 » dans un champ
           laisserait « 40 » affiché pendant que le plan en compte 20. */
        this.renderGroupTables()
        /* Rien n'a changé: ne pas relancer, comme `commitNumber` le fait. Deux
           saisies qui recalculent le même plan feraient clignoter le nœud pour
           un résultat identique. */
        if(JSON.stringify(this.groupList(kind))===before){
            this.renderReadout()
            return
        }
        /* LE RÉGLAGE NE RECALCULE PLUS: il MARQUE. Le bouton Resolve fait le
           calcul, et le bouton se voit. Voir `markStale`.

           LES DEUX CHAMPS NUMÉRIQUES NE PASSENT PAS PAR ICI. `bestMatches` et
           `ppm` ont leurs propres champs et appellent `commitNumber`, qui les
           applique tout de suite — parce qu'ils reclassent sans recribler. La
           branche qui le disait, et qui vivait ici, était du CODE MORT : elle
           affirmait une règle qu'aucun chemin n'atteignait, et le prochain
           lecteur aurait cru les deux réglages traités par cette fonction. */
        this.markStale(`${kind} changed`)
    }
    /* `field`, ET LES DEUX OPTIONS QUI SERVENT À LA PRÉSENTATION.

       `noSpinner` retire les flèches haut/bas d'un `type=number`. Le
       navigateur n'offre pas d'attribut pour cela: il faut passer par une règle
       CSS qui masque le `-webkit-inner-spin-button`. Elle est posée UNE SEULE
       FOIS dans `setupUI` — la créer ici, à chaque appel, ajouterait un
       `<style>` par champ et par reconstruction de tableau.

       `step` sert au même endroit: un `type=number` sans flèches garde le pas du
       navigateur sur les touches ↑/↓, et une masse saisie par crans de 1 serait
       absurde. Le pas fin rend ces touches utilisables.

       Les deux sont OPTIONNELS et ne changent rien quand on ne les passe pas —
       c'est ce qui permet de garder une seule fonction pour tous les champs. */
    field(content,label,value,{multiline,tag,onCommit,onInput,noSpinner,step}={},help=""){
        const box=CE("div",{className:"an-field"},[])
        const caption=CE("div",{className:"an-caption"},[label])
        const input=CE(multiline?"textarea":"input",{
            ...(multiline?{}:{type:tag??"text"}),
            ...(step?{step}:{}),
            value:String(value),
            spellcheck:false,
            title:help
        },[])
        if(noSpinner) input.classList.add("no-spin")
        stylize(caption,{fontSize:"0.8em",opacity:"0.8"})
        stylize(input,{
            width:"100%",boxSizing:"border-box",fontSize:"0.9em",
            padding:"3px 5px",borderRadius:"3px",
            fontFamily:multiline?"monospace":"inherit",
            ...(multiline?{rows:3,resize:"vertical"}:{})
        })
        if(multiline){
            /* ENTER in a text area inserts a NEWLINE, and that is exactly what
               we want: a list of groups is typed line by line. It is the one key
               that must behave the opposite of the others, and there is
               therefore NOTHING to do to it — no listener for that key.

               BUT THEN, HOW IS A LIST COMMITTED? If no key does it, the list is
               never applied: you type it, you click elsewhere, and the sieve keeps
               running on the old one. A setting you cannot commit is not a
               setting, and the symptom is the worst kind — a field that accepts
               the whole list, looks correct, and does nothing.

               BLUR commits. It is the only event that says "I have finished
               writing" without imposing a key, and — the reason it is the right
               choice here — the only one that does not fire in the middle of
               typing. Ctrl+Enter is offered beside it for the same reason, so
               the list can be validated without leaving the field.

               Both are wired ONLY when the caller passes `onCommit`, so a text
               area that is just a display stays inert. */
            input.addEventListener("input",()=>onInput?.(input.value))
            if(onCommit){
                input.addEventListener("blur",()=>onCommit(input.value))
                input.addEventListener("keydown",(event)=>{
                    if(event.key==="Enter"&&(event.ctrlKey||event.metaKey)){
                        event.preventDefault()
                        onCommit(input.value)
                    }
                })
            }
        }else if(onCommit){
            /* ENTER commits: it applies the setting and re-runs the resolve.
               Every other key does nothing, deliberately — the sieve can produce
               millions of states, so triggering it on each keystroke would be
               ruinous.

               ET LA FLÈCHE DU SPINNER, QUI N'EST PAS UNE FRAPPE.

               Un `input[type=number]` a des flèches haut/bas. Cliquer dessus
               change la valeur sans qu'aucun `keydown` ne parte — mesuré dans un
               vrai Chromium: ni `input`, ni `change`, ni `keydown`. La case
               affichait donc une nouvelle valeur que rien n'appliquait, et il
               fallait deviner qu'Enter existait. C'est un réglage qui a l'air de
               marcher parce qu'il change à l'écran.

               On écoute donc `change`, que la flèche déclenche à chaque cran et
               que le navigateur envoie aussi à la sortie du champ. `input` ne
               suffirait pas: il part à chaque frappe et on relancerait le crible
               à chaque caractère.

               Le même rattrapage vaut pour les CASES DE GROUPE, dont `boundCell`
               valide au blur et sur Enter — la flèche y était muette aussi. */
            input.addEventListener("keydown",(event)=>{
                if(event.key==="Enter"){
                    event.preventDefault()
                    onCommit(input.value)
                }
            })
            input.addEventListener("change",()=>onCommit(input.value))
        }
        box.append(caption,input)
        content.appendChild(box)
        return input
    }

    /* A numeric setting, CHECKED before it is stored, and then APPLIED.

       Le contrôle ne s'arrêtait pas au stockage: Enter écrivait la valeur,
      `renderReadout` repeignait le texte, et rien d'autre. Le nœud restait
       VERT — donc « c'est fait » — alors que ses résultats dataient du réglage
       précédent, et il ne se relisait pas. Changer `ratio` n'avait donc aucun
       effet visible tant qu'on ne lançait pas une resolve à la main: le réglage
       affichait une valeur, le crible en calculait une autre, et rien ne
       signalait l'écart. C'est le pire des deux mondes, exactement celui que le
       commentaire de `syncUI` condemnait.

       LA SUITE EST CELLE DE `FKMDNode`, parce que c'est la convention de la
       maison: Enter commite, et commiter c'est résoudre PUIS descendre. Ni le
       reste du graphe, ni les parents — leurs sorties sont déjà en mémoire et
       les refaire serait du travail que personne n'a demandé.

       `floating` D'ABORD, et l'ordre compte. Le nœud passe en « sale » AVANT de
       résoudre: pendant le calcul il doit avoir l'air de ne plus être à jour,
       sinon on rejoue le défaut qu'on vient de corriger. */
    commitNumber(name,raw,low,high){
        const value=Number(raw)
        if(!Number.isFinite(value)){
            this.renderReadout()
            return
        }
        const bounded=Math.min(high,Math.max(low,value))
        /* Rien n'a changé: ne pas relancer. Le cas est réel — taper 1 puis 1
           dans un champ, ou valider la valeur déjà écrite — et relancer quand
           rien n'a bougé ferait clignoter le nœud pour un résultat identique. */
        if(bounded===this.parameters[name]){
            this.renderReadout()
            return
        }
        this.parameters[name]=bounded
        /* `this.fieldFor(name)` et NON `this[fieldFor(name)]`. L'appel était
           écrit sans le `this.`, donc il cherchait une variable globale — et
           `Uncaught ReferenceError: fieldFor is not defined` tuait la fonction
           avant `setStatus`, donc AVANT le `startResolve`. Le champ se
           VALIDAIT et le nœud ne relançait rien.

           C'est exactement le genre de faute qui ne se voit pas dans les
           tests: ils vérifient que le nom du réglage est le même des deux
           côtés, pas que la touche Enter fait recalculer. */
        const input=this.fieldFor(name)
        if(input) input.value=String(bounded)
        /* DEUX RÉGLAGES S'APPLIQUENT TOUT DE SUITE, ET CE SONT LES DEUX
           CHAMPS NUMÉRIQUES.

           `bestMatches` et `ppm` ne changent pas la liste que le crible
           énumère: ils reclassent ce qu'il a DÉJÀ rendu. Recribler pour eux
           serait du travail payé pour un résultat identique — et l'inverse, les
           mettre dans la file du bouton, donnait exactement le défaut signalé:
           taper 1 dans « Best matches » ne changeait rien à l'affichage, et il
           fallait découvrir qu'un bouton Resolve existait pour le voir.

           Cette règle ÉTAIT écrite, mais dans `commitGroups` — que ces deux
           champs n'appellent jamais. Elle était donc du code mort: l'intention
           existait, l'exécution non. Elle vit maintenant ici, où elle s'exécute.

           `floating` D'ABORD, et l'ordre compte: pendant le calcul, le nœud doit
           avoir l'air de ne plus être à jour. */
        this.setStatus("floating")
        if(name==="bestMatches"||name==="ppm"){
            return this.startResolve().then(()=>this.resolveChildren())
        }
        this.markStale(`${name} changed`)
    }
    /* Le champ d'un réglage, pour que la valeur BORNÉE soit réécrite à l'écran.

       Sans cela, taper 500 dans un champ borné à 20 affichait 500 et calculait
       20: deux nombres différents pour un seul réglage, et c'est le second
       qui sert. Le nom du champ est dérivé du nom du paramètre, donc les deux
       listes ne peuvent pas diverger sur une règle écrite deux fois. */
    fieldFor(name){
        const camel=name.charAt(0).toUpperCase()+name.slice(1)
        return this[`${camel}Input`]??null
    }
    /* Les DEUX LISTES, commitées ensemble, et pour la même raison que les
       nombres: sans re-résolve, le champ montre une liste et le crible en
       calcule une autre.

       La comparaison se fait sur le texte ÉCRIT, pas sur la liste lue: deux
       listes différentes peuvent donner le même plan — `"CH2 "` et `"CH2"` se
       lisent pareil — et relancer sur une différence qui n'en est pas une
       ferait clignoter le nœud sans rien changer. */
    /* THE READOUT: what the node understood, and what it found.

       The first lines say what the plan IS — how many bricks, how many adducts,
       which windows — because a silent sieve is a sieve nobody can debug. The
       next ones say what it PRODUCED, and the diagnostics are there so that a
       refused adduct does not vanish without anyone learning why. */
    renderReadout(){
        if(!this.readout) return
        const lines=[]
        if(this.origin?.tableError&&!this.loadedTable){
            lines.push(`table unavailable: ${this.origin.tableError}`)
        }else if(this.plan){
            lines.push(
                `${this.plan.combinables.length} combinable masses, ${this.plan.ionisers.length} adducts`,
                `ratio ${this.plan.ratio}, charge |z| in [${this.plan.chargeMin}, ${this.plan.chargeMax}]`
            )
        }else{
            lines.push("no plan yet")
        }
        for(const line of this.diagnostics??[]) lines.push(line)
        for(const line of this.kernelErrors??[]) lines.push(`kernel: ${line}`)
        if(this.skippedInputs) lines.push(`${this.skippedInputs} input(s) skipped: not an XY wave`)
        /* L'ATTRIBUTION, une ligne par entrée. Le nœud produit « une liste
           d'attributions par entrée », donc le compteur est PAR ENTRÉE et jamais
           un total: un total laisserait croire qu'un seul spectre a été traité
           alors qu'il y en a trois. */
        for(const [index,result] of (this.attributions??[]).entries()){
            const parts=[`${result.entries.length} readings`]
            /* « N sur M dans la fenêtre » n'a plus de sens depuis la sélection:
               le seuil en ppm filtre AVANT le classement, donc tout ce qui est
               publié EST dans la fenêtre, et le dire répéterait la même chose
               deux fois. Ce qui est utile, c'est l'autre côté: combien de pics
               sont couverts, et combien n'ont rien reçu.

               C'est le seul endroit où un pic sans explication se voit. Il ne se
               voit pas dans la liste — une absence ne s'affiche pas toute seule —
               alors que c'est précisément l'information qui manque quand on
               cherche pourquoi un pic reste inexpliqué. */
            if(result.keptMatches!==null&&result.keptMatches!==undefined){
                parts.push(`up to ${result.keptMatches}/peak`)
                const covered=result.candidates??0
                const total=result.pointCount??covered
                if(covered<total) parts.push(`${total-covered} peak(s) unexplained in ${this.parameters.ppm} ppm`)
            }
            if(result.truncated) parts.push("TRUNCATED — this is a prefix, not the whole space")
            lines.push(`input ${index+1}: ${parts.join(", ")}`)
        }
        this.readout.textContent=lines.join("\n")
    }

    async renderAll(){
        /* LA TABLE EST ATTENDUE ICI, ET C'EST LE SEUL ENDROIT DU NŒUD OÙ ÇA
           COMPTE.

           Ce nœud est une calculette autant qu'un lecteur de spectres: taper une
           masse et lire une formule doit suffire, sans entrée, sans Resolve. Or la
           table arrive en arrière-plan, et rien ne l'attendait au démarrage — donc
           les blocs isotopiques étaient vides et la sonde muette jusqu'au premier
           resolve, alors que le nœud était prêt depuis le début.

           On attend donc la table ICI, parce que `renderAll` est appelé au montage
           comme après chaque resolve: c'est le seul moment où les deux ont lieu, et
           donc le seul où les remettre à jour ne coûte rien.

           L'attente est silencieuse en cas d'échec: le plan se construira sans table,
           les cadres resteront visibles, et la sonde dira pourquoi elle ne répond
           pas. Un nœud qui refuse de s'afficher parce qu'un fichier manque serait
           pire qu'un nœud qui s'affiche et l'explique. */
        await this.table()
        this.buildPlan()
        /* LES TABLEAUX ET LA SONDE, ICI ET PAS SEULEMENT AU RESOLVE.

           Le plan vient d'être rebâti sur la table enfin disponible: les blocs
           isotopiques sous chaque groupe, et la réponse de la sonde, sont donc
           à jour. Sans ces deux lignes, un nœud posé depuis une session attendait
           le premier clic pour se remplir — alors qu'il était prêt. */
        this.renderGroupTables()
        this.armProbe()
        this.renderReadout()
        /* LE BOUTON EST REPEINT ICI, ET C'EST LA SEULE FIN DE RESOLVE.

           `startResolve` repeint le bouton tout de suite, pour annoncer le
           calcul — mais à cet instant `this.plan` est encore celui d'avant, donc
           un nœud qui calcule pour la première fois s'affichait « Resolve
           (never run) » AU-DESSUS d'un readout plein de 220 lectures. Le
           libellé et le texte se contredisaient.

           Le plan existe maintenant: `renderResolveButton` peut donc lire la
           vérité et poser « up to date ». C'est le seul endroit où les deux
           sont connus en même temps, donc c'est ici que le bouton se repeint. */
        this.renderResolveButton()
    }

    /* The STATE, for a session.

       The TWO LISTS as text and the FIVE settings. Nothing else: the plan, the
       attributions and the table are all DERIVED, so keeping them would mean a
       reload showing results computed from settings that may have changed since.
       Only the INTENTIONS travel. */
    serializeState(){
        /* Les listes sont ÉCRITES sous leur forme lue, donc une session
           enregistrée contient déjà les bornes. Une session plus ancienne, elle,
           portait une chaîne — et elle reste relisible: `restoreState` la passe
           par `groupList`, qui sait lire les deux. On n'écrit pas la forme
           normalisée ici, parce qu'on n'a pas à le faire pour que la session
           marche: `readGroups` lit les deux, et c'est lui qui décide.

           Ce qui PART, c'est l'intention. Le plan, les attributions et la table
           sont dérivés, donc les garder montrerait des résultats calculés avec
           des réglages qui ont pu changer depuis. */
        return {
            combining:this.groupList("combining"),
            ionising:this.groupList("ionising"),
            ratio:this.parameters.ratio,
            chargeMin:this.parameters.chargeMin,
            chargeMax:this.parameters.chargeMax,
            bestMatches:this.parameters.bestMatches,
            ppm:this.parameters.ppm,
            probeMass:this.parameters.probeMass,
            /* LES TROIS RÉGLAGES DU RÉSEAU, et eux seuls.

               Les ARBRES ne sont pas enregistrés, pour la même raison que les
               attributions: ils sont dérivés des réglages et des vagues
               d'entrée. Les garder montrerait un réseau calculé sur des
               réglages qui ont pu changer depuis — et le panneau droit
               afficherait un arbre mort, que rien dans la session ne
               reproduirait. Ce qui PART, c'est l'intention. */
            forestTolerance:this.parameters.forestTolerance,
            forestDegreeMax:this.parameters.forestDegreeMax,
            forestCharge:this.parameters.forestCharge,
            /* LA LISTE DE LIAISON PART ELLE AUSSI, et c'est la seule partie du
               panneau qui soit une LISTE comme celle de gauche: une session
               rechargée sans elle perdrait les groupes qu'on avait choisis de
               lier, et le réseau retomberait sur CH2 seul sans rien le dire. */
            forestGroups:this.forestGroupList(),
            /* SÉLECTION ET FILTRE DU RÉSEAU (persistés pour la session). */
            forestSelected:Array.from(this.forestSelected),
            forestMinSize:this.forestMinSize
        }
    }

    restoreState(state){
        if(!state) return
        for(const name of ["combining","ionising","ratio","chargeMin","chargeMax","bestMatches","ppm","probeMass",
            "forestTolerance","forestDegreeMax","forestCharge","forestGroups",
            "forestSelected","forestMinSize"]){
            if(state[name]!==undefined&&state[name]!==null){
                this.parameters[name]=state[name]
            }
        }
        /* LES LISTES PASSENT PAR `groupList`, et c'est la migration.

           Une session d'avant les bornes porte `"CH2\nNH"`; celle d'aujourd'hui
           porte des objets. Les deux sont réécrites ici sous la forme courante,
           donc TOUT ce qui relit le nœud ensuite — le tableau, `buildPlan`, le
           diagnostic — ne voit qu'une seule forme. C'est le seul endroit où il
           faut traiter les deux, et il faut le faire: le faire partout, c'est
           mettre la migration à chaque lecteur. */
        this.parameters.combining=this.groupList("combining")
        this.parameters.ionising=this.groupList("ionising")
        /* A session saved before the rename carries `limit`, and the two are not
           the same setting: `limit` counted enumerated states, `bestMatches`
           counts readings per peak. Copying the number across would be a LIE —
           `limit:2000` restored as `bestMatches:2000` would ask for two thousand
           readings of every single peak, which is not what that session meant.

           So the old value is dropped, not translated, and the new default
           applies. The user loses a number they can hardly have meant, and gets a
           setting that behaves the way its name says. Nothing is guessed. */
        if(Array.isArray(state.forestSelected)){
            this.forestSelected=new Set(state.forestSelected)
        }
        if(Number.isFinite(state.forestMinSize)){
            this.forestMinSize=state.forestMinSize
        }
        if(state.forestLayoutMode){
            this.forestLayoutMode=state.forestLayoutMode
        }
        this.syncUI()
    }

    /* The fields follow the restored state. Without this, a reload would show
       settings different from the ones APPLIED, and the sieve would compute
       with the first while the screen shows the second — the worst of the two,
       because the reader sees one value and gets another. */
    syncUI(){
        /* Les deux champs de SAISIE sont vides par construction — ils ajoutent une
           ligne et ne décrivent pas la liste — donc il n'y a rien à y remettre.
           Les LISTES, elles, vivent dans le tableau, et c'est lui qu'il faut
           redessiner: une session relue avec trois groupes doit les montrer. */
        this.renderGroupTables()
        if(this.massInput&&this.parameters.probeMass!==undefined){
            this.massInput.value=String(this.parameters.probeMass)
        }
        /* Les CHAMPS NUMÉRIQUES AUSSI, et c'est la moitié du panneau.

           La fonction ne les touchait pas, alors que son commentaire affirmait le
           contraire: après un rechargement, les deux listes retrouvaient leur
           contenu et les cinq nombres restaient ceux de la CONSTRUCTEUR. Le
           crible tournait donc avec les réglages restaurés pendant que
           l'écran affichait les valeurs par défaut — un nœud dont l'affichage
           et le calcul sont réglés différemment, sans rien qui le dise.

           On écrit dans chaque champ la valeur du paramètre, jamais
           l'inverse: un champ vide ou illisible ne doit pas effacer un réglage
           restauré. */
        const numeric={
            /* Les deux champs de charge sont PARTIS: la ligne « Reachable
               charge(s) » les remplace, et elle est dérivée. Il n'y a donc plus
               rien à y écrire. */
            bestMatchesInput:"bestMatches",
            ppmInput:"ppm",
            /* LES CHAMPS DU RÉSEAU SUIVENT, et pour la même raison que les
               autres: sans cette ligne, une session rechargée afficherait les
               valeurs de la CONSTRUCTEUR pendant que le réseau se calculerait
               avec les valeurs restaurées — un panneau qui ment sur ce qu'il
               va faire. */
            forestToleranceInput:"forestTolerance",
            forestDegreeMaxInput:"forestDegreeMax",
            forestChargeInput:"forestCharge"
        }
        for(const [field,key] of Object.entries(numeric)){
            const input=this[field]
            if(input) input.value=this.parameters[key]
        }
        /* CHAMPS DU PANNEAU RÉSEAU (sélection/filtre). */
        if(this.forestMinSizeInput) this.forestMinSizeInput.value=String(this.forestMinSize)
    }

    registered(e){
        if(e.detail.msg.caster!==this||this.accordion) return
        super.registered(e)
        /* LE PANNEAU DU RÉSEAU, À DROITE, et pas dans le panneau de gauche.

           Le nœud d'attribution a déjà deux listes, cinq nombres, une sonde et
           un readout — son panneau de gauche est plein. Le réseau est une
           LECTURE, pas un réglage de plus, et une lecture qui entasse ses
           composants sous les listes oblige à faire défiler le panneau pour
           passer des réglages à des résultats. Deux colonnes, comme le lecteur
           de collections: une liste à gauche, son détail à droite.

           Le panneau est donc un ACCORDÉON À PART ENTIÈRE, comme celui de
           FormulaCollectionNode — pas un sous-panneau, parce qu'un sous-panneau
           ne peut pas être replié tout seul, et qu'un réseau de plusieurs
           centaines de composants n'a rien à faire dans une colonne de réglages. */
        const {channel,registrationName,label}=e.detail.msg
        this.forestAccordion=new Accordion(
            `${label} (network)`,
            this.origin,
            this.origin.main.querySelector(".vertical.right.content")
        )
        channel.register(`${registrationName}:network`,this.forestAccordion,`${label} (network)`)
        this.setupForestGraphDialog(channel,registrationName,label)
        this.setupForestPanel()
        this.setupUI()
        /* NO resolve is triggered here: the node may have no input yet, and a
           resolve that finds no wave would publish an empty output. The
           settings are restored — the reader sees their values — and the
           attributions come on the first resolve, once something is connected.
           That is FKMDNode's shape. */
        this.syncUI()
        this.renderReadout()
    }
    suicide(options={}){
        /* LE PANNEAU DU RÉSEAU EST TUÉ AVEC LE NŒUD.

           `NodeWithAccordion.suicide` ne tue que le panneau gauche: sans cette
           ligne, un nœud supprimé laisserait son panneau de réseau à l'écran,
           avec des résultats qui plus rien ne produit. */
        this.forestAccordion?.suicide()
        this.forestAccordion=null
        /* LA FENÊTRE CENTRALE SUIT LE NŒUD. Sans cette ligne, un nœud
           supprimé laisserait au centre une fenêtre qui montre un réseau devenu
           muet, et que plus rien ne repeint. */
        this.forestDialog?.suicide()
        this.forestDialog=null
        super.suicide(options)
    }

    /* ------------------------------------------------------------------
       LE RÉSEAU DE MESURES — les trois temps, dans l'ordre d'Igor.
       ------------------------------------------------------------------ */

    /* TEMPS 1 — LE PLAN: la liste des références.

       C'est l'équivalent de `formatStds`, qui assemblait dans `Stds_Obs` les
       masses théoriques des formules cochées avant de lancer quoi que ce soit.
       Ici la liste vient du plan, donc elle est TOUJOURS cohérente avec ce qui
       est écrit dans les tableaux de gauche — et c'est le but: un réseau
       calculé sur une autre liste que celle affichée serait un mensonge
       silencieux.

       La charge est celle du plan sauf si l'utilisateur en a choisi une: 0
       signifie « celle du plan », parce que taper 1 dans une case quand le plan
       dit 1+ serait une redite qui peut mentir dès que le plan change. */
/* LES GRAPHS DU RÉSEAU — ILS SONT DÉRIVÉS DES COMPOSANTS, JAMAIS RECALCULÉS.

       `forestComponents` a déjà lu les mêmes tableaux que la liste de groupes, et
       a déjà rangé les liens par composant. Refaire ce travail ici produirait un
       second jeu de nombres, et les deux divergeraient au premier changement de
       coupure — la liste dirait 6 pics et le graphique en montrerait 5, sans
       qu'aucun des deux soit faux tout seul.

       LES MASSES SONT INDEXÉES COMME LE NOYAU, DONC DANS L'ORDRE TRIÉ DES PICS.
       C'est cet ordre que portent `u` et `v`, et c'est un piège: les masses dans
       l'ordre d'arrivée donneraient des sommets aux masses fausses, et le
       graphique serait aberrant sans que rien ne le signale. */
}
for(const name of Object.getOwnPropertyNames(AttributionForestMethods.prototype)){
    if(name==="constructor") continue
    Object.defineProperty(
        AttributionNode.prototype,
        name,
        Object.getOwnPropertyDescriptor(AttributionForestMethods.prototype,name)
    )
}
for(const name of Object.getOwnPropertyNames(AttributionForestMethods)){
    if(["length","name","prototype"].includes(name)) continue
    Object.defineProperty(
        AttributionNode,
        name,
        Object.getOwnPropertyDescriptor(AttributionForestMethods,name)
    )
}

