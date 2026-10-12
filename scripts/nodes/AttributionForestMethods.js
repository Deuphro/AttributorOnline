import {CE,stylize} from "../util.js"
import * as d3 from "https://cdn.jsdelivr.net/npm/d3@7/+esm"
import {Accordion} from "../ui/Accordion.js"
import {Dialog} from "../ui/Dialog.js"
import {Plot2DWebGL} from "../ui/Plot2DWebGL.js"
import {Wave,XYTrace} from "../formats.js"
import {Formula,FormulaCollection,positiveMassConjugate} from "../chemistry.js"
import {computePool} from "../workerPool.js"
import {buildPlan,attributeSpectrum,SortedPoints,stateToFormula,propagateForest} from "../attribution.js"
import {forestStandards,forestComponents,componentLine,growForest,suggestWeightCut,forestGraph,forestRoot,forestCompositionDiff,forestDiffIsEmpty,forestDiffNotation,forestFindBrick,forestMergeGraphs,layoutForests,createAnimatedLayout,advanceLayout,finalizeAnimatedLayout,applyGridLayout,linkableBrick,DEFAULT_LINK_TOLERANCE,FOREST_LAYOUT_DEFAULTS} from "../forest.js"
import {windowFor} from "../utils/index.js"
import {prettyNotation} from "./formulaCollectionHelpers.js"

/* LE COMPTEUR DES `datalist`, et il ne sert qu'à DONNER UN NOM À CHAQUE NŒUD.
   Un `id` HTML est global au document: deux panneaux d'attribution ouverts côte
   à côte ne peuvent pas partager celui de leur liste de briques, sinon le
   navigateur rattacherait les deux champs au même `datalist` — celui du premier
   nœud — et les propositions de l'un s'afficheraient dans l'autre. Un simple
   compteur suffit; il n'a pas besoin d'être stable, seulement unique. */
let forestBrickListSerial=0

export class AttributionForestMethods{
    /* LE MERGE, ET C'EST UNE OPÉRATION PUREMENT JS.
       « Grow network » (le noyau) ne sait pas qu'on a fusionné: le graphe
       mergé vit dans `forestMerges` (clé = rank du plus grand arbre) et se
       substitue à ses sources dans `buildForestGraphs`, le layout, la
       propagation et la liste. Recliquer « Grow network » régénère l'état
       brut: rien du merge n'est persisté côté noyau, et c'est voulu. */
    forestMergedGraphs(baseGraphs){
        const merges=this.forestMerges
        if(!(merges?.size)||!Array.isArray(baseGraphs)) return baseGraphs
        const byRank=new Map(baseGraphs.map(g=>[g.rank,g]))
        /* L'ENTRÉE EST LA PROVENANCE, ET NON LA CLÉ DE LA MAP.

           La map est indexée par le rang du plus grand arbre, donc deux fusions
           en chaîne écrivent la MÊME clé: la seconde remplaçait la première, et
           l'historique des arbres absorbés disparaissait avec. On ne cherche donc
           plus « la fusion de ce rang », mais « la fusion à laquelle ce rang
           appartient » — ce qui tient même quand les clés se recouvrent. */
        const absorbing=new Map()
        for(const merged of merges.values()){
            for(const rank of merged?.mergedFrom??[]){
                if(!absorbing.has(rank)) absorbing.set(rank,merged)
            }
        }
        const consumed=new Set()
        const out=[]
        for(const graph of baseGraphs){
            if(consumed.has(graph.rank)) continue
            const merged=absorbing.get(graph.rank)
            if(merged&&merged.mergedFrom?.every(rank=>byRank.has(rank))){
                for(const rank of merged.mergedFrom) consumed.add(rank)
                out.push(merged)
            }else{
                out.push(graph)
            }
        }
        return out
    }
    /* LES BRIQUES DE LIAISON, DANS L'ORDRE OÙ LA PROPAGATION LES INDEXE.

       `link.standard` n'est pas un identifiant de brique: c'est un RANG dans la
       liste des références, et `propagateForest` lit `references[link.standard]`
       où `references` est filtrée par `linkableBrick` (voir
       `attributeTree`). C'est donc CETTE liste — et elle seule — qui donne la
       signification d'un rang. Toute écriture de `link.standard` passe par ici.

    LE FILTRE EST `linkableBrick`: seules les masses strictement positives
    sont transmises au crible, dont les écarts sont croissants. Les saisies
    négatives sont déjà conjuguées par le lecteur de formules partagé. */
    forestLinkBricks(){
        return((this.forestLinkPlan?.items??[]).filter(linkableBrick))
    }
    /* FUSIONNE LES ARBRES DESSINÉS, DU PLUS GRAND AU PLUS PETIT.
       Chaque maillon relie deux racines successives par leur différence
       stoichiométrique. Si le diff ne correspond à aucune brique du plan de
       liaison, la brique est AJOUTÉE (groupes forêt + plan rafraîchis), puis
       la propagation déroule depuis la grande racine avec la mécanique
       existante (`attributeTree` → `propagateForest`). Rend null si tout va
       bien, sinon un message d'erreur pour le readout. */
    async mergeSelectedForests(){
        const batch=this.forestGraphs?.[0]
        if(!batch?.graphs?.length) return "no network yet — press Grow network"
        if(!this.loadedTable) await this.table()
        if(!this.loadedTable) return "no periodic table yet"
        const drawn=batch.graphs
            .filter(g=>this.forestSelected.has(g.rank))
            .sort((a,b)=>(b.size??b.vertices.length)-(a.size??a.vertices.length))
        if(drawn.length<2) return "select at least two trees to merge"
        const attributions=[]
        for(const graph of drawn){
            const attribution=await this.attributeTree(graph)
            if(!attribution) return `tree #${graph.rank} has no attribution yet`
            const rootRow=attribution.rows.find(row=>row.index===graph.rootIndex)
            if(!rootRow?.formula) return `tree #${graph.rank} has no root formula yet`
            attributions.push({graph,rootFormula:rootRow.formula})
        }
        const links=[]
        for(let i=0;i<attributions.length-1;i++){
            /* LE SENS EST DÉCIDÉ PAR LA MASSE, ET PAR L'INDICE DU SOMMET.

               `propagateForest` applique la brique DE `u` VERS `v`
               (`mergeComposition(…, isU?1:-1)`), donc la brique doit être, très
               exactement, `v − u`. Les deux se valent en masse, et l'ordre des
               deux racines était jusqu'ici déduit de la TAILLE de l'arbre — un
               arbre de 200 pics peut avoir la racine la plus légère. La brique
               était alors la différence dans un sens, et appliquée dans
               l'autre: le lien produisait une formule qui n'était ni l'un ni
               l'autre.

               C'est aussi ce qui rend le poids honnête: il se calcule sur
               l'écart signé `m(v) − m(u)`, comparé à une masse de référence
               elle-même signée. Avec une brique en magnitudes et un écart en
               valeur absolue, les deux erreurs se compensaient parfois et se
               cumulaient d'autres fois — 60 Da d'écart sur une substitution,
               mesuré. */
            const pair=[attributions[i],attributions[i+1]]
                .sort((a,b)=>a.graph.rootIndex-b.graph.rootIndex)
            const low=pair[0]
            const high=pair[1]
            const rawDiff=forestCompositionDiff(
                high.rootFormula.composition,low.rootFormula.composition)
            let diffMass=0
            for(const [element,byA] of rawDiff)
                for(const [A,count] of byA) diffMass+=element.isotope(A).mass*count
            const conjugated=diffMass<0
            const diff=positiveMassConjugate(rawDiff)
            const lowRoot=low.graph.vertices.find(v=>v.index===low.graph.rootIndex)
            const highRoot=high.graph.vertices.find(v=>v.index===high.graph.rootIndex)
            if(forestDiffIsEmpty(diff)){
                links.push({u:low.graph.rootIndex,v:high.graph.rootIndex,
                    weight:0,standard:-1,label:"="})
                continue
            }
            const items=()=>((this.forestLinkPlan?.items??[]).filter(linkableBrick))
            let standard=forestFindBrick(items(),diff)
            let label=null
            if(standard<0){
                /* LA BRIQUE EST LA DIFFÉRENCE SIGNÉE, et non la somme de ses
                   MAGNITUDES. Les magnitudes perdaient deux choses: les signes,
                   donc l'affichage devenait l'inverse de la différence; et la
                   masse, donc le poids du lien sortait faux. `-C-H+N-O` devenait
                   `CHNO`, pesant 43 Da, alors que la différence réelle pesait
                   −15: l'écart valait 58 Da de pure erreur de modèle. */
                const notation=forestDiffNotation(diff)
                const current=this.readGroups(this.parameters.forestGroups,"combining")
                this.parameters.forestGroups=[...current,{group:notation,min:0,max:1,ratio:1}]
                this.refreshForestPlan()
                standard=forestFindBrick(items(),diff)
                if(standard<0){
                    return `cannot link #${low.graph.rank} to #${high.graph.rank}: `
                        +`${notation} matches nothing, even added`
                }
                label=items()[standard]?.notation??notation
            }else{
                label=items()[standard]?.notation??null
            }
            const refMass=(this.forestPlan?.masses??[])[standard]??0
            /* Le crible ne voit que l'écart POSITIF et une référence positive. */
            const gap=Math.abs((highRoot?.mass??0)-(lowRoot?.mass??0))
            const weight=Number.isFinite(refMass)?Math.abs(gap-refMass):0
            const u=conjugated?high.graph.rootIndex:low.graph.rootIndex
            const v=conjugated?low.graph.rootIndex:high.graph.rootIndex
            links.push({u,v,weight,standard,label})
        }
        const merged=forestMergeGraphs(drawn,links)
        if(!merged) return "merge produced nothing"
        if(!this.forestMerges) this.forestMerges=new Map()
        this.forestMerges.set(merged.rank,merged)
        this.forestSelected.clear()
        this.forestSelected.add(merged.rank)
        this.forestAttributions?.byGraph?.delete(merged)
        for(const {graph} of attributions){
            this.forestAttributions?.byGraph?.delete(graph)
        }
        this.forestLayoutOf=null
        this.renderForest()
        await this.publishForestCollections()
        return null
    }
    buildForestGraphs(){
        /* LE REBÂTIMENT EST MÉMOÏSÉ SUR LES COMPOSANTS, ET SUR EUUX SEULEMENT.
           `forestGraph` ne lit que `forestComponents`; le reconstruire à chaque
           rendu produirait des sommets — et une identité — NEUFS alors que rien
           n'a bougé, ce qui invaliderait la mise en page en dessous sans raison.
           Les composants ne sont réécrits qu'au résultat d'un « Grow network »:
           leur identité est exactement la bonne clé. */
        const merges = this.forestMerges
        /* LE REBÂTIMENT EST MÉMOÏSÉ SUR LES COMPOSANTS; la casse est le merge :
           la fusion se signe dans `forestMerges`, pas dans les composants, et
           l'ancien cache prête la liste à sa ancienne incarnation. */
        const source=this.forestComponents??[]
        if(this.forestGraphsOf===source&&Array.isArray(this.forestGraphs)
            &&(!merges||!merges.size)) return this.forestGraphs
        this.forestGraphsOf=source
        this.forestGraphs=[]
        for(const batch of source){
            if(!batch) continue
            /* `points.order` est le tri: `points.x[order[i]]` est la i-ème masse
               par ordre croissant, et c'est ce rang que le noyau numérote. */
            const points=batch.points
            const masses=points?Array.from(points.order.map(index=>points.x[index])):[]
            const intensities=points?Array.from(points.order.map(index=>points.y[index])):[]
            this.forestGraphs.push({
                title:batch.title??"attribution",
                points,
                graphs:this.forestMergedGraphs(forestGraph(batch.components??[],{masses,intensities}))
            })
        }
        return this.forestGraphs
    }
    /* L'ATTRIBUTION D'UN ARBRE, ET ELLE EST PARESSEUSE.
       La racine est sondée avec le plan de GAUCHE — `attributeSpectrum` sur
       ±0,5 Da, exactement comme le Probe — puis `propagateForest` déroule les
       formules le long des liens avec les compositions du plan de DROITE
       (`forestLinkPlan`, même ordre que `link.standard`).
       Le cache est clé sur l'identité des deux plans plus les réglages de
       lecture: changer un groupe invalide, changer la sélection ne touche à
       rien. La table partagée du plan voyage avec les formules — jamais une
       copie, sinon la session porterait un tableau périodique par formule. */
    async attributeTree(graph){
        if(!graph||!Number.isInteger(graph.rootIndex)) return null
        if(!this.loadedTable) await this.table()
        if(!this.loadedTable) return null
        const plan=this.buildPlan()
        const linkPlan=this.forestLinkPlan
        const ppm=Number(this.parameters.ppm)>0?Number(this.parameters.ppm):10
        const bestMatches=Math.max(1,Math.trunc(Number(this.parameters.bestMatches))||3)
        /* CLÉ DE CONTENU, PAS D'IDENTITÉ — ET UN CACHE PAR ARBRE.

           `buildPlan()` RECONSTRUIT `this.plan` à chaque appel, donc la
           comparaison d'identité précédente ne pouvait jamais être vraie: le
           crible repartait de zéro à chaque visite, et un seul emplacement
           ne servait qu'au dernier arbre visité. Ce sont les RÉGLAGES qui
           décident du résultat — groupes, ratios, charges, plan de liaison,
           fenêtre, profondeur, table — donc c'est eux qu'on compare, dans un
           `Map` indexé par graphe: changer la sélection ne recalcule RIEN,
           changer un groupe recalcule TOUT, une fois. */
        const key={
            combining:JSON.stringify(this.parameters.combining??null),
            ionising:JSON.stringify(this.parameters.ionising??null),
            ratio:Number(this.parameters.ratio),
            chargeMin:Number(this.parameters.chargeMin),
            chargeMax:Number(this.parameters.chargeMax),
            linkPlan,ppm,bestMatches,table:this.loadedTable
        }
        const cached=this.forestAttributions
        const same=cached&&cached.key
            &&cached.key.combining===key.combining
            &&cached.key.ionising===key.ionising
            &&cached.key.ratio===key.ratio
            &&cached.key.chargeMin===key.chargeMin
            &&cached.key.chargeMax===key.chargeMax
            &&cached.key.linkPlan===key.linkPlan
            &&cached.key.ppm===key.ppm
            &&cached.key.bestMatches===key.bestMatches
            &&cached.key.table===key.table
        if(!same) this.forestAttributions={key,byGraph:new Map()}
        const byGraph=this.forestAttributions.byGraph
        if(byGraph.has(graph)) return byGraph.get(graph)
        const rootVertex=graph.vertices.find(vertex=>vertex.index===graph.rootIndex)
        if(!rootVertex||!Number.isFinite(rootVertex.mass)) return null
        let probed
        try{
            probed=attributeSpectrum(plan,windowFor(rootVertex.mass),{
                limit:Infinity,ppm,bestMatches
            })
        }catch{
            return null
        }
        const centre=(probed.entries??[])
            .filter(entry=>entry.target?.index===1)
            .sort((a,b)=>Math.abs(a.errorPpm)-Math.abs(b.errorPpm))
        if(!centre.length) return null
        const rootFormula=centre[0].formula
        if(!rootFormula) return null
        const references=(linkPlan?.items??[])
            .filter(linkableBrick)
            .map(item=>({composition:item.composition??null}))
        const result=propagateForest(graph,rootFormula,references,{
            table:this.loadedTable
        })
        if(!result) return null
        byGraph.set(graph,result)
        return result
    }


/* LA MISE EN PLACE, CALCULÉE UNE FOIS PAR RÉSEAU.

   Elle vient de `forest.js` et ne dépend que du graphe: elle n'est donc PAS
   dans le rendu. Un moteur de force recalculé à chaque image donnerait deux
   réseaux différents pour un même « Grow network », et la comparaison d'un
   run à l'autre — le seul usage de ce graphique — deviendrait impossible.

   AFFICHE SEULEMENT LES ARBRES SÉLECTIONNÉS, côte à côte en force-directed.
   Supporte deux modes: statique (layoutForests complet) ou animé (requestAnimationFrame). */
forestOverviewLayout({animate=false}={}){
        const box=this.forestPlotBox
        if(!box) return null
        const batch=this.forestGraphs?.[0]
        if(!batch?.graphs?.length) return null
        const width=Math.max(240,Math.round(box.clientWidth||600))
        const height=Math.max(160,Math.round(box.clientHeight||this.forestPlotHeight||260))
        /* FILTRER LES GRAPHES SÉLECTIONNÉS. */
        const selectedGraphs=batch.graphs.filter(g=>this.forestSelected.has(g.rank))
        if(!selectedGraphs.length) return null
        /* CLÉ DE CACHE: batch + rangs sélectionnés + taille boîte + mode animé.
           `filter` crée un tableau NEUF à chaque appel, donc comparer des
           tableaux par `===` manque toujours — la clé retient le batch (stable
           tant que « Grow network » n'a pas retournée) et la signature des
           rangs, pas le tableau filtré. */
        const ranks=selectedGraphs.map(g=>g.rank).join(",")
        /* Les réglages FR font partie de la clé: changer `FOREST_LAYOUT_DEFAULTS`
           sans invalider redessinerait l'ancien layout figé. */
        const tune=this.forestTune??FOREST_LAYOUT_DEFAULTS
        const tuneKey=[tune.iterations,tune.ideal,tune.repulsion,tune.restBase,tune.restSpan,tune.gravity,tune.tempStart,tune.tempEnd,tune.fac,tune.viscosity,tune.springExponent,tune.massForce,tune.defectForce,tune.errorForce,tune.depthForce].join(",")
        const cacheKey={batch,width,height,ranks,animate,tune:tuneKey}
        const cached=this.forestLayoutOf
        if(cached&&cached.key.batch===cacheKey.batch
            &&cached.key.ranks===cacheKey.ranks
            &&cached.key.width===cacheKey.width
            &&cached.key.height===cacheKey.height
            &&cached.key.animate===cacheKey.animate
            &&cached.key.tune===cacheKey.tune){
            return cached.layout
        }
        if(animate){
            /* MODE ANIMÉ, SANS REDÉMARRAGE (option A): les états existants sont
               réutilisés par rang — un arbre déjà stabilisé garde ses positions
               et son momentum, seul un rang NOUVEAU repart du cercle. Un batch
               ou un réglage FR neuf invalide tout: comparer des layouts issus
               de deux calculs différents serait mentir. */
            const previous=this.forestLayoutOf?.layout?.animatedStates
            const previousByRank=new Map()
            if(Array.isArray(previous)
                &&this.forestLayoutOf?.key?.batch===batch
                &&this.forestLayoutOf?.key?.tune===tuneKey){
                for(const state of previous){
                    if(state?.graph && Number.isInteger(state.graph.rank)) previousByRank.set(state.graph.rank,state)
                }
            }
            /* On repart du layout courant pour que les arbres déjà affichés
               gardent leurs positions le temps que le nouveau converge. */
            const animatedStates=selectedGraphs.map(graph=>{
                const kept=previousByRank.get(graph.rank)
                if(kept) return kept
                return createAnimatedLayout(graph,tune)
            })
            /* Finalise chaque état initial et applique la grille pour le premier rendu. */
            const placed=animatedStates.map(finalizeAnimatedLayout)
            const gridded=applyGridLayout(placed,{width,height})
            const layout={
                width,height,
                groups:gridded.groups,
                animatedStates,
                animating:true,
                totalIterations:tune.iterations
            }
            this.forestLayoutOf={key:cacheKey,layout}
            return layout
        }
        /* MODE STATIQUE (par défaut): layoutForests complet. */
        const layout=layoutForests(selectedGraphs,{width,height})
        this.forestLayoutOf={key:cacheKey,layout}
        return layout
    }

    /* AVANCE L'ANIMATION D'UNE FRAME et met à jour le plot.
       BOUCLE CONTINUE: pas de fin — le graphe respire tant qu'il est affiché.
       `advanceLayout` peut marquer `done` (convergence), on l'ignore: on
       continue d'avancer, le momentum fait osciller autour de l'équilibre. */
    advanceForestAnimation(){
        const cached=this.forestLayoutOf
        if(!cached||!cached.layout?.animatedStates) return true
        const layout=cached.layout
        layout.animating=true
        /* 2 pas par frame: 1 pas à 60fps ondule à peine — le temps qu'on le
           voie il faut 10 s. 2 pas = vivant sans téléporter. Au-delà, le
           cubique dépasse le repos et ça pompe. */
        const stepsPerFrame=2
        const finished=[]
        for(let i=0;i<layout.animatedStates.length;i++){
            const state=layout.animatedStates[i]
            /* Relance si le plafond est atteint: `iteration` repart, `velo`
               garde son élan — pas de saut, juste une oscillation continue. */
            if(state.iteration>=state.totalIterations) state.iteration=0
            state.done=false
            advanceLayout(state,stepsPerFrame)
            finished.push(finalizeAnimatedLayout(state))
        }
        /* `placed` RESTE du même type: `applyGridLayout` ne lit que des entrées
           `{graph,positions,minX,minY,w,h}` — jamais des groupes grillés. */
        const placed=finished
        const gridded=applyGridLayout(placed,{width:layout.width,height:layout.height})
        layout.groups=gridded.groups
        /* DESSINE SANS RECRÉER: `renderForestPlot` invaliderait `forestLayoutOf`
           et repartirait du cercle — ici on peint le layout qu'on vient
           d'avancer. */
        this.drawForestLayout(layout)
        return false
    }

    /* LE DESSIN, ET IL NE FAIT QUE LIRE DES POSITIONS.

       LES SOMMETS SONT GROUPÉS PAR TRANCHE D'ERREUR — huit traces, pas un
       anneau par sommet. Une trace par sommet donnerait dix mille entrées de
       légende et dix mille nœuds; huit traces donnent huit teintes, et c'est
       exactement ce que l'œil sait comparer. LEUR COULEUR EST L'ERREUR DE LA
       FORMULE (`forestErrorColor`); les liens, eux, portent la NATURE de la
       différence — un briques, une couleur — et leur propre légende. */
    /* LES COULEURS DES SOMMETS, ET C'EST L'ERREUR QUI LES PEINT.

       Huit tranches, pas un anneau par sommet isolé: teinte continue du bleu
       ciel (erreur nulle) au rouge vif (erreur de fenêtre ou pire), par
       interpolation HSL — le chemin RGB traverserait le gris, le HSL passe
       par des brisées lisibles. L'échelle est UNIQUE: la fenêtre ppm, ou le
       pire écart du lot à défaut de fenêtre, exactement la même que celle de
       l'histogramme du récapitulatif. */
    static FOREST_COLOR_STEPS=8

    /* L'ARRONDI DES AFFICHAGES ppm: deux décimales, sans zéro mort. */
    formatPPM(value){
        const number=Number(value)
        if(!Number.isFinite(number)) return "—"
        return String(Math.round(number*100)/100)
    }

    /* UNE COULEUR, ET ELLE EST CONTINUE (t ∈ [0,1] → hex).

       hue 213° (le bleu ciel `#78b4ff` de la palette) → 360° (rouge),
       clarté 74% → 57%, saturation pleine: t=0 retombe sur la palette du
       programme, t=1 sur le rouge d'alerte `.badge.req`. */
    static forestErrorColor(t){
        const clamped=Math.min(1,Math.max(0,Number(t)||0))
        const hue=213+clamped*(360-213)
        const lightness=74-clamped*(74-57)
        const h=((hue%360)+360)%360
        const chroma=1-Math.abs(lightness/50-1)
        const x=chroma*(1-Math.abs((h/60)%2-1))
        const m=lightness/100-chroma/2
        let r=0,g=0,b=0
        if(h<60){r=chroma;g=x}
        else if(h<120){r=x;g=chroma}
        else if(h<180){g=chroma;b=x}
        else if(h<240){g=x;b=chroma}
        else if(h<300){r=x;b=chroma}
        else{r=chroma;b=x}
        const hex=value=>Math.round(Math.min(1,Math.max(0,value))*255)
            .toString(16).padStart(2,"0")
        return `#${hex(r+m)}${hex(g+m)}${hex(b+m)}`
    }

    /* LA PALETTE DES BRIQUES, et elle est celle du programme.

       Le bleu `#78b4ff` des listes ionisantes ouvre la série, puis le vert de
       l'accent, puis l'orange et le rouge d'alerte que la feuille de style
       declare pour `.badge.warn` et `.badge.req`. Une palette inventée ici
       ferait un graphique qui ne ressemble à rien du reste de l'application. */
    static FOREST_FORMULA_COLOURS=["#78b4ff","#aef22e","#ffb02e","#ff6363","#c58cff"]

    renderForestPlot(){
        const plot=this.forestPlot
        if(!plot) return
        /* RÉUTILISE LE CACHE: invalider ici repartirait du cercle à chaque
           frame — `forestOverviewLayout` recrée seulement si batch, sélection
           ou taille ont changé. */
        const layout=this.forestOverviewLayout({animate:true})
        if(!layout){
            this.stopForestAnimation()
            plot.traces=[]
            this.forestVertexLabels=null
            this.drawForestLegend([],null)
            plot.drawGraph?.()
            return
        }
        this.drawForestLayout(layout)
        /* DÉMARRE LA BOUCLE si le layout vient d'être créé en mode animé:
           sans cet appel le cercle initial est dessiné une fois et ne bouge
           jamais. */
        if(layout.animating) this.startForestAnimation()
    }

    /* LE DESSIN PUR, SANS CACHE NI RECRÉATION.
       `renderForestPlot` (ensure) et `advanceForestAnimation` (tick) peignent
       le même layout: le tick ne doit jamais repasser par l'ensure, sinon il
       jette les états animés et repart du cercle. */
    drawForestLayout(layout){
        const plot=this.forestPlot
        if(!plot||!layout){
            this.drawForestLegend([],null)
            plot?.graphSVG?.select(".forest-root-links").selectAll("*").remove()
            return
        }
        this.forestLayout=layout
        const batch=this.forestGraphs[0]
        /* LA POSITION DE CHAQUE SOMMET, DANS UN INDEX UNIQUE. Le noyau numérote
           les pics par rang dans l'ordre trié, et la mise en page ne connaît que
           des positions: c'est le seul endroit où les deux mondes se rencontrent,
           donc c'est le seul endroit où une confusion serait possible. */
        const place=new Map()
        for(const group of layout.groups){
            for(const point of group.points) place.set(`${group.rank}:${point.index}`,point)
        }
        const at=(rank,index)=>place.get(`${rank}:${index}`)
        const allGroups=batch.graphs.map((graph,index)=>({graph,rank:graph.rank??index}))
        /* FILTRER PAR SÉLECTION: si rien n'est sélectionné, tout afficher;
           sinon n'afficher que les arbres sélectionnés. */
        const hasSelection=this.forestSelected.size>0
        const groups=hasSelection
            ?allGroups.filter(g=>this.forestSelected.has(g.rank))
            :allGroups
        const traces=[]

        /* UNE TRACE DE SEGMENTS, et elle tient tous les liens qu'on lui donne
           dans UN SEUL buffer (calque GL: un LineSegments partagé, pas un
           chemin par lien). `xs/ys` sont déjà des tableaux plats —
           pas de `Float64Array.from(pairs)` qui alloue 2× par trace et par
           frame. */
        const segmentTrace=(id,title,colour,opacity,xs,ys,size)=>{
            if(!xs.length) return
            traces.push(new XYTrace({
                id,title,mode:"segments",layer:"gl",
                options:{mode:"segments",layer:"gl",color:colour,opacity,
                    line:{size}},
                wave:Wave.fromCoordinates(Float64Array.from(xs),Float64Array.from(ys),{},["x","y"])
            }))
        }

        /* LA NATURE DU SEGMENT, ET PAS SON ERREUR.

           Le poids d'un lien est déjà lu dans la liste des liens et dans la
           courbe des poids; ici un segment dit PAR QUOI il relie deux formules
           — `link.label`, la différence de briques — et sa couleur vient de la
           palette des briques, indexée par `link.standard`: la même briques
           porte la même couleur d'un arbre à l'autre. Une trace par nature,
           opacité uniforme — la trancher par poids serait revenir au gris de
           tout à l'heure. */
        const palette=this.constructor.FOREST_FORMULA_COLOURS
        const natureSlots=new Map()   // clé → rang d'apparition (repli)
        const natureBuckets=new Map() // clé → {label,colour,xs,ys,count}
        for(const {graph,rank} of groups){
            for(const link of graph.links??[]){
                const from=at(rank,link.u)
                const to=at(rank,link.v)
                if(!from||!to) continue
                const key=Number.isInteger(link.standard)
                    ?`s${link.standard}`
                    :`l${link.label??"?"}`
                let bucket=natureBuckets.get(key)
                if(!bucket){
                    const slot=natureSlots.size
                    natureSlots.set(key,slot)
                    const colour=Number.isInteger(link.standard)
                        ?palette[link.standard%palette.length]
                        :palette[slot%palette.length]
                    bucket={
                        label:link.label??(Number.isInteger(link.standard)?`#${link.standard}`:"link"),
                        colour,xs:[],ys:[],count:0
                    }
                    natureBuckets.set(key,bucket)
                }
                bucket.xs.push(from.x,to.x)
                bucket.ys.push(from.y,to.y)
                bucket.count++
            }
        }
        for(const [key,bucket] of natureBuckets){
            segmentTrace(
                `${this.title}:forest:nature:${key}`,
                `${bucket.label} ×${bucket.count}`,
                bucket.colour,0.85,bucket.xs,bucket.ys,1)
        }

        /* LE SEGMENT ÉDITÉ, REPASSÉ PAR-DESSUS EN BLANC.

           Il est déjà dans son tas de couleur, comme les autres — donc sans
           cette trace, l'utilisateur ne verrait pas lequel il vient de
           sélectionner, et la carte qu'il vient d'ouvrir semblerait désigner
           un lien au hasard. Elle est tracée APRÈS les natures, donc peinte au
           dessus, et son titre porte la brique: elle apparaît dans le
           sélecteur de traces comme « ce que je suis en train d'éditer ». */
        const edit=this.forestSegmentEdit
        if(edit){
            const from=at(edit.rank,edit.link.u)
            const to=at(edit.rank,edit.link.v)
            if(from&&to){
                segmentTrace(
                    `${this.title}:forest:edit`,
                    `editing ${edit.link.label??`#${edit.link.standard}`}`,
                    "#ffffff",1,[from.x,to.x],[from.y,to.y],3)
            }
        }

        /* LES SOMMETS: DES ANNEAUX CREUX, COLORES PAR LEUR ERREUR.

           Le disque blanc ne laissait aucune place à l'erreur; un anneau
           (`ring`) laisse voir la nappe dessous, et sa teinte va du bleu ciel
           au rouge — la MÊME échelle que l'histogramme du récapitulatif. Les
           formules viennent de `attributeTree` (mémoïsées par graphe): sans
           résultat, l'anneau reste gris, ce qui dit vrai — rien n'est encore
           lu pour cet arbre. `forestRowIndex` indexe une fois par résultat:
           une frame d'animation ne rebâtit pas de Map O(n). */
        const ppmWindow=Number(this.parameters.ppm)>0?Number(this.parameters.ppm):null
        const STEPS=this.constructor.FOREST_COLOR_STEPS
        let errorScale=ppmWindow
        if(errorScale===null){
            for(const {graph} of groups){
                const worst=this.forestAttributions?.byGraph?.get(graph)?.worstAbsPpm
                if(Number.isFinite(worst)&&worst>0) errorScale=Math.max(errorScale??0,worst)
            }
        }
        const unselX=[],unselY=[]
        const rootX=[],rootY=[]
        const neutralX=[],neutralY=[]
        const errorX=Array.from({length:STEPS},()=>[])
        const errorY=Array.from({length:STEPS},()=>[])
        const vertexLabels=[]  // {x,y,text,rank} pour étiquettes de formule
        let colored=0
        for(const {graph,rank} of groups){
            const isTreeSelected=this.forestSelected.has(rank)
            const rows=this.forestAttributions?.byGraph?.get(graph)?.rows??null
            const attrByIndex=rows?this.forestRowIndex(rows):null
            for(const vertex of graph.vertices??[]){
                const point=at(rank,vertex.index)
                if(!point) continue
                if(isTreeSelected){
                    if(vertex.isRoot){
                        rootX.push(point.x); rootY.push(point.y)
                    }
                    const row=attrByIndex?attrByIndex.get(vertex.index):null
                    const err=row&&Number.isFinite(row.errorPpm)
                        ?Math.abs(row.errorPpm):null
                    if(err===null||!(errorScale>0)){
                        neutralX.push(point.x); neutralY.push(point.y)
                    }else{
                        let step=Math.floor(err/errorScale*STEPS)
                        if(step<0) step=0
                        if(step>=STEPS) step=STEPS-1
                        errorX[step].push(point.x)
                        errorY[step].push(point.y)
                        colored++
                    }
                }else{
                    unselX.push(point.x); unselY.push(point.y)
                }
            }
        }
        if(unselX.length){
            traces.push(new XYTrace({
                id:`${this.title}:forest:peaks:unselected`,
                title:"measured peaks (unselected)",
                mode:"points",layer:"gl",
                options:{mode:"points",layer:"gl",color:"#dfe6ee",line:{size:1},
                    marker:{shape:"circle",size:3}},
                wave:Wave.fromCoordinates(Float64Array.from(unselX),Float64Array.from(unselY),{},["x","y"])
            }))
        }
        /* LE HALO DE RACINE, ET PAS UNE CROIX VERTE. La croix se lisait comme
           un marqueur de données — la forme et la force d'un point de
           mesure; le halo dit « ici » sans rien prétendre mesurer. Il est
           peint AVANT les anneaux (même buffer de points, ordre d'upload)
           pour rester derrière eux. */
        if(rootX.length){
            traces.push(new XYTrace({
                id:`${this.title}:forest:rootglow`,
                title:"selected roots",
                mode:"points",layer:"gl",
                options:{mode:"points",layer:"gl",color:"#aef22e",opacity:0.5,
                    line:{size:1},marker:{shape:"glow",size:13}},
                wave:Wave.fromCoordinates(Float64Array.from(rootX),Float64Array.from(rootY),{},["x","y"])
            }))
        }
        /* LES ANNEAUX: gris (rien de lu pour l'arbre) puis les huit teintes
           d'erreur, de la plus petite à la plus grande. */
        if(neutralX.length){
            traces.push(new XYTrace({
                id:`${this.title}:forest:vertex:neutral`,
                title:"vertices (no reading yet)",
                mode:"points",layer:"gl",
                options:{mode:"points",layer:"gl",color:"#dfe6ee",opacity:0.5,
                    line:{size:1},marker:{shape:"ring",size:5}},
                wave:Wave.fromCoordinates(Float64Array.from(neutralX),Float64Array.from(neutralY),{},["x","y"])
            }))
        }
        for(let step=0;step<STEPS;step++){
            if(!errorX[step].length) continue
            const low=step/STEPS
            const high=(step+1)/STEPS
            traces.push(new XYTrace({
                id:`${this.title}:forest:error:${step}`,
                title:`${this.formatPPM(low*errorScale)}–${this.formatPPM(high*errorScale)} ppm error`,
                mode:"points",layer:"gl",
                options:{mode:"points",layer:"gl",
                    color:this.constructor.forestErrorColor((low+high)/2),
                    opacity:1,line:{size:1},marker:{shape:"ring",size:5}},
                wave:Wave.fromCoordinates(Float64Array.from(errorX[step]),Float64Array.from(errorY[step]),{},["x","y"])
            }))
        }

        /* `traces`, ET NON `data`: `resolveRenderTraces()` et `dataBounds()` lisent
           `this.traces` quand il y en a, et ne retombent sur `this.data` qu'en
           dernier recours. Écrire dans `data` laissait donc `traces` vide — rien
           n'était dessiné et les bornes restaient nulles, sans une seule erreur:
           un cadre muet. C'est le défaut le plus coûteux, il ne se signale pas. */
        plot.traces=traces
        /* LA LÉGENDE SUIT LA FRAME: natures de segment + échelle d'erreur.
           Elle ne reconstruit du DOM qu'à SIGNATURE changée — les frames
           d'animation, qui se répètent, ne paient rien. */
        this.drawForestLegend([...natureBuckets.values()],colored>0?errorScale:null)
        /* FORMULES DES RACINES PRÈS DE CHAQUE SOMMET RACINE. */
        this.hookForestLabelZoom(plot)
        this.drawForestCellTitles(groups,layout,plot)
        /* LIENS POINTILLÉS ENTRE RACINES, avec l'écart et la brique proche. */
        this.drawForestRootLinks(groups,layout,plot)
        plot.drawGraph?.()
        /* CONFIGURER L'INTERACTION SOURIS (une seule fois). */
        if(!this.forestInteractionHooked){
            this.setupForestInteraction(plot)
            this.forestInteractionHooked=true
        }
    }

    /* Ferme la carte d'édition, et redessine pour retirer la mise en valeur. */
    closeForestSegmentEditor(){
        if(!this.forestSegmentEdit) return
        this.forestSegmentEdit=null
        if(this.forestSegmentEditHost){
            this.forestSegmentEditHost.style.display="none"
            this.forestSegmentEditHost.replaceChildren()
        }
        this.drawForestLayout(this.forestLayout)
    }

    /* Ouvre la carte d'édition sur UN SEGMENT, et le met en valeur.
       `graph` est le graphe d'où vient le lien, `rank` son rang dans le
       réseau — les deux parce qu'un lien ne se désigne ni par son `u`/`v` (qui
       ne sont uniques que dans leur arbre) ni par son `standard` (qui est un
       rang de brique, partagé par tous les arbres). */
    openForestSegmentEditor(graph,rank,link){
        if(!graph||!link) return
        this.forestSegmentEdit={graph,rank,link}
        this.renderForestSegmentEditor()
        this.drawForestLayout(this.forestLayout)
    }

    /* LA CARTE D'ÉDITION, et elle est entièrement reconstruite à chaque
       ouverture. Un champ `input` qui survit à deux segments porterait la
       valeur du précédent — donc c'est un `replaceChildren`, pas une mise à
       jour. */
    renderForestSegmentEditor(){
        const host=this.forestSegmentEditHost
        const edit=this.forestSegmentEdit
        if(!host||!edit) return
        const {link,graph,rank}=edit
        host.replaceChildren()

        const title=CE("div",{},[
            `Segment ${link.u} ↔ ${link.v} — tree #${rank}`
        ])
        stylize(title,{fontWeight:"bold"})
        host.appendChild(title)

        /* CE QUI EST ÉCRIT ICI EST L'INDEX DE LA BRIQUE, pas un texte: le champ
           est pré-rempli avec la NOTATION, parce que c'est ce que l'utilisateur
           connaît, et c'est ce qu'il retapera. Le rang vient d'un `title` et
           jamais d'une valeur affichée — un champ qui affiche « 3 » pour une
           brique ne veut rien dire pour personne. */
        const bricks=this.forestLinkBricks()
        const current=bricks[link.standard]
        const row=CE("div",{},[])
        stylize(row,{display:"flex",gap:"6px",alignItems:"center",flexWrap:"wrap"})
        const input=CE("input",{},[])
        input.type="text"
        input.value=current?.notation??link.label??""
        input.placeholder="CH2, NH, O, 13C..."
        input.size=Math.max(12,Math.min(28,(input.value?.length??0)+8))
        stylize(input,{flex:"1 1 160px",minWidth:"0",
            background:"rgba(255,255,255,0.08)",color:"inherit",
            border:"1px solid rgba(255,255,255,0.25)",borderRadius:"3px",
            padding:"3px 5px",fontFamily:"monospace",fontSize:"1em"})
        /* La liste des briques EXISTANTES, en proposition — et non en
           contrainte: l'utilisateur peut taper une formule absente du plan,
           auquel cas elle est ajoutée (comme au bouton « Merge »). Un
           `datalist` ne bloque rien et donne les termes du vocabulaire de la
           maison.

           L'IDENTIFIANT EST PROPRE À CE NŒUD. Deux nœuds d'attribution
           ouverts côte à côte partageraient sinon le même `id`, et le second
           `datalist` — le premier trouvé par le document — s'afficherait pour
           les deux champs: les propositions d'un arbre apneaient celles de
           l'autre. Un compteur suffit, il n'a pas besoin d'être stable. */
        const listId=this.forestBrickListId
        const datalist=CE("datalist",{id:listId},[])
        for(const brick of bricks){
            if(!brick.notation) continue
            datalist.appendChild(CE("option",{value:brick.notation},[]))
        }
        input.setAttribute("list",listId)
        row.append(input,datalist)

        const hint=CE("div",{},[
            current
                ?`now: ${current.notation} — rank ${link.standard}`
                :`now: ${link.label??"(none)"} — not a reference of the plan`,
            `error ${Number(link.weight??0).toFixed(4)} Da on ${link.u}↔${link.v}`
        ])
        stylize(hint,{opacity:"0.75",fontSize:"0.95em"})

        const status=CE("div",{},[])
        stylize(status,{opacity:"0.85",fontSize:"0.95em"})

        const button=(text,handler)=>{
            const b=CE("button",{},[text])
            b.type="button"
            stylize(b,{background:"rgba(255,255,255,0.12)",color:"inherit",
                border:"1px solid rgba(255,255,255,0.25)",borderRadius:"3px",
                padding:"2px 8px",fontFamily:"inherit",fontSize:"1em",cursor:"pointer"})
            b.addEventListener("click",handler)
            return b
        }
        const apply=async ()=>{
            const message=await this.applyForestSegmentBrick(input.value)
            status.textContent=message
        }
        const sever=async ()=>{
            const message=await this.severForestSegment()
            status.textContent=message
        }
        row.append(
            button("Apply",apply),
            button("Sever",sever),
            button("Close",()=>this.closeForestSegmentEditor()))

        /* Entrée applique, Échap referme: ce sont les deux gestes qu'on attend
           d'un champ unique, et ils évitent d'aller chercher la souris. */
        input.addEventListener("keydown",async (event)=>{
            if(event.key==="Enter"){ event.preventDefault(); await apply() }
            else if(event.key==="Escape"){ event.preventDefault(); this.closeForestSegmentEditor() }
        })

        host.append(row,hint,status)
        host.style.display="flex"
        input.focus()
        input.select()
    }

    /* CHANGE LA BRIQUE D'UN SEGMENT, ET RECALCULE LA PROPAGATION.

       Le geste est « la liaison que la machine a trouvé ne veut pas dire ce que
       je crois » — donc l'utilisateur écrit la brique qu'il avait en tête, et
       tout ce qui en dépend est refait. Rend un texte d'état pour la carte.

       TROIS ÉTAPES, ET LEUR ORDRE EST IMPOSÉ PAR LE CACHE:

       1. la nouvelle brique doit EXISTER dans le plan de liaison, parce que
          `link.standard` est un rang dans cette liste et que la propagation lit
          `references[rank]`. Si elle n'y est pas, elle y est ajoutée — même
          règle et même code que « Merge », et c'est nécessaire: interdire la
          formule absente reviendrait à interdire la correction même pour
          laquelle ce bouton existe;
       2. `link.standard` et `link.label` sont réécrits, et le POIDS aussi —
          l'erreur d'un lien est l'écart entre la différence de m/z mesurée et la
          masse de la brique. Changer de brique sans changer le poids laisserait
          un lien dont la longueur au repos et dont l'erreur affichée
          décrivent la brique précédente;
       3. le cache d'attribution est purgé PUIS les collections republiées,
          comme le fait le clic sur un sommet. Le cache est indexé par graphe et
          par réglages; c'est la suppression de l'entrée qui force le calcul,
          pas le redessin. */
    async applyForestSegmentBrick(text){
        const edit=this.forestSegmentEdit
        if(!edit) return "no segment selected"
        const {link,graph,rank}=edit
        const wanted=String(text??"").trim()
        if(!wanted) return "type a formula first"

        let bricks=this.forestLinkBricks()
        let standard=bricks.findIndex(brick=>brick.notation===wanted)
        if(standard<0){
            /* La formule est-elle au moins LISIBLE? On la laisse passer par le
               même chemin que le bouton « Merge »: `forestGroupList` la passe
               au constructeur de plan, qui sait dire « isotope inconnu » au
               lieu qu'on écrive un second lecteur de formule ici. */
            const current=this.forestGroupList()
            if(current.some(entry=>String(entry.group??"").trim()===wanted))
                return `« ${wanted} » is in the plan but produced no reference mass — check its isotopes`
            this.commitForestGroups([...current,{group:wanted}])
            bricks=this.forestLinkBricks()
            standard=bricks.findIndex(brick=>brick.notation===wanted)
            if(standard<0)
                return `« ${wanted} » could not be read as a linking group`
        }
        if(standard===link.standard) return "unchanged"

        link.standard=standard
        link.label=bricks[standard]?.notation??wanted
        /* LE POIDS REFAIT SUR LA MASSE DE LA NOUVELLE BRIQUE. Les masses du
           plan sont divisées par la charge (voir `forestStandards`), donc
           c'est cette liste-là qu'il faut lire, pas les masses brutes: sinon un
           spectre 2+ verrait son erreur multipliée par deux. */
        const referenceMass=(this.forestPlan?.masses??[])[standard]
        if(Number.isFinite(referenceMass)){
            const from=graph.vertices.find(v=>v.index===link.u)
            const to=graph.vertices.find(v=>v.index===link.v)
            const gap=Math.abs((to?.mass??0)-(from?.mass??0))
            link.weight=Math.abs(gap-referenceMass)
        }
        /* L'erreur du GROUPE change avec le lien: la somme des poids de ses
           arêtes est lue et affichée dans la liste. Elle est cumulée dans
           `component.weight` à la croissance de l'arbre, donc elle est
           périmée dès que le lien change. */
        for(const batchComp of this.forestComponents??[]){
            const comp=batchComp.components?.find(c=>c.rank===rank)
            if(comp){
                comp.links=comp.links??[]
                const found=comp.links.find(l=>l.u===link.u&&l.v===link.v)
                if(found){
                    found.standard=link.standard
                    found.label=link.label
                    found.weight=link.weight
                }
                comp.weight=(comp.links??[]).reduce((total,l)=>total+(Number(l.weight)||0),0)
            }
        }

        this.forestAttributions?.byGraph?.delete(graph)
        /* Le plan a pu changer — une brique vient d'être ajoutée — donc la clé
           de contenu de l'attribution est périmée pour TOUS les arbres, pas
           seulement pour celui-ci. `publishForestCollections` la compare et
           purge de lui-même; on ne fait que ne pas laisser une entrée
           stale dans le `Map` de ce graphe. */
        this.forestLayoutOf=null
        this.renderForestSegmentEditor()
        await this.publishForestCollections()
        this.renderForestList()
        this.renderForestOverview()
        return `link ${link.u}↔${link.v} now on ${link.label} — ${Number(link.weight??0).toFixed(4)} Da`
    }

    /* LA COUPURE D'UN SEGMENT, VOLATILE COMME LE MERGE.
       Retire le lien du graphe affiché, partage les sommets en deux côtés
       par parcours des liens restants, donne à chaque moitié sa racine
       (l'ancienne quand elle y est, sinon `forestRoot`), remplace le graphe
       et son composant par les deux moitiés, purge les caches et repeint.
       Un nouveau « Grow network » régénère tout et efface la coupure. */
    async severForestSegment(){
        const edit=this.forestSegmentEdit
        if(!edit) return "no segment selected"
        const {link,graph,rank}=edit
        if(!graph||!link) return "no segment selected"
        /* LES `u/v` SONT DES INDICES DE PICS (ordre trié), PAS DES RANGS :
           la comparaison se fait sur l'identité, jamais sur < ou > qui
           supposerait un ordre de parcours. */
        const cutIndex=(graph.links??[]).findIndex(item=>
            item===link
            ||(item.u===link.u&&item.v===link.v)
            ||(item.u===link.v&&item.v===link.u))
        if(cutIndex<0) return `segment ${link.u}↔${link.v} is already gone`
        const rest=(graph.links??[]).filter((_,index)=>index!==cutIndex)
        const neighbours=new Map()
        for(const item of rest){
            if(!neighbours.has(item.u)) neighbours.set(item.u,[])
            if(!neighbours.has(item.v)) neighbours.set(item.v,[])
            neighbours.get(item.u).push(item.v)
            if(item.v!==item.u) neighbours.get(item.v).push(item.u)
        }
        const sideOf=(start)=>{
            const seen=new Set([start])
            const queue=[start]
            for(let head=0;head<queue.length;head++){
                for(const next of neighbours.get(queue[head])??[]){
                    if(seen.has(next)) continue
                    seen.add(next)
                    queue.push(next)
                }
            }
            return seen
        }
        const sideU=sideOf(link.u)
        if(sideU.has(link.v)) return `segment ${link.u}↔${link.v} is not a bridge`
        const byIndex=new Map((graph.vertices??[]).map(vertex=>[vertex.index,vertex]))
        const verticesA=[]
        const verticesB=[]
        for(const vertex of graph.vertices??[]){
            (sideU.has(vertex.index)?verticesA:verticesB).push(vertex)
        }
        if(!verticesA.length||!verticesB.length) return "empty side — nothing severed"
        const linksA=rest.filter(item=>sideU.has(item.u)&&sideU.has(item.v))
        const linksB=rest.filter(item=>!sideU.has(item.u)&&!sideU.has(item.v))
        /* GARDE-FOU : un arbre à N sommets a N-1 liens ; les deux moitiés
           doivent totaliser N sommets et N-1 liens restants, sinon le graphe
           affiché n'était pas un arbre (cycle, doublon) et la coupure
           mentirait sur les tailles. */
        const totalVertices=verticesA.length+verticesB.length
        const totalLinks=linksA.length+linksB.length
        const expectedVertices=graph.vertices?.length??totalVertices
        const expectedLinks=(graph.links?.length??totalLinks+1)-1
        if(totalVertices!==expectedVertices||totalLinks!==expectedLinks){
            return `sever refused: ${expectedVertices} peaks / ${expectedLinks+1} links don't split cleanly`
        }
        const rootOf=(vertices,keepIndex)=>{
            if(Number.isInteger(keepIndex)&&byIndex.has(keepIndex)) return keepIndex
            const chosen=forestRoot({vertices})
            return Number.isInteger(chosen?.index)?chosen.index:vertices[0]?.index??null
        }
        const rootA=rootOf(verticesA,sideU.has(graph.rootIndex)?graph.rootIndex:null)
        const rootB=rootOf(verticesB,!sideU.has(graph.rootIndex)?graph.rootIndex:null)
        const batch=this.forestGraphs?.[0]
        let batchIndex=(this.forestGraphs??[]).indexOf(batch)
        if(batchIndex<0) batchIndex=0
        const compRanks=(this.forestComponents?.[batchIndex]?.components??[]).map(item=>item.rank??0)
        const ranks=[...(batch?.graphs??[]).map(item=>item.rank??0),...compRanks]
        const freshRank=Math.max(rank,...ranks,-1)+1
        const weightOf=(links)=>links.reduce((n,item)=>n+(Number(item.weight)||0),0)
        const piece=(vertices,links,pieceRank,rootIndex)=>({
            rank:pieceRank,
            size:vertices.length,
            vertices:[...vertices].sort((a,b)=>a.mass-b.mass),
            links,
            rootIndex,
            rootReason:`severed from tree #${rank}`,
            rootCandidates:vertices.length,
            meanMass:vertices.length
                ?vertices.reduce((n,vertex)=>n+(Number(vertex.mass)||0),0)/vertices.length
                :0,
            span:vertices.length?vertices[vertices.length-1].mass-vertices[0].mass:0,
            weight:weightOf(links),
            totalIntensity:vertices.reduce((n,vertex)=>n+(Number(vertex.intensity)||0),0),
        })
        const severedA=piece(verticesA,linksA,rank,rootA)
        const severedB=piece(verticesB,linksB,freshRank,rootB)
        /* LE REBÂTIMENT RELIT LES COMPOSANTS (`forestGraph` + `forestRoot`):
           on ne touche pas aux graphes affichés, on remplace le composant
           par ses deux moitiés et on force la reconstruction. */
        const components=this.forestComponents?.[batchIndex]?.components
        if(Array.isArray(components)){
            const massOf=(index)=>byIndex.get(index)?.mass??0
            const toComponent=(severed)=>({
                rank:severed.rank,
                root:severed.rootIndex,
                rootMass:massOf(severed.rootIndex),
                peakMass:severed.vertices.reduce(
                    (best,vertex)=>((vertex.intensity??0)>(best.intensity??-Infinity)?vertex:best),
                    severed.vertices[0])?.mass??0,
                size:severed.size,
                maxIntensity:severed.vertices.reduce(
                    (n,vertex)=>Math.max(n,Number(vertex.intensity)||0),0),
                weight:severed.weight,
                links:severed.links.map(item=>({
                    u:item.u,v:item.v,weight:item.weight,
                    standard:item.standard,label:item.label??null,
                })),
            })
            const freshComponents=[...components]
            const atComponent=components.findIndex(item=>item?.rank===rank)
            const made=[toComponent(severedA),toComponent(severedB)]
            if(atComponent>=0) freshComponents.splice(atComponent,1,...made)
            else freshComponents.push(...made)
            /* ON REMPLACE LE TABLEAU EXTERNE AUSSI: `buildForestGraphs` est
               mémoïsé sur son identité (`forestGraphsOf===source`). */
            const freshBatches=[...(this.forestComponents??[])]
            freshBatches[batchIndex]={
                ...this.forestComponents[batchIndex],components:freshComponents}
            this.forestComponents=freshBatches
        }
        /* L'ANCIENNE ENTRÉE N'EXISTE PLUS: on purge par RANG, pas par identité
           d'objet — `buildForestGraphs` va recréer des objets graphes neufs. */
        if(this.forestAttributions?.byGraph){
            for(const [keyGraph] of [...this.forestAttributions.byGraph]){
                if(keyGraph?.rank===rank) this.forestAttributions.byGraph.delete(keyGraph)
            }
        }
        this.forestLayoutOf=null
        this.forestSelected.add(rank)
        this.forestSelected.add(freshRank)
        this.forestSegmentEdit=null
        if(this.forestSegmentEditHost){
            this.forestSegmentEditHost.style.display="none"
            this.forestSegmentEditHost.replaceChildren()
        }
        this.renderForest()
        const massOf=(index)=>byIndex.get(index)?.mass??0
        return `severed tree #${rank} at ${link.u}↔${link.v} — now #${rank} (${verticesA.length}) and #${freshRank} (${verticesB.length})`
    }

    /* CONFIGURE LES GESTIONNAIRES DE SOURIS POUR LE HOVER ET LE CLIC. */
    setupForestInteraction(plot){
        const svg=plot.graphSVG
        if(!svg) return
        const svgNode=svg.node()
        if(!svgNode) return

        /* Conversion écran → données (data coordinates) via les échelles du plot.

           `ux`/`uy` sont les VALEURS DE DONNÉE PAR PIXEL, mesurées sur place: une
           seule inversion de plus, à dix pixels du pointeur. Les seuils de
           pointage sont en pixels — ce que l'utilisateur vise — et les distances
           sont en données, ce que le graphique stocke; sans ce facteur les deux
           ne se comparent pas, et le geste dépendrait du zoom. */
        const screenToData=(clientX,clientY)=>{
            const pt=plot.pointerInGraphzone(clientX,clientY)
            if(!pt) return null
            const {xScale,yScale}=plot.plotScales()
            const SPAN=10
            const x=xScale.invert(pt.x)
            const y=yScale.invert(pt.y)
            const ux=Math.abs(xScale.invert(pt.x+SPAN)-x)/SPAN
            const uy=Math.abs(yScale.invert(pt.y+SPAN)-y)/SPAN
            return {x,y,ux:ux>0?ux:1e-9,uy:uy>0?uy:1e-9}
        }

        /* Trouver le sommet le plus proche, À HUIT PIXELS.

           La distance est convertie en pixels AVANT d'être comparée au seuil:
           `dx/ux` et `dy/uy` sont des pixels, donc le seuil est le même au zoom 1
           et au zoom 40 — et les deux axes n'ont pas à partager une échelle. */
        const findNearestVertex=(dataX,dataY,ux,uy,layout)=>{
            let best=null
            let bestDist=Infinity
            for(const group of layout.groups){
                for(const point of group.points){
                    const dx=(point.x-dataX)/ux
                    const dy=(point.y-dataY)/uy
                    const dist=dx*dx+dy*dy
                    if(dist<bestDist){
                        bestDist=dist
                        best={point,group}
                    }
                }
            }
            if(bestDist>64) return null
            return best
        }

        /* Trouver le segment le plus proche, À SIX PIXELS.

           Mêmes unités que ci-dessus: la projection du pointeur sur le segment
           est faite dans un repère où un pixel vaut une unité sur les DEUX
           axes. Sinon un lien à l'horizontale aurait un seuil différent d'un
           lien à la verticale, et l'un des deux serait impossible à attraper. */
        const findNearestSegment=(dataX,dataY,ux,uy,groups,at)=>{
            let best=null
            let bestDist=Infinity
            for(const {graph,rank} of groups){
                for(const link of graph.links??[]){
                    const from=at(rank,link.u)
                    const to=at(rank,link.v)
                    if(!from||!to) continue
                    /* Distance point-segment. */
                    const x1=(from.x-dataX)/ux
                    const y1=(from.y-dataY)/uy
                    const x2=(to.x-dataX)/ux
                    const y2=(to.y-dataY)/uy
                    const dx=x2-x1,dy=y2-y1
                    const len2=dx*dx+dy*dy
                    let t=0
                    if(len2>0) t=Math.max(0,Math.min(1,(-x1*dx-y1*dy)/len2))
                    const px=x1+t*dx
                    const py=y1+t*dy
                    const dist=px*px+py*py
                    if(dist<bestDist){
                        bestDist=dist
                        best={link,from,to,graph,rank,t}
                    }
                }
            }
            if(bestDist>36) return null
            return best
        }

        /* Mettre à jour les panneaux d'info. */
        const updateHover=(clientX,clientY)=>{
            const data=screenToData(clientX,clientY)
            if(!data){
                this.forestVertexInfoHost.style.display="none"
                this.forestSegmentInfoHost.style.display="none"
                return
            }

            const batch=this.forestGraphs?.[0]
            if(!batch) return
            const allGroups=batch.graphs.map((graph,index)=>({graph,rank:graph.rank??index}))
            const hasSelection=this.forestSelected.size>0
            const groups=hasSelection
                ?allGroups.filter(g=>this.forestSelected.has(g.rank))
                :allGroups

            const place=new Map()
            for(const group of this.forestLayout?.groups??[]){
                for(const point of group.points) place.set(`${group.rank}:${point.index}`,point)
            }
            const at=(rank,index)=>place.get(`${rank}:${index}`)

            /* Sommet le plus proche. */
            const vertexHit=findNearestVertex(data.x,data.y,data.ux,data.uy,this.forestLayout)
            if(vertexHit){
                const {point,group}=vertexHit
                const graph=batch.graphs.find(g=>g.rank===group.rank)
                if(graph){
                    const vertex=graph.vertices.find(v=>v.index===point.index)
                    const rows=this.forestAttributions?.byGraph?.get(graph)?.rows??null
                    const row=rows?rows.find(r=>r.index===point.index):null
                    if(row&&row.formula){
                        this.forestVertexInfoHost.style.display="flex"
                        this.forestVertexInfoHost.replaceChildren()
                        const lines=[
                            `Vertex ${point.index}`,
                            `Mass: ${point.mass.toFixed(4)} Da`,
                            `Formula: ${row.notation??row.formula.toString()}`,
                            `Error: ${row.errorPpm!==undefined?row.errorPpm.toFixed(1)+" ppm":"—"}`,
                            `Intensity: ${vertex?.intensity??0}`
                        ]
                        for(const line of lines){
                            const div=CE("div",{},[line])
                            stylize(div,{lineHeight:"1.3"})
                            this.forestVertexInfoHost.appendChild(div)
                        }
                    }else{
                        this.forestVertexInfoHost.style.display="none"
                    }
                }
            }else{
                this.forestVertexInfoHost.style.display="none"
            }

            /* Segment le plus proche. */
            const segmentHit=findNearestSegment(data.x,data.y,data.ux,data.uy,groups,at)
            if(segmentHit){
                const {link,graph,rank}=segmentHit
                const palette=this.constructor.FOREST_FORMULA_COLOURS
                const colour=Number.isInteger(link.standard)
                    ?palette[link.standard%palette.length]
                    :palette[0]
                this.forestSegmentInfoHost.style.display="flex"
                this.forestSegmentInfoHost.replaceChildren()
                const lines=[
                    `Segment: ${link.label??`#${link.standard}`}`,
                    `Nature: ${link.label??`standard ${link.standard}`}`,
                    `Error: ${link.weight.toFixed(4)} Da`,
                    `Vertices: ${link.u} ↔ ${link.v}`
                ]
                for(const line of lines){
                    const div=CE("div",{},[line])
                    stylize(div,{lineHeight:"1.3"})
                    this.forestSegmentInfoHost.appendChild(div)
                }
                /* Swatch de couleur. */
                const swatch=CE("div",{},[])
                stylize(swatch,{width:"12px",height:"12px",borderRadius:"2px",
                    background:colour,marginTop:"4px",
                    boxShadow:"0 0 0 1px rgba(255,255,255,0.3)"})
                this.forestSegmentInfoHost.appendChild(swatch)
            }else{
                this.forestSegmentInfoHost.style.display="none"
            }
        }

        svgNode.addEventListener("mousemove",(e)=>updateHover(e.clientX,e.clientY))
        svgNode.addEventListener("mouseleave",()=>{
            this.forestVertexInfoHost.style.display="none"
            this.forestSegmentInfoHost.style.display="none"
        })

        /* LE CLIC: UN SOMMET, SINON UN SEGMENT.

           L'ordre n'est pas un détail d'implémentation, c'est le geste. Un clic
           à moins de huit pixels d'un sommet est un clic sur ce sommet — donc il
           change la racine, et la carte de segment se referme. Tout le reste,
           c'est-à-dire là où AUCUN sommet n'est sélectionnable, tombe sur le
           segment le plus proche à six pixels et ouvre son édition. C'est ce qui
           rend les deux gestes compatibles sans mode particulier: le sommet
           reste prioritaire parce qu'il est petit et précis, le segment prend le
           reste parce qu'il est long et qu'un clic à côté de lui vise
           rarement autre chose. */
        svgNode.addEventListener("click",async (e)=>{
            const data=screenToData(e.clientX,e.clientY)
            if(!data) return
            const batch=this.forestGraphs?.[0]
            if(!batch) return
            const allGroups=batch.graphs.map((graph,index)=>({graph,rank:graph.rank??index}))
            const hasSelection=this.forestSelected.size>0
            const groups=hasSelection
                ?allGroups.filter(g=>this.forestSelected.has(g.rank))
                :allGroups
            const place=new Map()
            for(const group of this.forestLayout?.groups??[]){
                for(const point of group.points) place.set(`${group.rank}:${point.index}`,point)
            }
            const at=(rank,index)=>place.get(`${rank}:${index}`)

            const vertexHit=findNearestVertex(data.x,data.y,data.ux,data.uy,this.forestLayout)
            if(!vertexHit){
                /* PAS DE SOMMET: LE SEGMENT PREND LA MAIN. */
                const segmentHit=findNearestSegment(data.x,data.y,data.ux,data.uy,groups,at)
                if(!segmentHit){ this.closeForestSegmentEditor(); return }
                const {link,graph,rank}=segmentHit
                /* Re-cliquer sur le segment déjà sélectionné referme la carte:
                   le clic sert alors à désélectionner, comme partout ailleurs. */
                const same=this.forestSegmentEdit
                    &&this.forestSegmentEdit.link===link
                if(same){ this.closeForestSegmentEditor(); return }
                this.openForestSegmentEditor(graph,rank,link)
                return
            }
            /* Un sommet cache le segment: changer de racine et d'édition de
               brique dans le même geste serait un contresens. */
            this.closeForestSegmentEditor()

            const {point,group}=vertexHit
            const graph=batch.graphs.find(g=>g.rank===group.rank)
            if(!graph) return

            /* Changer la racine dans le graphe. */
            const oldRootIndex=graph.rootIndex
            const newRootIndex=point.index
            if(oldRootIndex===newRootIndex) return

            graph.rootIndex=newRootIndex
            for(const v of graph.vertices) v.isRoot=v.index===newRootIndex

            /* Mettre à jour le composant correspondant dans forestComponents. */
            for(const batchComp of this.forestComponents??[]){
                const comp=batchComp.components?.find(c=>c.rank===group.rank)
                if(comp){
                    comp.root=newRootIndex
                    comp.rootMass=point.mass
                }
            }

            /* Invalider le cache d'attribution pour ce graphe. */
            this.forestAttributions?.byGraph?.delete(graph)

            /* Relancer l'attribution pour les arbres sélectionnés. */
            /* LE CLIC SÉLECTIONNE SON ARBRE, ET C'EST LE CORRECTIF: sans ça,
               `publishForestCollections` ne publiait que les arbres
               sélectionnés — un clic sur un sommet d'un arbre NON
               sélectionné changeait bien `rootIndex`, invalidait le cache,
               puis `publish` sortait tôt (`!forestSelected.size` ou rang
               absent) sans jamais recalculer. Le cache restait vide, donc
               `drawForestCellTitles` ne trouvait aucune ligne (`if(!rows)
               continue`) et l'étiquette ne bougeait jamais. Sélectionner
               l'arbre cliqué garantit que le crible tourne pour lui, et
               `renderForestOverview` repeint ensuite anneaux + étiquettes
               via `drawForestLayout` → `drawForestCellTitles`. La liste est
               repeinte aussi, car elle affiche désormais la masse racine. */
            this.forestSelected.add(group.rank)
            await this.publishForestCollections()
            this.renderForestList()
            this.renderForestOverview()
        })
    }

    /* DESSINE LES FORMULES DES RACINES PRÈS DE CHAQUE SOMMET RACINE (SVG).
       Les étiquettes portent leurs coordonnées DATA (datum) et sont projetées
       en pixels via `plotScales()`, puis repositionnées à chaque zoom via
       `hookForestLabelZoom` qui enveloppe `plot.drawGraph()`. */
    repositionForestCellTitles(plot){
        if(!plot?.graphSVG) return
        let scales=null
        try{ scales=plot.plotScales() }catch{ return }
        if(!scales) return
        const {xScale,yScale}=scales
        const zone=plot.graphzone??{width:Infinity,height:Infinity}
        /* Le clip suit la taille de zone (resize) même sans reconstruction. */
        try{
            plot.graphSVG.select("defs").select("#forest-graphzone-clip")
                .attr("x",0).attr("y",0)
                .attr("width",zone.width).attr("height",zone.height)
        }catch{}
        plot.graphSVG.select(".anchor").selectAll(".forest-root-labels text").each(function(d){
            const el=this
            if(!d||!Number.isFinite(d.x)||!Number.isFinite(d.y)) return
            const px=xScale(d.x)
            const py=yScale(d.y)
            if(!Number.isFinite(px)||!Number.isFinite(py)||px<0||py<0||px>zone.width||py>zone.height){
                el.style.display="none"
                return
            }
            el.style.display=""
            el.setAttribute("x",px)
            el.setAttribute("y",py-18)
        })
    }
    /* Le zoom/pan/resize repeint le graphe via `plot.drawGraph()` sans repasser
       par `drawForestLayout`: sans crochet les étiquettes garderaient leurs
       pixels d'origine. On enveloppe une seule fois pour les repositionner. */
    hookForestLabelZoom(plot){
        if(!plot||plot._forestLabelsHooked) return
        const owner=this
        const original=plot.drawGraph.bind(plot)
        plot.drawGraph=function(...args){
            const result=original(...args)
            try{ owner.repositionForestCellTitles(plot) }catch{}
            try{ owner.repositionForestRootLinks(plot) }catch{}
            return result
        }
        plot._forestLabelsHooked=true
    }
    /* Le zoom/pan repositionne aussi les liens entre racines : les `x/y`
       stockées sont des données, les échelles ont bougé. */
    repositionForestRootLinks(plot){
        const layer=plot.graphSVG?.select(".forest-root-links")
        if(!layer||layer.empty()) return
        let xScale=null
        let yScale=null
        try{ ({xScale,yScale}=plot.plotScales()) }catch{}
        if(!xScale||!yScale) return
        layer.selectAll("line")
            .attr("x1",link=>xScale(link.low.point.x))
            .attr("y1",link=>yScale(link.low.point.y))
            .attr("x2",link=>xScale(link.high.point.x))
            .attr("y2",link=>yScale(link.high.point.y))
        layer.selectAll("text")
            .attr("x",link=>(xScale(link.low.point.x)+xScale(link.high.point.x))/2)
            .attr("y",link=>(yScale(link.low.point.y)+yScale(link.high.point.y))/2-4)
    }
    drawForestCellTitles(groups,layout,plot){
        const svg=plot?.graphSVG
        if(!svg) return
        const anchor=svg.select(".anchor")
        if(!anchor) return
        /* Clip labels to graphzone so they don't show outside when panning/zooming. */
        let defs=svg.select("defs")
        if(defs.empty()) defs=svg.append("defs")
        let clip=defs.select("#forest-graphzone-clip")
        if(clip.empty()){
            clip=defs.append("clipPath").attr("id","forest-graphzone-clip")
                .append("rect")
        }
        const gz=plot.graphzone
        clip.attr("x",0).attr("y",0).attr("width",gz.width).attr("height",gz.height)
        let labelLayer=anchor.select(".forest-root-labels")
        if(labelLayer.empty()) labelLayer=anchor.append("g").attr("class","forest-root-labels").attr("clip-path","url(#forest-graphzone-clip)")
        labelLayer.selectAll("*").remove()

        for(const {graph,rank} of groups){
            const rows=this.forestAttributions?.byGraph?.get(graph)?.rows??null
            if(!rows) continue
            const rootVertex=graph.vertices.find(v=>v.isRoot)
            if(!rootVertex) continue
            const rootRow=rows.find(r=>r.index===rootVertex.index)
            if(!rootRow||!rootRow.formula) continue
            const point=layout.groups.find(g=>g.rank===rank)?.points.find(p=>p.index===rootVertex.index)
            if(!point) continue
            const notation=prettyNotation(rootRow.formula)
            const error=rootRow.errorPpm!==undefined?` (${rootRow.errorPpm.toFixed(1)} ppm)`:""
            const text=`${notation}${error}`
            /* PROJETÉ, PAS BRUT: `point` est en DATA, le calque en PIXELS.
               Le datum garde le DATA pour `repositionForestCellTitles`. */
            let px=point.x
            let py=point.y-18
            try{
                const {xScale,yScale}=plot.plotScales()
                px=xScale(point.x)
                py=yScale(point.y)-18
            }catch{}
            labelLayer.append("text")
                .datum({x:point.x,y:point.y})
                .attr("x",px)
                .attr("y",py)
                .attr("text-anchor","middle")
                .attr("font-size","12px")
                .attr("font-weight","600")
                .attr("fill","#ffffff")
                .attr("stroke","rgba(0,0,0,0.8)")
                .attr("stroke-width","3px")
                .attr("paint-order","stroke fill")
                .attr("pointer-events","none")
                .text(text)
        }
    }

    /* L'INDEX (index de sommet → row de formule), MÉMOÏSÉ SUR LE RÉSULTAT.

       `propagateForest` est déjà mémoïsé par `attributeTree`; son index l'est
       donc aussi, via le WeakMap ci-dessous. Rebâtir un O(n) à chaque frame
       en plein rAF serait exactement le travail que la frame ne peut pas se
       payer. */
    forestRowIndex(rows){
        this.forestRowIndexCache??=new WeakMap()
        let index=this.forestRowIndexCache.get(rows)
        if(!index){
            index=new Map(rows.map(row=>[row.index,row]))
            this.forestRowIndexCache.set(rows,index)
        }
        return index
    }

    /* LES LIENS ENTRE RACINES, EN POINTILLÉS SVG PAR-DESSUS LE GL.
       Chaînage par masse mesurée comme le merge : chaque lien porte la
       différence de compositions attribuées, l'écart mesuré en Da, et
       l'erreur mesuré-vs-théorique en Da et ppm. */
    forestRootLinks(groups,layout){
        /* LA POSITION VIENT DU LAYOUT, PAS DU GRAPHE : `graph.vertices` n'a
           ni x ni y — d'où le NaN sur les attributs SVG. */
        const placed=new Map()
        for(const cell of layout?.groups??[]){
            for(const point of cell.points??[]) placed.set(`${cell.rank}:${point.index}`,point)
        }
        const roots=[]
        for(const {graph,rank} of groups??[]){
            const vertex=[...(graph.vertices??[])].find(item=>item.index===graph.rootIndex)
            if(!vertex) continue
            const point=placed.get(`${rank}:${vertex.index}`)
            if(!point||!Number.isFinite(point.x)||!Number.isFinite(point.y)) continue
            const rows=this.forestAttributions?.byGraph?.get(graph)?.rows??null
            const row=rows?this.forestRowIndex(rows).get(vertex.index):null
            roots.push({rank,mass:vertex.mass,formula:row?.formula??null,point})
        }
        roots.sort((a,b)=>a.mass-b.mass)
        const links=[]
        for(let i=1;i<roots.length;i++){
            const low=roots[i-1]
            const high=roots[i]
            const gap=high.mass-low.mass
            /* LA MASSE THÉORIQUE DE LA DIFFÉRENCE ATTRIBUÉE : somme signée
               des masses isotopiques — pas une brique du plan. */
            let notation=null
            let theoryMass=null
            if(low.formula&&high.formula){
                const raw=forestCompositionDiff(high.formula.composition,low.formula.composition)
                if(raw&&!forestDiffIsEmpty(raw)){
                    notation=forestDiffNotation(raw)
                    let sum=0
                    let known=true
                    for(const [element,byA] of raw){
                        for(const [A,n] of byA){
                            const mass=element?.isotope?.(A)?.mass??NaN
                            if(!Number.isFinite(mass)){ known=false; break }
                            sum+=mass*n
                        }
                        if(!known) break
                    }
                    if(known) theoryMass=sum
                }
            }
            /* L'ERREUR MESURÉ-VS-THÉORIQUE : écart des racines moins masse
               de la diff. Le ppm se lit contre la masse théorique. */
            const errorDa=theoryMass!==null?gap-theoryMass:null
            const errorPpm=errorDa!==null&&theoryMass>0
                ?errorDa/theoryMass*1e6
                :null
            links.push({low,high,gap,notation,theoryMass,errorDa,errorPpm})
        }
        return links
    }
    drawForestRootLinks(groups,layout,plot){
        const anchor=plot.graphSVG?.select(".anchor")
        if(!anchor||anchor.empty()) return
        let layer=anchor.select(".forest-root-links")
        if(layer.empty()){
            layer=anchor.append("g")
                .attr("class","forest-root-links")
                .attr("clip-path","url(#forest-graphzone-clip)")
        }
        const links=this.forestRootLinks(groups,layout)
        /* PROJETÉ, PAS BRUT : les points sont en DATA, le calque en PIXELS. */
        let xScale=null
        let yScale=null
        try{ ({xScale,yScale}=plot.plotScales()) }catch{}
        const X=(point)=>xScale?xScale(point.x):point.x
        const Y=(point)=>yScale?yScale(point.y):point.y
        layer.selectAll("line").data(links).join(
            enter=>enter.append("line")
                .attr("stroke","rgba(255,255,255,0.9)")
                .attr("stroke-width",1.5)
                .attr("stroke-dasharray","6 4"),
            update=>update,
            exit=>exit.remove())
        layer.selectAll("line")
            .attr("x1",link=>X(link.low.point))
            .attr("y1",link=>Y(link.low.point))
            .attr("x2",link=>X(link.high.point))
            .attr("y2",link=>Y(link.high.point))
        layer.selectAll("text").data(links).join(
            enter=>enter.append("text")
                .attr("fill","#ffffff")
                .attr("font-size","12px")
                .attr("font-weight","bold")
                .attr("text-anchor","middle")
                .attr("stroke","rgba(0,0,0,0.85)")
                .attr("stroke-width",3)
                .attr("paint-order","stroke"),
            update=>update,
            exit=>exit.remove())
        layer.selectAll("text")
            .attr("x",link=>(X(link.low.point)+X(link.high.point))/2)
            .attr("y",link=>(Y(link.low.point)+Y(link.high.point))/2-4)
            .text(link=>{
                const parts=[]
                if(link.notation) parts.push(link.notation)
                parts.push(`mes ${link.gap>=0?"+":""}${link.gap.toFixed(4)} Da`)
                if(link.theoryMass!==null) parts.push(`th ${link.theoryMass.toFixed(4)}`)
                if(link.errorDa!==null) parts.push(
                    `err ${link.errorDa>=0?"+":""}${link.errorDa.toFixed(4)} (${Number.isFinite(link.errorPpm)?link.errorPpm.toFixed(1)+" ppm":"?"})`)
                else parts.push("unattributed root")
                return parts.join(" · ")
            })
    }

    /* LA LÉGENDE DU GRAPHE, POSÉE DANS SON COIN (host: `.an-forest-legend`
       monté par `setupForestOverview`).

       Deux blocs: les NATURES de segment — un swatch par briques, avec son
       compte — et l'ÉCHELLE d'erreur des anneaux, le dégradé borné par le ppm
       de la fenêtre. La signature (nature:couleur:compte + échelle) décide si
       le DOM est retouché: à frame égale, rien ne bouge. */
    drawForestLegend(natures,errorScale){
        const host=this.forestLegendHost
        if(!host) return
        const ramp=Number.isFinite(errorScale)&&errorScale>0
        const signature=natures.map(n=>`${n.label}:${n.colour}:${n.count}`).join("|")
            +(ramp?`#ramp:${errorScale}`:"")
        if(host.dataset.signature===signature) return
        host.dataset.signature=signature
        host.replaceChildren()
        const empty=!natures.length&&!ramp
        host.style.display=empty?"none":"flex"
        if(empty) return
        const row=()=>{
            const line=CE("div",{},[])
            stylize(line,{display:"flex",alignItems:"center",gap:"5px",
                whiteSpace:"nowrap",fontSize:"0.7em",opacity:"0.92"})
            return line
        }
        for(const nature of natures){
            const line=row()
            const swatch=CE("div",{},[])
            stylize(swatch,{width:"9px",height:"9px",borderRadius:"2px",
                flex:"0 0 auto",background:nature.colour,
                boxShadow:"0 0 0 1px rgba(0,0,0,0.35)"})
            line.appendChild(swatch)
            line.appendChild(CE("span",{},[`${nature.label} ×${nature.count}`]))
            host.appendChild(line)
        }
        if(ramp){
            const line=row()
            const bar=CE("div",{},[])
            const stops=[0,0.5,1]
                .map(t=>this.constructor.forestErrorColor(t)).join(", ")
            stylize(bar,{width:"44px",height:"7px",borderRadius:"3px",
                flex:"0 0 auto",background:`linear-gradient(90deg, ${stops})`,
                boxShadow:"0 0 0 1px rgba(0,0,0,0.35)"})
            line.appendChild(bar)
            line.appendChild(CE("span",{},[
                `error 0–${this.formatPPM(errorScale)} ppm`
            ]))
            host.appendChild(line)
        }
    }

    /* LA FENÊTRE EST DANS LE PANNEAU CENTRAL, ET PAS AU-DESSUS DES LISTES.

       Le réseau est une LECTURE: on le regarde pour comparer, on ne le règle
       pas. Une lecture encastrée en tête du panneau de réglages pousse ceux-ci
       hors d'écran — il faut défiler pour passer de la forme aux paramètres, et
       l'on finit par oublier les deux. Dans le panneau central elle a la place
       d'une fenêtre, c'est-à-dire autant qu'on en veut, et elle se range avec
       les grilles des autres graphes plutôt que de disputer la colonne. */
    setupForestGraphDialog(channel,registrationName,label){
        this.forestDialog=new Dialog(
            `${label} network`,this.origin,this.origin.midCentralContent)
        /* COMME NodeWithAccordionGraph, ET POUR LA MÊME RAISON: une fenêtre de
           graphe fermable n'a aucun moyen de se rouvrir, faute d'un bouton qui
           la réouvre. La dismisser est donc grisée et inerte plutôt que
           masquée — un contrôle qui disparaît entre deux panneaux est plus
           dur à apprendre qu'un contrôle visiblement inapplicable. */
        const dismisser=this.forestDialog.DOMelt.dismisser
        delete dismisser.handleClick
        dismisser.classList.add("disabled")
        dismisser.setAttribute("aria-disabled","true")
        stylize(this.forestDialog.DOMelt.window,{
            top:"0px",
            left:"0px",
            width:"100%",
            height:"100%"
        })
        channel.register(
            `${registrationName}:graph`,this.forestDialog,`${label} network`)
        /* LA FENÊTRE EST PLEINE DÈS SA CRÉATION. Sans cet appel elle
           s'ouvrirait vide jusqu'au premier resolve — et un nœud sans entrée ne
           résout jamais, donc elle resterait vide indéfiniment. */
        this.setupForestOverview()
    }

    /* L'ORDRE DANS CETTE MÉTHODE EST LA MÉTHODE.

       Plot2D ne s'observe pas: il mesure sa boîte une seule fois, à la
       construction, et ne la remesure jamais. Tout ce qui prend de la place —
       le cadre, la légende, le récapitulatif — est donc monté AVANT la ligne qui
       crée le plot, sinon il mesure un cadre encore vide et se retrouve à moitié
       rempli, sans jamais le signaler. */
    setupForestOverview(){
        if(!this.forestDialog) return
        const content=this.forestDialog.DOMelt.content
        /* PAS DE GARDE SUR `this.forestPlot`, ET C'EST DÉLIBÉRÉ.

           `replaceChildren()` vide la fenêtre, donc au second montage le DOM est
           vierge alors que `this.forestPlot` existe encore — une garde « déjà
           construit » court-circuiterait, laissant une fenêtre SANS graphique
           qui paraît pourtant configurée. C'est le pire genre de défaut: rien
           ne signale l'absence, il faut le remarquer.

           Le Plot2DWebGL de l'appel précédent est d'abord LIBÉRÉ: il tient un
           contexte WebGL, et le remplacer sans le disposer en ferait fuiter un
           par reconstruction de panneau. */
        content.replaceChildren()
        this.forestPlot?.dispose?.()
        stylize(content,{
            display:"grid",
            /* DEUX RANGÉES, ET NON TROIS: le graphe, puis le récap. Il y en avait trois —
           le graphe, le titre « Attribution », et le récap à 15 % — et le titre
           ayant disparu, le récap est tombé dans la rangée `auto` du milieu
           pendant que celle du bas, les 15 %, restait vide: une bande morte sous
           le panneau, et un histogramme qui se retrouvait hors de la place qui
           était la sienne.

           `auto` ET NON UN POURCENTAGE. Le récap est plus haut quand il y a
           trois entrées que quand il y en a une, et une part fixe le tronquait
           au point de perdre l'histogramme lui-même — le bas d'un bloc à
           défilement, c'est-à-dire ce qu'on était venu regarder. En `auto` il
           prend ce qu'il lui faut, et c'est le graphe qui rend le reste: le
           graphe est la seule chose qui se passe bien d'être étiré. */
            "grid-template-rows":"minmax(0,1fr) auto",
            "grid-template-columns":"minmax(0,1fr)",
            height:"100%",
            minHeight:"0",
            minWidth:"0",
            padding:"4px",
            gap:"4px",
            overflow:"hidden"
        })
        this.forestPlotBox=CE("div",{className:"an-forest-plot"},[])
        stylize(this.forestPlotBox,{
            /* L'ANCRAGE DE LA LÉGENDE (absolue): sans `relative` elle
               flotterait sur la fenêtre entière. */
            position:"relative",
            /* PAS DE HAUTEUR EN px: la fenêtre a la sienne et se redimensionne.
               Un cadre de 260px figé laisserait une bande morte en dessous, puis
               une seconde bande dès qu'on élargit la fenêtre.
               width: 100% permet au grid item de remplir la cellule au lieu de
               se caler sur son contenu (ce qui crée une dépendance circulaire
               avec le Plot2D qui fait width: 100%).
               minWidth: 0 permet au grid item de rétrécir en dessous de sa
               taille de contenu (sinon min-content empêche le shrink). */
            width:"100%",
            minWidth:"0",
            minHeight:"160px",
            background:"rgba(255,255,255,0.04)",
            border:"1px solid rgba(255,255,255,0.15)",borderRadius:"3px"
        })
        /* FORWARD RESIZE OBSERVER: le plot doit être notifié quand sa boîte change de taille.

           LE RÉCAP EST DESSINÉ À UNE LARGEUR FIXE, ET CETTE LARGEUR EST LUE UNE
           SEULE FOIS par `renderForestRecap`. Un SVG étiré par `width:100%`
           s'étirerait visuellement mais ses repères — l'axe des ppm, la courbe
           cumulée — resteraient à leur place d'origine: la forme mentirait sur
           ses propres échelles. Il faut donc redessiner, et c'est ce forwarding
           qui le déclenche: le récap est dans la MÊME colonne que le graphe, donc
           ils se redimensionnent ensemble. */
        this.forestPlotBox.handleResize=()=>{
            this.forestPlot?.handleResize?.()
            this.renderForestRecap()
        }
        content.appendChild(this.forestPlotBox)

        /* LE RÉCAPITULATIF, SOUS LE GRAPHE — et il ne s'annonce plus par un titre
           séparé. Le titre « Attribution » au-dessus du bloc était une étiquette
           dans le vide: le graphe juste au-dessus est déjà le réseau
           d'attribution, donc l'étiquette ne distinguait rien — et le récap,
           lui, s'annonçait par sa première ligne, qui porte le nom du spectre.
           Une étiquette qui répète ce que la ligne dit déjà est du bruit, et
           du bruit dans un panneau de lecture coûte de la place à chaque
           chose. */
        this.forestRecapHost=CE("div",{className:"an-recap"},[])
        /* UN BLOC UNIQUE, BORDÉ: les lignes se distinguaient par rien, donc une
           pile de texte de tailles voisines se lisait comme un paragraphe —
           on ne savait pas où un spectre finissait et où l'autre commençait.
           `alignContent:start` empêche la grille d'étirer ses lignes, et
           `overflow:auto` couvre un récap à plusieurs entrées sur hauteur
           réduite. */
        stylize(this.forestRecapHost,{display:"grid",gap:"6px",
            alignContent:"start",minHeight:"0",overflow:"auto",
            padding:"5px 7px",borderRadius:"4px",
            border:"1px solid rgba(255,255,255,0.12)",
            background:"rgba(255,255,255,0.03)"})
        content.appendChild(this.forestRecapHost)

        /* LE PLOT, EN DERNIER: tout ce qui occupe de la place est déjà en place,
           donc la boîte qu'il mesure est exactement celle qu'il dessinera. */
        this.forestPlot=new Plot2DWebGL([],
            `${this.title} network`,this.origin,this.forestPlotBox)
        /* L'OPACITÉ GLOBALE DU CALQUE GL EST DE 0.7 — pensée pour un nuage de
           pics où les couches s'accumulent. La forêt veut du plein opacité,
           c'est ce que le SVG donnait. Les opacités PAR TRACE (les anneaux
           gris, le halo des racines, l'opacité des segments) voyagent dans la
           couleur du sommet (voir buildTraceDescriptors) et ne sont donc pas
           touchées ici. */
        this.forestPlot.glRenderOptions.opacity=1
        this.forestPlot.glLayer?.setOpacity?.(1)
        this.forestPlot.parameters.axis.left.autoLabel=false
        this.forestPlot.parameters.axis.bottom.autoLabel=false
        this.forestPlot.parameters.axis.left.label=""
        this.forestPlot.parameters.axis.bottom.label=""
        /* LE POINTAGE EST INACTIF SUR CE PLOT: le graphe est animé, donc un
           point blanc suivrait la souris sans rien nommer de stable, et une
           étiquette posée au clic demanderait un recalcul à chaque frame. Pan,
           zoom et double-clic restent — ce sont des gestes, pas des états. */
        this.forestPlot.pickEnabled=false
        /* LA LÉGENDE, ANCRÉE DANS LA BOÎTE DU PLOT: absolue, donc elle ne
           déplace rien — le plot a déjà mesuré sa boîte à la construction. */
        this.forestLegendHost=CE("div",{},[])
        stylize(this.forestLegendHost,{
            position:"absolute",top:"4px",left:"6px",zIndex:"1",
            pointerEvents:"none",display:"flex",flexDirection:"column",gap:"2px",
            color:"inherit",textShadow:"0 1px 2px rgba(0,0,0,0.75)",
            maxWidth:"60%"
        })
        this.forestPlotBox.appendChild(this.forestLegendHost)

        /* PANNEAU INFO SOMMET (formule sous la souris). */
        this.forestVertexInfoHost=CE("div",{},[])
        stylize(this.forestVertexInfoHost,{
            position:"absolute",bottom:"4px",left:"6px",zIndex:"1",
            pointerEvents:"none",display:"none",flexDirection:"column",gap:"2px",
            color:"inherit",textShadow:"0 1px 2px rgba(0,0,0,0.75)",
            background:"rgba(0,0,0,0.6)",padding:"6px 8px",borderRadius:"3px",
            fontSize:"0.7em",maxWidth:"200px",fontFamily:"monospace"
        })
        this.forestPlotBox.appendChild(this.forestVertexInfoHost)

        /* PANNEAU INFO SEGMENT (nature, erreur sous la souris). */
        this.forestSegmentInfoHost=CE("div",{},[])
        stylize(this.forestSegmentInfoHost,{
            position:"absolute",bottom:"4px",right:"6px",zIndex:"1",
            pointerEvents:"none",display:"none",flexDirection:"column",gap:"2px",
            color:"inherit",textShadow:"0 1px 2px rgba(0,0,0,0.75)",
            background:"rgba(0,0,0,0.6)",padding:"6px 8px",borderRadius:"3px",
            fontSize:"0.7em",maxWidth:"200px",fontFamily:"monospace"
        })
        this.forestPlotBox.appendChild(this.forestSegmentInfoHost)

        /* LA CARTE D'ÉDITION DU SEGMENT, et elle est l'unique carte qui CAPTE
           le pointeur: les deux autres ont `pointerEvents:"none"` et ne font
           qu'afficher. Celle-ci reçoit la frappe, donc elle doit être
           interactive — et pour cette raison elle vit au-dessus, sur toute la
           largeur, en bas: un pavé qui suit le segment serait cliquable en
           permanence et masquerait le graphique en permanence. */
        this.forestSegmentEditHost=CE("div",{},[])
        stylize(this.forestSegmentEditHost,{
            position:"absolute",bottom:"0",left:"0",right:"0",zIndex:"2",
            display:"none",flexDirection:"column",gap:"4px",
            background:"rgba(0,0,0,0.82)",padding:"6px 8px",
            borderTop:"1px solid rgba(255,255,255,0.18)",
            fontSize:"0.75em",fontFamily:"monospace",color:"inherit"
        })
        this.forestPlotBox.appendChild(this.forestSegmentEditHost)
        /* L'identifiant du `datalist` est alloué UNE fois par nœud: la carte est
           reconstruite à chaque ouverture, et un compteur consulté à chaque
           rendu laisserait derrière lui un identifiant par ouverture. */
        this.forestBrickListId=`forest-bricks-${++forestBrickListSerial}`
        this.forestSegmentEdit=null

        /* FORCER UN RESIZE APRÈS CRÉATION: le conteneur peut ne pas avoir sa taille
           finale au moment où le constructeur appelle drawGraph(). Un rAF assure
           que le layout est fait avant de mesurer. */
        requestAnimationFrame(()=>this.forestPlot?.handleResize?.())

        /* ET IL EST REPEINT TOUT DE SUITE, pas au prochain resolve: la fenêtre
           vient d'être recréée et montrerait un cadre vide à qui l'ouvrirait
           alors que les données existent déjà. */
        this.renderForestOverview()
    }




/* LA DISTRIBUTION DES ERREURS, ET LES CHIFFRES SONT TOUJOURS LUS.

       Rien n'est recompté: `pointCount` est celui du noyau, les erreurs
       viennent des entrées déjà publiées. Ce qui CHANGE est la lecture: au
       lieu de « combien ont matché » — un chiffre ambigu, une formule
       présente peut être fausse — on montre COMMENT les erreurs se
       répartissent: pour chaque cible sa MEILLEURE attribution (|ppm|), puis
       la médiane et les proportions sous la fenêtre, la demi-fenêtre et le
       dixième de la fenêtre — les trois seuils que l'œil retient déjà en
       lisant la liste. */
    /* LE RÉCAPITULATIF DE L'ATTRIBUTION EN FORCE BRUTE, une ligne par ENTRÉE.

       `batchIndex` était un rang de LOT D'ARBRES, et il servait à lire
       `this.attributions[batchIndex]` — c'est-à-dire un résultat de crible. Ce
       sont deux collections sans rapport: l'une compte les réseaux construits,
       l'autre les spectres entrés. Les index coïncent par hasard tant qu'il n'y
       a qu'un de chaque, et au-delà la ligne titled« entrée 2 » affiche
       l'histogramme d'erreurs d'un AUTRE spectre — un récap faux, ce qui est la
       seule chose qu'un récap ne doit jamais être. Ou bien il n'affiche rien du
       tout, quand la force brute n'a pas tourné: le panneau forest se lit
       justement avant le crible, donc c'est le cas le plus fréquent.

       On indexe donc les RÉSULTATS, pas les réseaux, et la ligne porte le titre
       de la vague qui les a produits. */
    forestRecap(inputIndex){
        const attribution=(this.attributions??[])[inputIndex]
        if(!attribution) return null
        const entries=attribution.entries??[]
        const targets=attribution.pointCount??0
        const window=Number(this.parameters.ppm)>0?Number(this.parameters.ppm):null
        /* LA MEILLEURE ERREUR PAR CIBLE: une cible peut porter plusieurs
           formules (bestMatches), et c'est la meilleure qui dit ce que le
           programme a su en faire. */
        const best=new Map()
        for(const entry of entries){
            if(!Number.isFinite(entry.errorPpm)) continue
            const index=entry.target?.index
            if(index===undefined||index===null) continue
            const absolute=Math.abs(entry.errorPpm)
            const previous=best.get(index)
            if(previous===undefined||absolute<previous) best.set(index,absolute)
        }
        const errors=[...best.values()].sort((a,b)=>a-b)
        const attributed=errors.length
        const median=attributed
            ?(attributed%2
                ?errors[(attributed-1)>>1]
                :(errors[attributed/2-1]+errors[attributed/2])/2)
            :null
        /* L'AXE EST LA FENÊTRE elle-même: au-delà, le noyau a filtré et il n'y
           a rien à montrer. Sans fenêtre, le pire écart du lot fait office
           d'axe — la forme reste vraie, seul le repère manque. */
        const domain=(window??(attributed?errors[attributed-1]:0))||1
        const BINS=16
        const counts=new Array(BINS).fill(0)
        for(const error of errors){
            let step=Math.floor(error/domain*BINS)
            if(!Number.isFinite(step)||step<0) step=0
            if(step>=BINS) step=BINS-1
            counts[step]++
        }
        /* LES PARTS SONT SUR LES CIBLES, PAS SUR LES ATTRIBUÉES: une cible
           sans formule compte dans le dénominateur, sinon le pourcentage
           mentirait en faveur du programme. */
        const share=(threshold)=>{
            if(targets<=0) return null
            let under=0
            for(const error of errors) if(error<=threshold) under++
            return under/targets
        }
        return {
            /* LE TITRE VIENT DE LA VAGUE, parce que le résultat lui-même ne le
               porte pas: deux spectres du même dossier ne se distinguent que par
               lui. `collectInputWaves` est le MÊME lecteur que le resolve —
               réappeler une autre liste donnerait des noms qui ne correspondent
               pas à l'ordre des résultats, ce qui serait pire que « Entrée N ».
               Un plan vide ou une entrée cassée renvoient une liste plus courte:
               on retombe alors sur le numéro, et la ligne reste truthful. */
            title:this.forestInputTitle(inputIndex),
            targets,attributed,counts,domain,window,median,
            /* CES TROIS NOMBRES SONT CE QUI MANQUE LE PLUS. Un histogramme dit
               « les erreurs sont basses » sans dire « sur combien de pics » — et
               une attribution qui couvre trois pics sur mille n'est pas une
               attribution, quelle que soit la finesse de son histogramme. */
            readings:entries.length,
            keptMatches:attribution.keptMatches??null,
            unexplained:Math.max(0,targets-errors.length),
            truncated:!!attribution.truncated,
            under:window===null?null:share(window),
            half:window===null?null:share(window/2),
            tenth:window===null?null:share(window/10)
        }
    }

    /* LE TITRE D'UNE ENTRÉE, résolu une fois par rendu. */
    forestInputTitle(index){
        if(this.forestInputTitlesOf!==this.attributions){
            this.forestInputTitlesOf=this.attributions
            let titles=[]
            try{ titles=(this.collectInputWaves?.().waves??[]).map(wave=>wave.metadata?.title??"") }
            catch{ titles=[] }
            this.forestInputTitles=titles
        }
        const title=this.forestInputTitles?.[index]
        return title?`${title} · input ${index+1}`:`input ${index+1}`
    }

/* LE RÉCAPITULATIF, ET IL EST UN HISTOGRAMME PAR ENTRÉE.

       Une ligne par spectre passé au crible: le titre, ce qui a été trouvé, puis
       la distribution des MEILLEURES erreurs en seize tranches — teintées par la
       MÊME échelle que les anneaux du graphe, repères à 1/10 et 1/2 de la
       fenêtre — puis les chiffres.

       ET LES CHIFFRES PASSENT DEVANT LA FORME. « 1 842 pics, 96 attribués » se
       lit en une seconde et décide s'il faut regarder l'histogramme; la forme,
       elle, ne dit rien tant qu'on ne sait pas sur combien de pics elle porte.
       L'histogramme était déjà bon — c'est ce qui faisait le récap, et non ce
       qui le rendait muet.

       LE VRAI ÉTAT VIDE, ENFIN DIT. Sans résultat de crible, le panneau forest
       affiche « run the brute force to fill this in » au lieu de « — resolve
       first », qui était une consigne déguisée en tiret cadratin: rien n'indiquait
       QUE faire pour le remplir. */
    renderForestRecap(){
        const host=this.forestRecapHost
        if(!host) return
        host.replaceChildren()
        const rows=(this.attributions??[])
            .map((_,index)=>this.forestRecap(index))
            .filter(Boolean)
        if(!rows.length){
            stylize(host.appendChild(CE("div",{},["run the brute force to fill this in"])),
                {fontSize:"0.75em",opacity:"0.55"})
            return
        }
        /* LE RÉCAPITULATIF DOIT DIRE CE QU'IL RÉCAPITULE, ET IL L'A AVAIT CESSÉ
           DE FAIRE.

           Il est posé sous le graphe d'ARBRES, et tout ce qu'il affiche —
           « 100 peak(s) · 90 attributed », une médiane en ppm — porte sur TOUT
           le spectre d'entrée du crible, alors que le graphe juste au-dessus
           ne dessine que les arbres sélectionnés. Les deux nombres ne
           correspondent à rien de ce qu'on voit, et rien ne le disait: on
           comparait 90 attribuées aux quelques pics du dessin et on en
           concluait que le réseau était cassé.

           L'étiquette « Attribution » qu'on avait retiré ne réparait rien non
           plus — elle ne disait pas « force brute » non plus. Elle est donc
           REMISE, mais dans le bloc, sur une seule ligne, et elle dit le mot
           qui départage les deux lectures.

           LA FENÊTRE EST DANS CETTE LIGNE ET NULLE PART AILLEURS DANS CE
           PANNEAU. C'est le réglage qui décide de tout ce qui suit — le trait
           pointillé du graphique est sa position — et le panneau forest ne
           l'affiche nulle part: sans elle, la règle en pointillés est une
           ligne sans raison d'être. */
        const ppm=Number(this.parameters.ppm)>0?Number(this.parameters.ppm):null
        const caption=CE("div",{},[
            "Brute force — the sieve, not the trees above"
            +(ppm!==null?` · window ${this.formatPPM(ppm)} ppm`:"")
        ])
        stylize(caption,{fontSize:"0.72em",opacity:"0.6",fontWeight:"bold"})
        host.appendChild(caption)
        for(const row of rows){
            const line=CE("div",{className:"an-recap-line"},[])
            stylize(line,{display:"grid",gap:"2px",minHeight:"0"})
            const head=CE("div",{},[row.title])
            stylize(head,{fontSize:"0.72em",opacity:"0.65",overflow:"hidden"})
            line.appendChild(head)

            /* LE COMPTE EN TÊTE ET EN CHIFFRES LUS: c'est lui qui décide si la
               ligne vaut qu'on regarde la forme en dessous. */
            const counts=CE("div",{},[
                `${row.targets} peak(s) · ${row.attributed} attributed`
                +(row.unexplained>0?` · ${row.unexplained} with no formula`:"")
            ])
            stylize(counts,{fontSize:"0.72em",opacity:"0.85",overflow:"hidden"})
            line.appendChild(counts)

            if(row.truncated){
                /* UNE LISTE tronquée est un préfixe, et son histogramme est donc
                   plus étroit que la vérité. Le dire ici, sinon la forme passe
                   pour complète. */
                const warn=CE("div",{},["truncated — this histogram is a prefix"])
                stylize(warn,{fontSize:"0.72em",opacity:"0.7"})
                line.appendChild(warn)
            }

            line.appendChild(this.drawForestRecapChart(row))
            const parts=[`${row.readings} reading(s)`]
            if(row.keptMatches!==null) parts.push(`up to ${row.keptMatches}/peak`)
            parts.push(`median ${row.median===null
                ?"—":`${this.formatPPM(row.median)} ppm`}`)
            if(row.window!==null&&row.under!==null){
                parts.push(
                    `≤${this.formatPPM(row.window)} ppm ${Math.round(100*row.under)}%`,
                    `≤${this.formatPPM(row.window/2)} ppm ${Math.round(100*row.half)}%`,
                    `≤${this.formatPPM(row.window/10)} ppm ${Math.round(100*row.tenth)}%`)
            }else{
                parts.push("no ppm window")
            }
            const stats=CE("div",{},[parts.join(" · ")])
            stylize(stats,{fontSize:"0.72em",opacity:"0.8",overflow:"hidden"})
            line.appendChild(stats)
            host.appendChild(line)
        }
    }

    /* LA COURBE CUMULÉE, CALCULÉE À PART ET SANS D3.

       C'est la seule chose que ce graphique AFFIRME, donc c'est la seule
       partie qui mérite d'être lue sans le dessin: `forestRecap` donne les
       comptes, cette méthode donne la courbe, et le test peut vérifier les deux
       sans DOM ni navigateur.

       LE PREMIER POINT EST À ZÉRO ET NON À LA PREMIÈRE TRANCHE: la courbe part
       de « aucun pic encore expliqué » et monte par paliers jusqu'au bord de
       la dernière tranche. Le dernier point n'est PAS À 1, et c'est voulu: un
       pic sans formule n'appartient à aucune tranche, donc la proportion
       plafonne à `attributed/targets`. Une courbe qui atteint 100 % alors que
       des pics n'ont rien reçu serait la pire des mensonges — elle dirait
       « tout est expliqué » au moment précis où l'utilisateur demande quels
       pics ne le sont pas.

       ET LE DÉNOMINATEUR EST LE NOMBRE DE CIBLES, jamais le nombre de
       lectures: une cible peut porter trois formules et n'en est qu'une. */
    forestRecapSteps(row){
        const bins=row.counts.length
        const steps=[{error:0,share:0,count:0}]
        let running=0
        row.counts.forEach((count,index)=>{
            running+=count
            steps.push({
                error:row.domain*(index+1)/bins,
                share:row.targets>0?running/row.targets:0,
                count,
                low:row.domain*index/bins,
                high:row.domain*(index+1)/bins
            })
        })
        return steps
    }

    /* LE RÉCAP EN D3, ET LA COURBE CUMULÉE EST LA MOITIÉ UTILE.

       L'histogramme en `div` disait où se concentrent les erreurs, ce qui est
       vrai et peu utile: une attestation en masse donne un gros pic unique, et
       toutes les attributions d'exactitude comparable en donnent un
       aussi. Il ne disait surtout pas LA question qu'on se pose devant un
       crible: « si je serre la fenêtre, que je perds? ». Cette question est de
       forme CUMULÉE — la part des pics expliqués en dessous d'un seuil — et c'est
       elle qui décide si on change un réglage. Elle est donc tracée, et pas
       déduite de trois pourcentages écrits en toutes lettres.

       DEUX ÉCHELLES, ET ILS NE PEUVENT PAS ÊTRE UN SEUL AXE. Les barres
       comptent des pics, la courbe compte une fraction des CIBLES; une barre
       vaut dix fois plus qu'une autre selon les données, une courbe part de 0
       et finit à 100 % quoi qu'il arrive. Les confondre donnerait une courbe
       qui bouge selon la taille du lot — donc une lecture qui change quand on
       ne change rien. Deux axes, donc: les pics à gauche, la part à droite.

       LE DÉNOMINATEUR EST LE NOMBRE DE CIBLES, PAS LE NOMBRE DE LECTURES:
       un pic peut porter trois formules et n'est qu'une cible. Un pic sans
       formule, lui, n'a AUCUNE erreur à comparer: il n'a pas de courbe à dire.
       Il compterait au dénominateur sans jamais apparaître au numérateur — il
       ferait alors descendre la courbe, ce qui est la bonne chose: c'est lui
       qu'on voit manquer.

       LA COURBE EST EN MARCHES, pas en segments droits. La donnée est
       comptée par tranches: entre deux bords de tranche la proportion est
       constante par construction, et une oblique entre deux points dirait
       qu'il y a eu des pics entre les deux — donc afficherait une précision
       que la mesure n'a pas. */
    drawForestRecapChart(row){
        /* LE TROISIÈME ARGUMENT N'EST PAS OPTIONNEL, et il ne l'est pas par goût:
           `CE` fait `for (let elt of child)` sur un `undefined` et lève. Un
           `CE("div",{})` pour un conteneur vide est donc une exception, pas un
           div vide — et elle tombe au premier rendu du récap, donc au premier
           resolve. Le conteneur doit donc passer `[]`. */
        const host=CE("div",{},[])
        stylize(host,{minWidth:"0",minHeight:"0"})
        const width=Math.max(180,Math.floor(this.forestRecapHost?.clientWidth||240))
        const HEIGHT=78
        const PAD={top:8,right:30,bottom:16,left:0}
        const innerW=Math.max(40,width-PAD.left-PAD.right)
        const innerH=HEIGHT-PAD.top-PAD.bottom
        const bins=row.counts.length

        const x=d3.scaleLinear().domain([0,row.domain]).range([PAD.left,PAD.left+innerW])
        const yPeak=d3.scaleLinear().domain([0,Math.max(1,d3.max(row.counts)??1)])
            .range([PAD.top+innerH,PAD.top])
        const yShare=d3.scaleLinear().domain([0,1]).range([PAD.top+innerH,PAD.top])

        /* LA COURBE CUMULÉE: un point par BORD DE TRANCHE, parce que
           « au plus X ppm » se lit à un bord. Les marches, et non les
           obliques: la donnée est comptée par tranches, donc entre deux bords
           la proportion est constante par construction — une oblique dirait
           qu'il y a eu des pics entre les deux, donc afficherait une précision
           que la mesure n'a pas. */
        const steps=this.forestRecapSteps(row)

        const svg=d3.select(host).append("svg")
            .attr("width","100%")
            .attr("height",HEIGHT)
            .attr("viewBox",`0 0 ${width} ${HEIGHT}`)
            .attr("preserveAspectRatio","none")
            .style("display","block")

        /* LES BARRES D'ABORD, ET DERRIÈRE: la courbe passe dessus. */
        svg.append("g").selectAll("rect").data(row.counts).join("rect")
            .attr("x",(count,index)=>x(row.domain*index/bins))
            .attr("width",Math.max(1,innerW/bins-1))
            .attr("y",count=>yPeak(count))
            .attr("height",count=>PAD.top+innerH-yPeak(count))
            /* ZÉRO COMPRIS ET IL SE VOIT: une tranche vide garde une hauteur
               d'un pixel, sinon elle se lit comme une absence de donnée alors
               que c'est une mesure nulle — et « rien ici » et « zéro ici » ne
               se ressemblent pas. */
            .attr("fill",(count,index)=>count>0
                ?this.constructor.forestErrorColor((index+0.5)/bins)
                :"rgba(127,140,155,0.30)")
            .attr("shape-rendering","crispEdges")
            .append("title")
            .text((count,index)=>{
                const low=row.domain*index/bins
                const high=row.domain*(index+1)/bins
                return `${count} target(s): ${this.formatPPM(low)}–${this.formatPPM(high)} ppm`
            })

        /* LE REMPLISSAGE SOUS LA COURBE: il donne la PART VISIBLE d'un coup
           d'œil, et il est ce qu'on regarde en premier — « quelle moitié du
           spectre est déjà réglée ».

           `datum(steps)` ET NON `area()(steps)`: `d3.area` est un GÉNÉRATEUR,
           il transforme les données qu'on lui passe; appelé sans argument dans
           une sélection, il reçoit `undefined` et lève. Les deux écritures
           marchent, mais `datum` pose les données une fois pour toutes et le
           générateur se lit comme une définition de forme. */
        svg.append("path")
            .datum(steps)
            .attr("d",d3.area()
                .x(step=>x(step.error))
                .y0(PAD.top+innerH)
                .y1(step=>yShare(step.share))
                .curve(d3.curveStepAfter))
            .attr("fill","rgba(255,255,255,0.13)")
            .attr("pointer-events","none")

        svg.append("path")
            .datum(steps)
            .attr("d",d3.line()
                .x(step=>x(step.error))
                .y(step=>yShare(step.share))
                .curve(d3.curveStepAfter))
            .attr("fill","none")
            .attr("stroke","#ffffff")
            .attr("stroke-width",1.4)
            .attr("stroke-linejoin","round")
            .attr("pointer-events","none")

        /* LA FENÊTRE EN ppm, ET ELLE EST UN SEUIL DE RÉSERVE, PAS UN BORD DE
           TRANCHE. Elle traverse tout le graphique: en dessous, le crible a
           publishé; au-dessus, il a écarté. C'est la seule information que la
           forme ne donne pas et qu'il faut avoir sous les yeux. */
        if(row.window!==null&&row.window<=row.domain){
            const wx=x(row.window)
            svg.append("line")
                .attr("x1",wx).attr("x2",wx)
                .attr("y1",PAD.top-4).attr("y2",PAD.top+innerH)
                .attr("stroke","rgba(255,255,255,0.7)")
                .attr("stroke-width",1)
                .attr("stroke-dasharray","3 2")
            svg.append("text")
                .attr("x",Math.min(wx+3,PAD.left+innerW-1))
                .attr("y",PAD.top-1)
                .attr("fill","rgba(255,255,255,0.75)")
                .attr("font-size",8)
                .attr("text-anchor",wx>PAD.left+innerW*0.7?"end":"start")
                .text(`${this.formatPPM(row.window)} ppm`)
        }

        /* L'AXE DES ppm, EN DESSOUS, et il porte la seule unité du graphique. */
        svg.append("g").attr("transform",`translate(0,${PAD.top+innerH})`)
            .call(d3.axisBottom(x)
                .ticks(Math.max(2,Math.min(5,Math.floor(innerW/60))))
                .tickSize(3)
                .tickFormat(value=>`${this.formatPPM(value)}`))
            .call(group=>group.selectAll("text")
                .attr("fill","rgba(255,255,255,0.6)")
                .attr("font-size",8))
            .call(group=>group.selectAll("line,path")
                .attr("stroke","rgba(255,255,255,0.35)"))
            .call(group=>group.select(".domain").attr("stroke","rgba(255,255,255,0.35)"))

        /* L'AXE DE LA PART, À DROITE: 0, moitié, 100 %. Trois repères, pas
           plus — au-delà, on ne lit plus une courbe, on la devine. */
        const shareAxis=svg.append("g")
            .attr("transform",`translate(${PAD.left+innerW},0)`)
            .call(d3.axisRight(yShare).tickValues([0,0.5,1]).tickSize(0)
                .tickFormat(value=>`${Math.round(value*100)}%`))
        shareAxis.selectAll("text")
            .attr("fill","rgba(255,255,255,0.6)")
            .attr("font-size",8)
            .attr("dx",2)
        shareAxis.select(".domain").remove()

        /* UN POINT PAR TRANCHE, AVEC SA VALEUR: le survol donne le couple
           (ppm, part) sans qu'il faille déduire la courbe à l'œil. */
        svg.append("g").selectAll("circle").data(steps).join("circle")
            .attr("cx",step=>x(step.error))
            .attr("cy",step=>yShare(step.share))
            .attr("r",step=>step.error>0&&step.error<=row.domain+1e-9?1.5:0)
            .attr("fill","#ffffff")
            .append("title")
            .text(step=>step.error===0
                ?"no target yet"
                :`${Math.round(step.share*100)}% of ${row.targets} target(s) within `
                    +`${this.formatPPM(step.error)} ppm`)

        /* LA LECTURE EN CHIFFRES, SOUS L'IMAGE ET DANS L'IMAGE. Elle ne double
           pas la courbe: elle en donne le point médian et les trois seuils de la
           fenêtre, que la courbe ne montre qu'à l'œil. */
        return host
    }

    /* LE RENDU DU PANNEAU, EN UN SEUL ENDROIT.

       Récapitulatif et graphique ensemble, parce qu'ils lisent le même état. Les
       appeler séparément depuis deux endroits différents laisserait
       inévitablement un chemin où l'un est repeint sans l'autre — et un
       récapitulatif qui annonce cent cibles pendant que le graphique en montre
       trente est le défaut le plus coûteux de tous: il ne se remarque qu'en
       comparant les deux. */
    /* DÉMARRE LA BOUCLE D'ANIMATION SI NÉCESSAIRE. */
    startForestAnimation(){
        /* `!= null` couvre `undefined`: sans init explicite le premier appel
           voyait `undefined !== null` et sortait sans jamais boucler. */
        if(this.forestAnimationFrame!=null) return
        const tick=()=>{
            /* Le garde a déjà réservé la frame: ne pas remettre `null` ici,
               sinon un `stop` entre deux frames n'annule plus rien et deux
               `start` concurrents bouclent en double. */
            const done=this.advanceForestAnimation()
            if(!done){
                this.forestAnimationFrame=requestAnimationFrame(tick)
            }else{
                this.forestAnimationFrame=null
            }
        }
        this.forestAnimationFrame=requestAnimationFrame(tick)
    }

    /* ARRÊTE LA BOUCLE D'ANIMATION. */
    stopForestAnimation(){
        if(this.forestAnimationFrame!=null){
            cancelAnimationFrame(this.forestAnimationFrame)
            this.forestAnimationFrame=null
        }
    }

    renderForestOverview(){
        if(!this.forestPlot) return
        this.renderForestRecap()
        this.renderForestPlot()
        /* Force animation check on UPDATED layout (renderForestPlot creates new animated layout). */
        const cached=this.forestLayoutOf
        if(cached?.layout?.animating){
            this.startForestAnimation()
        }else{
            /* Fallback: si on a des graphes sélectionnés mais pas d'animation, forcer le mode animé. */
            if(this.forestSelected.size>0 && this.forestPlotBox){
                this.renderForestPlot()  // recrée le layout animé
                const cached2=this.forestLayoutOf
                if(cached2?.layout?.animating){
                    this.startForestAnimation()
                }else{
                    this.stopForestAnimation()
                }
            }else{
                this.stopForestAnimation()
            }
        }
    }

    buildForestPlan(){
        const asked=Number(this.parameters.forestCharge)
        const charge=Number.isFinite(asked)&&asked>0?Math.abs(asked):0
        /* LE PLAN DE LIAISON, ET IL EST SÉPARÉ DU PLAN D'ATTRIBUTION.

           On ne peut pas prendre `this.plan`: ses briques viennent de la liste de
           gauche, et c'est précisément ce qu'on veut pouvoir ignorer. On bâtit
           donc un PLAN PROPRE à partir de la liste de droite — avec le même
           constructeur, donc les mêmes lectures, les mêmes diagnostics et les
           mêmes règles d'isotopes, sans rien réécrire.

           AUCUN ADDUCT ICI, et c'est délibéré: une référence sert à comparer des
           ÉCARTS de m/z, et un adduit porte une charge, pas un incrément de
           masse. `chargeAuto` est donc désactivé et les bornes mises à 0 — une
           brique de masse n'a pas de charge, et c'est le seul moyen d'éviter
           qu'un plan sans adduct hérite d'un `chargeSet` qui n'a aucun sens
           ici. */
        const groups=this.forestGroupList()
        let bricks=null
        const diagnostics=[]
        if(!groups.length){
            diagnostics.push("no group to link with: add one above, or the network has no reference")
        }
        if(this.loadedTable){
            try{
                bricks=buildPlan({
                    combining:groups,
                    ionising:[],
                    ratio:1,
                    chargeMin:0,chargeMax:0,
                    chargeAuto:false,
                    table:this.loadedTable
                })
                diagnostics.push(...bricks.diagnostics)
            }catch(error){
                /* UNE LISTE ILLISIBLE EST UNE PANNE DE LECTURE, pas de
                   physique: le panneau doit rester affichable et le dire, sinon
                   l'utilisateur croit que l'application est cassée alors que
                   c'est sa liste qui l'est. */
                diagnostics.push(`the groups to link could not be read: ${error.message}`)
                bricks=null
            }
        }else{
            diagnostics.push("the periodic table is still loading — no reference mass yet")
        }
        this.forestLinkPlan=bricks
        this.forestPlan=forestStandards(bricks??{items:[]},{charge})
        /* La liste des charges ATTEIGNABLES est affichée quand le champ est à 0,
           parce que c'est elle qui décide de la division: sans cette ligne,
           « 0 » se lirait « charge nulle » alors qu'il veut dire « celle du
           plan ». */
        if(this.forestChargeLabel){
            const derived=charge>0
                ?`${charge}+ assumed — the references are divided by ${charge}`
                :`from the plan: |z| in {${this.plan?.chargeSet?.join(", ")??"none"}}, `+
                 `references divided by the charge read there`
            this.forestChargeLabel.textContent=derived
            this.forestChargeLabel.title=charge>0
                ?"you pinned the charge; the plan's own window is ignored here"
                :"the plan decides, so the network follows the adduct lists"
        }
        return this.forestPlan
    }

    /* TEMPS 2 — LE GROS CALCUL, par le worker.

       Un worker et un noyau Rust, comme le crible: le thread principal reste
       libre pendant que l'arbre se construit, et le panneau peut afficher ce
       qu'il est en train de faire au lieu de figer.

       LE REPLI EST LE MÊME CALCUL. Si le wasm est absent ou périmé, ou si le
       worker tombe, on repasse par `growForest` — l'ORACLE du test de parité,
       donc exactement le même arbre, pas une approximation. Un repli « approché »
       laisserait deux physiques dans le programme, et celle qui répondrait serait
       celle qu'on ne testerait pas. */
    async growForestAsync(wave,standards,cut=0){
        const half=wave.size/2
        const x=new Float64Array(half)
        const y=new Float64Array(half)
        if(wave.core.length>=wave.size){
            for(let i=0;i<half;i++) x[i]=wave.core[i]
            for(let i=0;i<half;i++) y[i]=wave.core[i+half]
        }
        const points=new SortedPoints(x,y)
        /* LE NOYAU VEUT DES MASSES TRIÉES, et il ne les trie pas lui-même:
           payer un tri par appel serait le poste qu'il existe pour supprimer.
           `SortedPoints` est donc construit ICI et non au resolve — le réseau
           a ses propres réglages, il ne dépend pas du crible. */
        const tolerance=Number(this.parameters.forestTolerance)
        const degreeMax=Number(this.parameters.forestDegreeMax)
        const payload={params:{
            masses:Array.from(points.order.map(index=>points.x[index])),
            intensities:Array.from(points.order.map(index=>points.y[index])),
            standards:standards.masses,
            tolerance:Number.isFinite(tolerance)&&tolerance>0?tolerance:DEFAULT_LINK_TOLERANCE,
            /* LE DEGRÉ EST UN COMPTE, ET IL EST ARRONDI ICI, AU DERNIER ENDROIT
           AVANT LE NOYAU. C'est la seule ligne par où la valeur entre dans le
           calcul, donc elle ferme tous les chemins d'un coup: la saisie, la
           restauration de session, un appel programmatique.

           Pourquoi c'est nécessaire: le noyau borne un sommet par
           `degree_max as usize`, et Rust tronque vers zéro. Une valeur entre 0
           et 1 passe le test « > 0 » — donc les deux circuits croient tous deux
           qu'un plafond est demandé — puis tronque à 0. Et là les deux langages
           lisent ce 0 à l'opposé: `Some(0)` en Rust est un plafond de zéro, donc
           AUCUNE arête n'est gardée et le réseau ressort vide; `if(cap && …)`
           en JS voit un 0 falsy, donc le plafond est désactivé et toutes les
           arêtes sont gardées. Même réglage, réseau vide en wasm et réseau
           complet en repli JS.

           Le champ arrondit déjà à la saisie, ce qui est ce que voit l'utilisateur
           et ce qui évite d'afficher une valeur que le calcul n'utilise pas.
           Cette ligne est la DERNIÈRE garantie, pas la première. */
            degreeMax:Number.isFinite(degreeMax)&&degreeMax>0?Math.trunc(degreeMax):0,
            /* LA COUPURE PART AU NOYAU, et non au retour: c'est le noyau qui
               possède les poids triés, donc lui seul peut dire « prends les N
               meilleurs » sans les renvoyer d'abord pour être recoupés. */
            limit:Number.isFinite(cut)&&cut>0?cut:0
        }}
        let forest=null
        try{
            const answer=await computePool.run("attributionForest",payload)
            forest=answer?.forest??null
            if(!forest) throw new Error(answer?.fallback??"le noyau n'a rien rendu")
        }catch(error){
            /* LE MOTIF EST NOMMÉ, puis on retombe — comme pour le crible. */
            console.warn("[network] kernel unavailable, JS fallback:",error)
            forest=growForest(payload.params)
        }
        return {forest,points}
    }

    /* TEMPS 3 — LA LECTURE, et elle est FAITE ICI, pas dans le panneau.

       Le noyau rend des tableaux; l'écran veut des lignes. La conversion vit
       dans `forestComponents` — donc dans un fichier testable sans DOM — et le
       panneau ne fait que les peindre. C'est le découpage que
       `collectionReader.test.mjs` a établi pour la moitié DOM du programme. */
    async startForest({keepCut=false}={}){
        const run=++this.forestRun
        /* LA COUPURE EST UN RANG DE POIDS, PAS UNE INDICE DE COMPOSANT.

           Le noyau trie les candidats par erreur croissante, donc « garder les
           N premiers» et « garder les N meilleurs» sont la même chose — et c'est
           ce second sens qui a un sens physique. */
        if(!keepCut) this.forestCut=0
        this.forestBusy=true
        const {waves,skipped}=this.collectInputWaves()
        this.forestSkipped=skipped
        if(!this.plan?.items?.length||!waves.length){
            this.forests=[]
            this.forestComponents=[]
            this.forestErrors=[waves.length
                ?[]
                :["nothing to link: no XY wave is connected"]]
            this.renderForestButton(false)
            this.renderForest()
            return
        }
        this.renderForestButton(true)
        const standards=this.buildForestPlan()
        if(!standards.masses.length){
            /* AUCUNE RÉFÉRENCE EST UN CAS NORMAL, pas une panne: une liste de
               groupes vide, ou une table pas encore arrivée. Le panneau le dit
               et le bouton reste visible — c'est le même traitement que la
               sonde de masse, qui répond « loading… » au lieu de se taire. */
            this.forests=[]
            this.forestComponents=[]
            this.forestErrors=[...standards.diagnostics]
            this.renderForest()
            this.renderForestButton(false)
            return
        }
        const forests=[]
        const components=[]
        const errors=[...standards.diagnostics]
        for(let i=0;i<waves.length;i++){
            if(run!==this.forestRun) return
            if(i>0) await new Promise(resolve=>setTimeout(resolve,0))
            if(run!==this.forestRun) return
            const wave=waves[i]
            const title=wave.metadata?.title??`input ${i+1}`
            try{
                const {forest,points}=await this.growForestAsync(wave,standards,this.forestCut)
                forests.push(forest)
                /* LA COURBE VIENT AVEC L'ARBRE, donc elle ne peut pas dater d'un
                   autre calcul: elle est rendue par le même appel sur le même
                   préfixe trié. On ne la prend qu'au PREMIER lot — sinon deux
                   spectres se disputeraient la même courbe, et le curseur
                   couperait un graphe avec la courbe de l'autre. */
                if(i===0){
                    this.forestWeights=forest.weights??[]
                    this.forestSuggestion=suggestWeightCut(this.forestWeights)
                }
                components.push({
                    title,
                    points,
                    components:forestComponents(forest,standards)
                })
            }catch(error){
                /* UN SPECTRE QUI ÉCHOUE N'ARRÊTE PAS LES AUTRES. Un réseau
                   cassé est un résultat cassé, pas un nœud mort. */
                const message=error?.message??String(error)
                errors.push(`${title}: ${message}`)
                forests.push(null)
                components.push({title,points:null,components:[]})
            }
        }
        if(run!==this.forestRun) return
        /* LA COUPURE SUGGÉRÉE EST APPLIQUÉE TOUTE SEULE, ET UNE SEULE FOIS.

           C'est ce que faisait Igor: son `kruskal4mass` s'arrêtait sur son critère
           statistique, donc l'arbre qui en sortait était DÉJÀ coupé, et la
           marche sur la courbe servait à comprendre pourquoi — pas à la
           provoquer. Sans cela, un vrai spectre donne un réseau où presque tout
           est relié, et la liste des groupes n'apprend rien.

           Elle n'est appliquée que si le détecteur a trouvé une VRAIE marche
           (`index` strictement entre 0 et le nombre de liens): « aucune marche
           saillante » et « pas assez de liens » rendent le compte entier, donc
           la condition les écarte d'elle-même. */
        if(await this.autoApplyForestCut(keepCut)){
            return
        }
        this.forests=forests
        this.forestComponents=components
        this.forestErrors=errors
        /* NOUVEAU RÉSEAU = NOUVELLES RANGES: on efface la sélection ET les merges.
           Un merge est une opération JS par-dessus le réseau du noyau: un
           nouveau « Grow network » régénère l'état brut. */
        this.forestSelected.clear()
        this.forestMerges?.clear()
        this.renderForestButton(false)
        this.forestBusy=false
        this.renderForest()
    }

    /* LA COUPURE AUTOMATIQUE, ET ELLE EST UN SECOND PASSAGE.

       Le noyau rend la courbe ENTIÈRE même quand il est coupé — c'est elle qui
       montre où l'on coupe — donc il faut d'abord le calculer pour connaître la
       marche, puis le recalculer pour l'appliquer. Deux appels au noyau, donc:
       le second est le seul qui publie, et il est marqué `keepCut` pour ne pas
       boucler.

       On ne l'économiserait qu'en rejouant seulement l'union-find sur la courbe
       déjà rendue; le noyau ne rend pas son état interne, et surtout ce
       chemin-là ne serait testé que par lui-même. Deux appels, c'est le prix
       d'un seul chemin de calcul. */
    async autoApplyForestCut(keepCut){
        if(keepCut) return false
        const suggestion=this.forestSuggestion
        const weights=this.forestWeights??[]
        if(!suggestion) return false
        if(!(suggestion.index>0&&suggestion.index<weights.length)) return false
        this.forestCut=suggestion.index
        /* ON SE SOUVIENT QUE C'EST LE PROGRAMME QUI A COUPÉ, parce que la ligne
           du dessous le dira. Écrire « coupure à la marche détectée » sans dire
           qui l'a posée laisserait croire que l'utilisateur l'a choisie — et il
           vient de le voir apparaître. */
        this.forestCutAutomatic=true
        await this.startForest({keepCut:true})
        return true
    }

    /* LE BOUTON PENDANT LE CALCUL, et il le dit sur lui-même.

       Un bouton qu'on peut recliquer pendant qu'il travaille fait planter
       le nœud si le calcul est lent, et un bouton muet laisse croire qu'un
       second appui serait sans effet — les deux sont le même défaut, vu
       d'endroits différents. */
    renderForestButton(busy){
        const button=this.forestButton
        if(!button) return
        button.textContent=busy?"growing…":"Grow network"
        button.disabled=!!busy
        button.style.opacity=busy?"0.6":"1"
        button.title=busy
            ?"building the minimum spanning forest — the worker is on it"
            :"link the measured peaks whose m/z gap matches a reference mass"
    }

    /* LE CURSEUR, GLISSÉ, ET L'ARBRE RECALCULÉ AU RELÂCHEMENT.

       Le calcul est refait à chaque relâchement, jamais pendant le glissement:
       un noyau par pixel déplacé transformerait un geste de lecture en calcul
       de plusieurs secondes. Pendant le geste on ne dessine que le trait — ce
       qui est instantané — et le panneau ne change de contenu qu'à la fin.

       LE GESTE EST UN CLICK, PAS UN DRAG, et c'est délibéré: sur une courbe de
       cinq mille points, viser un rang au pixel près est faisable; viser une
       VALEUR au pixel près, non. Un glissement ajoute donc de la précision et
       retire de la certitude — et l'utilisateur voit où il coupe. */
    /* LA GÉOMÉTRIE DE LA COURBE, CALCULÉE UNE SEULE FOIS, POUR LES DEUX SENS.

       Dessiner et lire sont deux conversions inverses de la même chose, et
       elles doivent employer les mêmes nombres. Écrites chacune de leur côté,
       elles divergent — et c'est un curseur décalé: la marge de gauche vaut
       10 % dans le dessin, elle doit valoir 10 % dans le curseur.

       L'ERREUR QU'ELLE RÉPARE: `rankAt` mélangeait des FRACTIONS et des
       PIXELS dans une même expression — `box.width - forestPlotLeft`, où
       `forestPlotLeft` vaut 0.10 sans unité. Le résultat ne mesurait rien, le
       long « usable » se simplifiait en à-peu-près la largeur totale, et le
       curseur ignorait la marge: en décalé d'un maximum à gauche, exact au
       bord droit, donc un décalage qui BOUGE — qui se lit comme un bug, pas
       comme une imprécision.

       LA BOÎTE EST LA ZONE DE FOND ET PAS LA BORDURE: le bitmap n'occupe que
       le content box, alors que `getBoundingClientRect()` rend le border box.
       Mesurer depuis celui-là ajoute l'épaisseur de la bordure à l'origine —
       un pixel — et emploie une largeur qui n'est pas celle du dessin. */
    forestCurveGeometry(){
        const canvas=this.forestCanvas
        if(!canvas) return null
        const rect=canvas.getBoundingClientRect()
        const width=Math.max(80,Math.round(canvas.clientWidth||rect.width))
        const height=Math.max(80,Math.round(canvas.clientHeight||rect.height))
        const left=this.forestPlotLeft*width
        const usable=Math.max(1,width-left-this.forestPlotRight*width)
        return {rect,width,height,left,usable,x0:rect.left+(canvas.clientLeft??0)}
    }

    wireForestCursor(){
        const canvas=this.forestCanvas
        if(!canvas) return
        let dragging=false
        const rankAt=event=>{
            const weights=this.forestWeights
            if(!weights?.length) return null
            /* L'INVERSE EXACT DE `xOf`, ET RIEN D'AUTRE: mêmes marges, même
               largeur, même unité, lues à l'endroit même où le dessin les lit.
               C'est ce partage qui empêche les deux de diverger — une seconde
               écriture du calcul reprendrait aussitôt le décalage. */
            const geometry=this.forestCurveGeometry()
            if(!geometry) return null
            const along=(event.clientX-geometry.x0-geometry.left)/geometry.usable
            return Math.round(Math.max(0,Math.min(1,along))*(weights.length-1))
        }
        canvas.addEventListener("pointerdown",event=>{
            if(!this.forestWeights?.length) return
            dragging=true
            canvas.setPointerCapture?.(event.pointerId)
            const rank=rankAt(event)
            if(rank!==null) this.drawForestCurve(rank)
        })
        canvas.addEventListener("pointermove",event=>{
            if(!dragging) return
            const rank=rankAt(event)
            if(rank!==null) this.drawForestCurve(rank)
        })
        const finish=event=>{
            if(!dragging) return
            dragging=false
            const rank=rankAt(event)
            if(rank!==null) this.setForestCut(rank)
        }
        canvas.addEventListener("pointerup",finish)
        canvas.addEventListener("pointercancel",()=>{ dragging=false })
        canvas.addEventListener("dblclick",()=>this.applySuggestedCut())
    }

    /* APPLIQUER UNE COUPURE, et c'est un NOUVEAU CALCUL COMPLET.

       La coupure ne se dessine pas: elle se reconstruit par-dessus le même
       trié, donc Kruskal doit repasser. On pourrait s'économiser ce calcul en
       rejouant seulement l'union-find, mais le noyau ne rend pas son état
       interne — et un « mode rapide » qui ne serait testé que par lui-même
       finirait par diverger du chemin normal. Le coût est celui d'un appel de
       plus, et le noyau est fait pour ça. */
    async setForestCut(rank){
        if(this.forestBusy) return
        this.forestCut=Math.max(1,Math.round(rank))
        /* ICI C'EST L'UTILISATEUR, même s'il reprend la suggestion par un
           double-clic: la ligne du dessous dira qu'il l'a posée lui-même, et
           non que le programme l'a trouvée. */
        this.forestCutAutomatic=false
        await this.startForest({keepCut:true})
    }

    /* LA COUPURE SUGGÉRÉE, et elle s'applique en UN geste.

       Le bouton n'est pas « appliquer la suggestion » mais le double-clic sur
       la courbe: couper est un réglage, et un réglage se pose là où se lit la
       chose qu'il règle. Le bouton, lui, reste « Grow network ». */
    applySuggestedCut(){
        if(!this.forestSuggestion) return
        this.setForestCut(this.forestSuggestion.index)
    }

    /* LES MARGES DU DESSIN, et elles sont SUR LE NŒUD, pas dans le dessin.

       Le curseur doit convertir un pixel en rang, et cette conversion doit
       employer les mêmes marges que le tracé. Les garder dans une variable
       d'instance plutôt que dans le corps du dessin, c'est la seule façon que
       les deux ne divergent pas — et un curseur décalé d'une marge se lit
       comme un calcul faux, pas comme un graphique mal aligné. */
    forestPlotLeft=0.10
    forestPlotRight=0.01

    /* LE CODE COULEUR, ET CE SONT LES COULEURS DE L'APPLICATION.

       Rien n'est inventé ici. Le vert est l'accent lime des dossiers
       (`--accent`, `rgba(172,255,47,·)`), le blanc est le texte (`--text`), le
       bleu est celui des listes ionisantes et du champ de sonde
       (`rgba(120,180,255,·)`). Le rouge ne vient pas de la palette — c'est le
       seul ajout, et il est justifié : il ne sert qu'à montrer ce que la
       coupure a JETÉ, donc il doit être la seule couleur que le reste du
       panneau n'emploie pas.

       LA RÉPARTITION: la DONNÉE est verte, la DÉCISION est bleue, ce qui est
       ÉLIMINÉ est rouge. Trois rôles, trois couleurs, et aucune n'est
       ambivalente — un trait qui change de couleur selon qu'on l'a choisi ou
       suggéré serait illisible. */
    forestColors={
        curve:"#aef22e",           // --accent, le lime des dossiers
        suggestion:"#dfe6ee",      // --text, le blanc des libellés
        cut:"#78b4ff",             // rgba(120,180,255), les listes ionisantes
        discarded:"#d9534f",       // ce que la coupure a jeté
        wash:"rgba(217,83,79,0.10)"
    }

    /* LE DESSIN, et il ne dépend que du NŒUD.

       Tout ce qu'il lui faut — la courbe, la coupure en cours, celle que le
       détecteur suggère — vit sur le nœud. Il n'a donc aucun état propre, et un
       redessin demandé par un réglage ne peut pas afficher la courbe d'un ancien
       calcul: il n'y a rien d'autre à afficher. */
    drawForestCurve(dragRank=null){
        const canvas=this.forestCanvas
        if(!canvas) return
        const weights=this.forestWeights??[]
        const ratio=window.devicePixelRatio??1
        /* LA MÊME GÉOMÉTRIE QUE LE CURSEUR — c'est le principe de la méthode:
           largeur, marge et origine se lisent UNE fois, et le trait comme la
           croix s'en servent tous les deux. */
        const geometry=this.forestCurveGeometry()
        if(!geometry) return
        const {width,height,left,usable}=geometry
        /* LE CANVAS EST MIS À L'ÉCHELLE DU DISPOSITIF, sinon la courbe est
           floue sur tout écran à haute densité — et une courbe floue fait poser
           le curseur au mauvais pixel. */
        if(canvas.width!==Math.round(width*ratio)||canvas.height!==Math.round(height*ratio)){
            canvas.width=Math.round(width*ratio)
            canvas.height=Math.round(height*ratio)
        }
        const ctx=canvas.getContext("2d")
        ctx.setTransform(ratio,0,0,ratio,0,0)
        ctx.clearRect(0,0,width,height)
        if(!weights.length){
            ctx.fillStyle="rgba(255,255,255,0.45)"
            ctx.font="11px system-ui, sans-serif"
            ctx.textAlign="center"
            ctx.fillText("no link yet — press Grow network",width/2,height/2)
            return
        }
        /* (largeur, marge et course: forestCurveGeometry, au-dessus) */
        /* L'ÉCHELLE LOG, ET LE PLANCHER N'EST PAS UN DÉTAIL DE DESSIN.

           Les erreurs vont de 1e-7 à 1 Da: six ordres de grandeur, donc une
           échelle linéaire écraserait tout le bas de la courbe — et le bas est
           justement ce qui distingue un lien crédible d'un lien au hasard. Le
           plancher est le plus petit poids NON NUL, ramené d'un cran: un zéro
           exact n'a pas de logarithme, et le plateau du FT-ICR doit quand même se
           voir — au plancher, ce qui est honnête plutôt que flatteur. */
        const positive=weights.filter(weight=>Number.isFinite(weight)&&weight>0)
        const smallest=positive.length?Math.min(...positive):1e-6
        const floor=smallest/10
        const top=Math.max(...positive,smallest*10)
        const decades=Math.max(1,Math.log10(top/floor))
        const yOf=weight=>{
            const value=Number.isFinite(weight)&&weight>0?weight:floor
            return height-3-((Math.log10(Math.max(value,floor))-Math.log10(floor))/decades)*(height-6)
        }
        const xOf=rank=>left+(weights.length<2?usable/2:(rank/(weights.length-1))*usable)
        /* LE TRACE, en DEUX PASSES, et c'est ce qui rend la coupure lisible.

           La courbe est tracée d'abord en vert jusqu'à la coupure, puis en rouge
           au-delà — donc on VOIT ce que le réseau a refusé, sans avoir à lire un
           nombre. Un trait d'une seule couleur obligeait à compter les points,
           et un remplissage de la moitié gardée colorait le graphique entier.

           Le pas s'adapte à la largeur: au-delà de deux points par pixel, on en
           saute. Cela change l'allure, jamais le classement — donc jamais la
           coupure, ni le curseur, qui travaillent sur `weights` et pas sur ce qui
           est tracé. */
        const cut=this.forestDrawCut??this.forestCut??weights.length
        const kept=Math.max(0,Math.min(cut,weights.length))
        /* LE LAVAGE ROUGE, avant les traits: il doit passer SOUS la courbe,
           sinon il l'efface — et c'est la courbe qu'on vient lire. */
        if(kept<weights.length){
            const x=xOf(kept)
            ctx.fillStyle=this.forestColors.wash
            ctx.fillRect(x,0,width-x,height)
        }
        const stride=Math.max(1,Math.ceil(weights.length/usable))
        const strokeRange=(from,to,color)=>{
            if(!(to>from)) return
            ctx.strokeStyle=color
            ctx.lineWidth=1
            ctx.beginPath()
            let first=true
            for(let rank=from;rank<to;rank+=stride){
                const x=xOf(rank)
                const y=yOf(weights[rank])
                if(first){ ctx.moveTo(x,y); first=false }
                else ctx.lineTo(x,y)
            }
            /* LE DERNIER POINT DE LA PASSE EST DESSINÉ QUOI QU'IL ARRIVE: sans
               lui la courbe s'arrête un cran avant sa fin, et la fin est
               justement la partie qui regarde le texte — « ces liens-là, on ne
               les croit pas ». */
            const x=xOf(to-1)
            const y=yOf(weights[to-1])
            if(first) ctx.moveTo(x,y)
            else ctx.lineTo(x,y)
            ctx.stroke()
        }
        strokeRange(0,kept,this.forestColors.curve)
        strokeRange(kept,weights.length,this.forestColors.discarded)
        this.drawForestMarks(ctx,{xOf,yOf,width,height,left,usable})
    }

    /* LES MARQUES: LA COUPURE, ET LA MARCHE SUGGÉRÉE.

       Deux traits et non un, parce que ce sont deux choses: le trait VERT est ce
       que le curseur a choisi, le CERCLE est ce que le détecteur proposerait. Ils
       se confondent quand l'utilisateur accepte la suggestion — et c'est la
       bonne nouvelle, pas un défaut: la ligne verte s'est posée exactement là où
       l'algorithme voyait la même marche. */
    drawForestMarks(ctx,{xOf,yOf,width,height,left,usable}){
        const weights=this.forestWeights??[]
        const suggestion=this.forestSuggestion
        const cut=this.forestDrawCut??this.forestCut??weights.length
        /* LE CERCLE, D'ABORD, POUR QU'IL RESTE VISIBLE SOUS LE TRAIT. */
        if(suggestion&&suggestion.index<weights.length&&suggestion.index>0){
            const x=xOf(suggestion.index)
            const y=yOf(weights[suggestion.index])
            ctx.strokeStyle=this.forestColors.suggestion
            ctx.lineWidth=1.5
            ctx.beginPath()
            ctx.arc(x,y,5,0,2*Math.PI)
            ctx.stroke()
        }
        if(cut>0&&cut<weights.length){
            const x=xOf(cut)
            ctx.strokeStyle=this.forestColors.cut
            ctx.lineWidth=1.5
            ctx.beginPath()
            ctx.moveTo(x,0)
            ctx.lineTo(x,height)
            ctx.stroke()
        }
        /* LES GRADUATIONS, deux en suffisent: le nombre de liens, et l'ordre de
           grandeur de l'erreur. Un axe de plus serait de l'encre pour rien — le
           lecteur veut savoir « combien » et « à quel niveau », pas lire une
           échelle logarithmique entière. */
        ctx.fillStyle="rgba(255,255,255,0.55)"
        ctx.font="9px system-ui, sans-serif"
        ctx.textAlign="left"
        ctx.fillText(`${weights.length}`,left,height-1)
        ctx.textAlign="right"
        ctx.fillText(`${weights.length-1}`,width-this.forestPlotRight*width,height-1)
        ctx.textAlign="left"
        ctx.fillText(this.forestCurveTopLabel??"",left+1,9)
    }

    /* LA LISTE DES GROUPES DE LIAISON, et elle est le MIROIR de celle de gauche.

       Même cadre, même police, même bouton de suppression: une liste qu'on lit
       différemment des deux côtés de l'écran ferait douter le lecteur sur ce qui
       est réglé où. Trois colonnes disparaissent, et c'est le fond de la
       différence:

       — `min`/`max` n'ont pas de sens ici. Une référence sert à comparer des
         écarts, pas à compter des occurrences: borner un lien à « au moins
         deux » n'aurait aucun effet, donc une case qui n'en a pas est une case
         qui ment.
       — `ratio` non plus, dans la forme où il est présenté à gauche. Il
         ouvrirait les isotopes d'un groupe, donc il changerait la liste de
         liens — or c'est ici que la liste EST le réglage. Un isotope
         supplémentaire ne se règle pas dans une case de la ligne: il s'ajoute
         comme une ligne, avec son nom.

       La ligne est donc formule + suppression, et les DEUX blocs isotopiques
       possibles d'un même groupe apparaissent en dessous, comme à gauche: c'est
       ce qui dit si « 13C » a été écrit ou si le groupe n'en a qu'un. */
    forestGroupList(){
        /* `readGroups` est la MÊME lecture que celle de gauche, donc une
           session ancienne — qui portait une chaîne — se relit ici sans
           migration. Elle donne aussi les défauts par groupe, et ces défauts
           n'ont aucun effet: ils servent à `buildPlan`, qui a besoin d'un
           `{min,max,ratio}` même quand personne ne les saisit. */
        return this.readGroups(this.parameters.forestGroups,"combining")
    }

    renderForestGroupTable(){
        const table=this.forestGroupTable
        if(!table) return
        table.rows.replaceChildren()
        const groups=this.forestGroupList()
        if(!groups.length){
            const empty=CE("div",{},["— no group to link with —"])
            stylize(empty,{fontSize:"0.8em",opacity:"0.5",padding:"2px"})
            table.rows.appendChild(empty)
            return
        }
        groups.forEach((entry,index)=>{
            table.rows.appendChild(this.drawForestGroupRow(entry,index))
        })
    }

    drawForestGroupRow(entry,index){
        const row=CE("div",{},[])
        stylize(row,{
            display:"grid",gap:"3px",alignItems:"center",
            gridTemplateColumns:"1fr 1.6em"
        })
        const name=CE("span",{},[String(entry.group)])
        stylize(name,{
            fontSize:"0.85em",fontFamily:"monospace",overflow:"hidden",
            textOverflow:"ellipsis",whiteSpace:"nowrap"
        })
        name.title=entry.group
        row.appendChild(name)
        const remove=CE("button",{type:"button",title:"Stop using this group to link"},["✕"])
        stylize(remove,{
            fontSize:"0.8em",lineHeight:"1",padding:"2px",cursor:"pointer",
            color:"inherit",background:"rgba(255,255,255,0.08)",
            border:"1px solid rgba(255,255,255,0.15)",borderRadius:"2px"
        })
        remove.addEventListener("click",()=>{
            const groups=this.forestGroupList()
            if(!groups[index]) return
            groups.splice(index,1)
            this.commitForestGroups(groups)
        })
        row.appendChild(remove)
        /* LES BLOCS ISOTOPIQUES, sur la rangée du dessous et en pleine largeur,
           comme à gauche. Sans eux, écrire « 13C » ne se distinguerait pas d'une
           coquille: le groupe le plus probable serait pris, silencieusement. */
        const blocks=this.forestIsotopeBlocks(index)
        const listing=CE("div",{},[
            blocks.length
                ? blocks.map(block=>block.notation).join("  ·  ")
                : "— no isotope block —"
        ])
        stylize(listing,{
            gridColumn:"1 / -1",minWidth:0,
            fontSize:"0.72em",fontFamily:"monospace",opacity:"0.72",
            paddingTop:"1px",paddingBottom:"3px",lineHeight:"1.5",
            wordBreak:"break-word",textAlign:"left"
        })
        listing.title=blocks.length
            ? blocks.map(block=>`${block.notation} — ${block.mass.toFixed(4)} Da`).join("\n")
            : "this group produced no mass: check its spelling"
        row.appendChild(listing)
        return row
    }

    /* LES BRIQUES D'UNE LIGNE DE LIAISON, lues sur le plan DE LIAISON.

       `this.plan` est le plan d'attribution et ne dit rien de cette liste;
       lire ses briques ici afficherait les groupes de gauche sous la liste de
       droite — c'est-à-dire l'erreur exacte que la liste autonome existe pour
       éviter. */
    forestIsotopeBlocks(index){
        const key=`combining#${index}`
        const source=this.forestLinkPlan?.combinables??[]
        return source
            .filter(block=>block.groupIndex===key)
            .map(block=>({
                notation:prettyNotation(block.notation),
                key:block.key,
                mass:block.atomicMass
            }))
    }

    /* AJOUTER OU RETIRER UN GROUPE DE LIAISON.

       Le réseau n'est PAS relancé: une liste de groupes change les masses de
       référence, donc elle change l'arbre — mais l'arbre ne se lit qu'après un
       « Grow network », comme le reste du panneau. Relancer ici viderait la
       courbe et la liste à chaque frappe, et l'utilisateur verrait un panneau
       clignoter au lieu de voir sa liste.

       Le réseau reste donc marqué comme à recalculer, ce qui est exactement ce
       que le nœud sait dire. */
    commitForestGroups(groups){
        this.parameters.forestGroups=groups
        this.renderForestGroupTable()
        this.refreshForestPlan()
    }

    addForestGroup(value){
        const text=String(value??"").trim()
        if(!text) return
        const groups=this.forestGroupList()
        groups.push({group:text})
        this.commitForestGroups(groups)
        if(this.forestGroupInput) this.forestGroupInput.value=""
    }
    /*   il rend le résultat. Les réglages y sont parce qu'ils bornent l'arbre, et
       ils sont donc dans la même colonne que lui — mais le LECTEUR est le
       bouton, la courbe et la liste, pas les cases. */
    /* LE PANNEAU DU RÉSEAU, et il ne fait qu'une chose de plus que le gauche:
       il rend le résultat. Les réglages y sont parce qu'ils bornent l'arbre, et
       ils sont donc dans la même colonne que lui — mais le LECTEUR est le
       bouton, la courbe et la liste, pas les cases.

       L'ORDRE EST CELUI DE LA DÉCISION: d'abord QUOI relier, ensuite À QUELLE
       PRÉCISION, enfin COMBIEN de liens. C'est l'ordre dans lequel on se pose
       les questions, et il place la liste juste au-dessus des bornes comme tu
       l'as demandé. */
    forestLinkTable(content,label){
        const box=CE("div",{className:"an-group-table"},[])
        const caption=CE("div",{className:"an-caption"},[label])
        const rows=CE("div",{className:"an-group-rows"},[])
        stylize(caption,{fontSize:"0.8em",opacity:"0.85"})
        stylize(box,{
            display:"flex",flexDirection:"column",gap:"3px",
            padding:"5px 6px 6px",
            border:"1px solid rgba(255,255,255,0.14)",borderRadius:"4px",
            background:"rgba(255,255,255,0.025)",
            marginBottom:"8px"
        })
        /* LE TITRE DIT À QUOI ÇA SERT, parce que deux listes de groupes sur un
           même écran ne se devinent pas: celle de gauche décide des FORMULES,
           celle-ci des LIENS. */
        caption.title="The masses used to link two measured peaks. Independent of the combining groups: link on CH2 only while attributing with the full set"
        box.append(caption,rows)
        content.appendChild(box)
        return {box,rows}
    }

    setupForestPanel(){
        if(!this.forestAccordion) return
        const content=this.forestAccordion.DOMelt.content
        content.replaceChildren()
        this.forestAccordion.setSizingMode("content")
        /* LE GRAPHE N'EST PLUS ICI: il vit dans sa fenêtre centrale.
           Il est repeint par `renderForest()`, qui est le seul endroit où l'état
           du réseau change. */
        stylize(content,{
            display:"grid",
            "grid-template-columns":"minmax(0, 1fr)",
            padding:"4px",
            gap:"4px"
        })
        /* LA LISTE D'ABORD: le champ d'ajout, puis le cadre, comme à gauche où
           le champ est AU-DESSUS de sa liste et non à côté — les deux se lisent
           ensemble parce qu'ils font deux gestes différents. */
        this.forestGroupInput=this.field(content,
            "Add a group to link",
            "",
            {onCommit:(value)=>this.addForestGroup(value)},
            "CH2, NH, O, 13C... Adds one row to the table below. Enter applies it. This list is INDEPENDENT of the combining groups on the left: it decides what links peaks, not what formulas are attributed"
        )
        this.forestGroupTable=this.forestLinkTable(content,"Groups to link")
        this.renderForestGroupTable()

    /* LES TROIS RÉGLAGES SUR DEUX RANGÉES, parce qu'ils vont par paires.

           La fenêtre et le plafond sont tous deux des bornes de l'arbre, et les
           poser l'un sous l'autre les ferait passer pour une hiérarchie. La
           charge vient ensuite: elle se déduit du plan le plus souvent, donc
           elle est lisible et rarement saisie. */
        const bounds=CE("div",{className:"an-row"},[])
        stylize(bounds,{
            display:"grid",
            "grid-template-columns":"1fr 1fr",
            gap:"6px",
            "align-items":"start"
        })
        content.appendChild(bounds)
        this.forestToleranceInput=this.field(bounds,"Link window (Da)",this.parameters.forestTolerance,{
            tag:"number",
            onCommit:(raw)=>this.commitForestNumber("forestTolerance",raw,0,100)
        },"How close two peaks must be to a reference mass to be linked. Igor used 0.5 as a constant; here it is a setting, because it is a geometry and not a physics")
        this.forestDegreeMaxInput=this.field(bounds,"Max degree",this.parameters.forestDegreeMax,{
            tag:"number",
            onCommit:(raw)=>this.commitForestNumber("forestDegreeMax",raw,0,8,true)
        },"How many links one peak may hold. 0 = no limit (Igor's GrowForest); 2 gives a chain, Igor's GrowReticles")
        this.forestChargeInput=this.field(content,"Charge (0 = the plan's)",this.parameters.forestCharge,{
            tag:"number",
            onCommit:(raw)=>this.commitForestNumber("forestCharge",raw,0,8)
        },"The reference masses are divided by this charge, because a gap of m/z shrinks as the charge grows. Igor compared masses to m/z gaps, which is only right for 1+")
        this.forestChargeLabel=CE("div",{className:"an-charges"},[])
        stylize(this.forestChargeLabel,{fontSize:"0.8em",lineHeight:"1.35"})
        content.appendChild(this.forestChargeLabel)
        /* LE BOUTON, et il EST UN BOUTON, pas un réglage.

           Le réseau est le calcul le plus long du nœud — un crible sur 10 000
           pics — et il ne se lance ni à la frappe ni au resolve: le resolve
           appartient à l'attribution, qui a ses propres sorties. Relancer le
           crible parce qu'on a changé la fenêtre de lien serait du travail
           payé pour un résultat identique, et faire du réseau un effet de bord
           du crible lierait deux questions qui se répondent séparément. */
        this.forestButton=CE("button",{type:"button"},["Grow network"])
        stylize(this.forestButton,{
            fontSize:"0.85em",padding:"3px 10px",cursor:"pointer",
            color:"inherit",background:"rgba(255,255,255,0.08)",
            border:"1px solid rgba(255,255,255,0.2)",borderRadius:"3px"
        })
        this.forestButton.addEventListener("click",()=>this.startForest())
        content.appendChild(this.forestButton)
        /* SELECTION ET FILTRE DES ARBRES.
        
           Une rangée avec: filtre par taille minimale, boutons tout/rien,
           sélecteur de mode de layout. */
        const selectionRow=CE("div",{className:"an-row"},[])
        stylize(selectionRow,{
            display:"grid",
            "grid-template-columns":"1fr 1fr auto auto auto",
            gap:"6px",
            "align-items":"start"
        })
        content.appendChild(selectionRow)
        this.forestMinSizeInput=this.field(selectionRow,"Min tree size",this.forestMinSize,{
            tag:"number",
            onCommit:(raw)=>this.commitForestMinSize(raw)
        },"Only show trees with at least this many vertices")
        this.forestSelectAllBtn=CE("button",{type:"button",title:"Select all visible trees"},["Select all"])
        stylize(this.forestSelectAllBtn,{fontSize:"0.8em",padding:"2px 8px",cursor:"pointer"})
        this.forestSelectAllBtn.addEventListener("click",()=>this.selectAllForestTrees())
        selectionRow.appendChild(this.forestSelectAllBtn)
        this.forestDeselectAllBtn=CE("button",{type:"button",title:"Deselect all trees"},["Deselect all"])
        stylize(this.forestDeselectAllBtn,{fontSize:"0.8em",padding:"2px 8px",cursor:"pointer"})
        this.forestDeselectAllBtn.addEventListener("click",()=>this.deselectAllForestTrees())
        selectionRow.appendChild(this.forestDeselectAllBtn)
        /* LE MERGE, ET IL NE S'ALLUME QU'À PLUSIEURS ARBRES.
           Fusionne les arbres dessinés (les sélectionnés) en chaîne du plus
           grand au plus petit, en reliant leurs racines par leur différence
           stoichiométrique — brique ajoutée au plan si elle n'existe pas.
           La grille repart avec les positions courantes: seul le segment
           ajouté tire, les arbres existants ne repartent pas du cercle. */
        this.forestMergeBtn=CE("button",{type:"button",title:"Merge the selected trees, biggest first: link their roots by stoichiometric difference"},[ "Merge"])
        stylize(this.forestMergeBtn,{fontSize:"0.8em",padding:"2px 8px",cursor:"pointer"})
        this.forestMergeBtn.addEventListener("click",async ()=>{
            this.forestMergeBtn.disabled=true
            this.forestMergeBtn.textContent="merging…"
            try{
                const error=await this.mergeSelectedForests()
                if(error&&this.forestReadout) this.forestReadout.textContent=error
            }finally{
                this.forestMergeBtn.disabled=false
                this.forestMergeBtn.textContent="Merge"
            }
        })
        selectionRow.appendChild(this.forestMergeBtn)
        /* LA COURBE DES POIDS, et c'est ELLE qui rend le résultat lisible.

           Une liste de composants dit QUOI il reste, mais pas POURQUOI on a
           arrêté là: sans la courbe, un groupe de trois pics et un groupe de
           quatorze se lisent de la même façon. La courbe est l'argument — les
           erreurs des liens, triées — et le curseur est la décision.

           Un `<canvas>` 2D, et non le Plot2D du programme: ce n'est pas une
           trace de spectre mais un profil en échelle log avec un curseur, et
           Plot2DWebGL dessine des séries sur des axes, pas une distribution
           d'ordres de grandeur. Le réutiliser ici coûterait plus de code caché
           qu'il n'y en a dans un canvas, et il ne gère pas le glissement du
           curseur. */
        this.forestCanvas=CE("canvas",{className:"an-forest-curve"},[])
        stylize(this.forestCanvas,{
            width:"100%",height:"150px",display:"block",
            background:"rgba(255,255,255,0.04)",
            border:"1px solid rgba(255,255,255,0.15)",
            borderRadius:"3px",cursor:"crosshair",touchAction:"none"
        })
        content.appendChild(this.forestCanvas)
        this.forestCurveLabel=CE("div",{className:"an-forest-label"},[])
        stylize(this.forestCurveLabel,{fontSize:"0.75em",lineHeight:"1.35",opacity:"0.85"})
        content.appendChild(this.forestCurveLabel)
        this.wireForestCursor()
        /* LA LECTURE, et elle est RENDUE TOUTE SEULE quand elle arrive.

           `forest.js` fait la conversion ligne par ligne et `componentLine` la
           met en forme; le panneau ne connaît ni le noyau ni les tableaux, donc
           il ne peut pas se tromper de numérotation — celle que le noyau a
           fixée. */
        this.forestList=CE("div",{className:"an-forest"},[])
        /* LA LISTE EST BRIDÉE À LA MOITIÉ, ET ELLE DÉFILE SEULE.

           Un `50%` ne servirait à rien ici: l'accordéon est en mode « content »,
           sa hauteur est `auto`, et un pourcentage posé sur une hauteur `auto`
           se résout en `none` — la bride n'existerait pas, et on ne verrait pas
           la différence. La colonne de droite, elle, remplit la fenêtre, donc
           `50vh` est la moitié demandée à la marge de l'en-tête près.

           LE DÉFILEMENT EST DANS LE CADRE, pas dans la colonne: `.vertical
           .right.content` a `scrollbar-width:none`, une liste qui déborderait
           serait donc longue sans être navigable. Ici la barre appartient au
           cadre, elle se voit — et le reste du panneau (courbe, lecture,
           réglages) reste à sa place. */
        stylize(this.forestList,{
            display:"grid",gap:"3px",maxHeight:"50vh",overflowY:"auto",minWidth:"0"
        })
        content.appendChild(this.forestList)
        this.forestReadout=CE("div",{style:{
            fontSize:"0.8em",lineHeight:"1.35",whiteSpace:"pre-wrap"
        }},[])
        content.appendChild(this.forestReadout)
        this.renderForest()
    }

    /* UN RÉGLAGE DU RÉSEAU, ET IL NE MARQUE PAS LE CRIBLE.

       Les trois entiers du panneau de droite ne changent rien à l'attribution:
       le resolve produit les formules, et elles ne bougent pas parce qu'on a
       changé la fenêtre d'un lien. Les propager au `needsResolve` du crible
       ferait recalculer des milliers de formules pour un résultat identique,
       et repeindrait le nœud « sale » alors que ses sorties sont à jour — le
       défaut inverse, et tout aussi mensonger. */
/* `integer` distingue les bornes qui sont un COMPTE de celles qui sont une
   MESURE. Ce n'est pas décoratif, c'est ce qui tient les deux circuits
   d'accord: le noyau borne un sommet par `degree_max as usize`, et Rust
   TRONQUE vers zéro. Une valeur entre 0 et 1 — 0,5 — passe le test « > 0 » des
   deux côtés (donc toutes deux croient qu'un plafond est demandé) puis tronque
   à 0. Et là les deux langages lisent ce 0 différemment: en Rust `Some(0)` est
   un plafond de zéro, donc AUCUNE arête n'est gardée et le réseau ressort vide;
   en JS `if(cap && …)` voit un 0 falsy, donc le plafond est désactivé et toutes
   les arêtes sont gardées. Le même réglage donnait un réseau vide en wasm et un
   réseau complet en repli JS. On borne donc à l'ENTIER ici, à la source, pour
   que la valeur qui atteint le noyau soit déjà celle qu'il veut dire.

   La troncature précède la borne, comme dans `commitForestMinSize` juste
   dessous: -2,4 devient -2 puis 0, et non pas borné à 0 deux fois. */
commitForestNumber(name,raw,low,high,integer=false){
    const value=Number(raw)
    const whole=integer&&Number.isFinite(value)?Math.trunc(value):value
    const bounded=Number.isFinite(whole)?Math.min(high,Math.max(low,whole)):low
        if(bounded===this.parameters[name]){
            this.renderForest()
            return
        }
        this.parameters[name]=bounded
        const input=this[`${name.charAt(0).toUpperCase()}${name.slice(1)}Input`]
        if(input) input.value=String(bounded)
        this.renderForest()
    }

    commitForestMinSize(raw){
        const value=Math.max(1,Math.trunc(Number(raw)||1))
        if(value===this.forestMinSize) return
        this.forestMinSize=value
        if(this.forestMinSizeInput) this.forestMinSizeInput.value=String(value)
        this.renderForest()
    }

    selectAllForestTrees(){
        const batches=this.forestComponents??[]
        for(const batch of batches){
            if(!batch?.components?.length) continue
            for(const component of batch.components){
                if(component.size>=this.forestMinSize){
                    this.forestSelected.add(component.rank)
                }
            }
        }
        this.renderForest()
    }

    deselectAllForestTrees(){
        this.forestSelected.clear()
        this.renderForest()
    }

    /* LA LECTURE PEINTE.

       Trois choses et pas une de plus: ce que le réseau est (les références),
       ce qu'il a produit (les composants, classés par taille comme le noyau les
       a classés), et ce qui a été refusé (les diagnostics).

       LE CLIC VA À LA SONDE, et c'est le geste d'Igor: son `TreeListAction`
       prenait la ligne, en faisait un ROI, et attribuait depuis `roipnts[0]`.
       Ici le ROI n'existe pas — ce programme n'a pas d'état global — donc le clic
       fait ce qui existe: il met cette masse dans la SONDE, qui est déjà
       l'outil « quelle formule est-ce? » du nœud. Le clic et la sonde répondent
       donc à la même question, par le même chemin.

       LA LECTURE EST SÉPARÉE DU RÉSEAU, ET C'EST CE QUI REND LE PLAN BON
       MARCHÉ. `forestPlan` n'a qu'un lecteur — le compte des masses de
       référence, ci-dessous — donc rafraîchir ici ne rafraîchit QUE ceci.
    */
    renderForestReadout(){
        if(!this.forestReadout) return
        const lines=[]
        if(this.forestPlan){
            const {masses,labels,charge}=this.forestPlan
            lines.push(masses.length
                ?`${masses.length} reference mass(es) at |z|=${charge}: ${labels.join(", ")}`
                :"no reference mass yet")
        }else{
            lines.push("no reference list yet — press Grow network")
        }
        for(const line of this.forestErrors??[]) lines.push(line)
        if(this.forestSkipped) lines.push(`${this.forestSkipped} input(s) skipped: not an XY wave`)
        for(const batch of this.forestComponents??[]){
            if(!batch) continue
            const forest=this.forestForestOf(batch)
            lines.push(`${batch.title}: ${batch.components.length} component(s)`+
                (forest?.candidates
                    ?`, ${forest.edgeCount} link(s) out of ${forest.candidates} candidates`
                    :""))
        }
        this.forestReadout.textContent=lines.join("\n")
    }

    /* LE PANNEAU ENTIÈR, ET UN SEUL APPEL. Le plan n'y entre pas: la
       lecture ci-dessus le porte toute seule. */
    renderForest(){
        if(!this.forestList) return
        this.renderForestReadout()
        /* LA COURBE EST REDESSINÉE À CHAQUE LECTURE, et c'est gratuit: le
           tracé tient dans un canvas de 300 points et ne fait aucun calcul.
           Elle doit suivre les RÉGLAGES — un changement de fenêtre de lien
           change les poids — donc la peindre à la main serait une deuxième
           vérité à maintenir. */
        this.drawForestCurve(this.forestDrawCut??this.forestCut??null)
        this.renderForestCurveLine()
        /* LES GRAPHES AVANT LA LISTE, ET L'ORDRE EST LE CORRECTIF: `forestRow`
           affiche la masse du sommet racine (`graph.rootIndex`), donc les
           graphes doivent exister avant que la liste ne se peigne — sinon la
           ligne retombe sur `component.rootMass` (la racine Rust) et ment à
           nouveau, pour une seule frame puis pour de bon si rien ne repeint. */
        this.buildForestGraphs()
        this.renderForestList()
        /* LE GRAPHE ET LE RÉCAPITULATIF, ICI ET NULLE PART AILLEURS. C'est
           cette méthode que `startForest` appelle sur chacune de ses
           branches — résultat, aucune référence, plan illisible — donc c'est
           le seul endroit où les deux sont repeints ensemble. */
        this.renderForestOverview()
        /* PUBLIER LES FORMULACOLLECTIONS DES ARBRES SÉLECTIONNÉS (output[1]). */
        this.publishForestCollections()
    }

    /* CRÉER ET PUBLIER LES FORMULACOLLECTIONS POUR LES ARBRES SÉLECTIONNÉS.
    
       Chaque arbre sélectionné génère une FormulaCollection via propagateForest.
       On utilise stateToFormula du plan pour partager la table périodique
       (pas de duplication → pas de session à 85 Mo). */
    async publishForestCollections(){
        if(!this.forestSelected.size) {
            this.outputs[1]=[]
            return
        }
        if(!this.loadedTable) await this.table()
        if(!this.loadedTable) {
            this.outputs[1]=[]
            return
        }
        const ppm=Number(this.parameters.ppm)>0?Number(this.parameters.ppm):10
        const batch=this.forestGraphs?.[0]
        if(!batch?.graphs?.length) {
            this.outputs[1]=[]
            return
        }
        const collections=[]
        /* UN SEUL CRIBLE, ET IL EST MÉMOÏSÉ PAR ARBRE: c'est celui de
           `attributeTree` (sonde racine + propagation), dont le `Map` garde
           chaque arbre tant que les réglages ne changent pas. La version
           précédente en avait recopié une copie SYNCHRONE ici — deux cribles
           par clic pour un seul résultat, et zéro cache pour aucun des deux,
           puisque `buildPlan()` reconstruit son plan à chaque appel. */
        let fresh=false
        for(const graph of batch.graphs){
            const rank=graph.rank
            if(!this.forestSelected.has(rank)) continue
            const known=this.forestAttributions?.byGraph?.has(graph)??false
            const result=await this.attributeTree(graph)
            if(!result) continue
            if(!known) fresh=true
            /* Construire la FormulaCollection avec les formules propagées. */
            const name=`${batch.title??"attribution"} tree #${rank}`
            const collection=new FormulaCollection({name,table:this.loadedTable,ppm})
            for(const row of result.rows){
                const formula=row.formula
                if(!formula) continue
                collection.addAll([{
                    formula,
                    sourceText:row.notation
                }])
            }
            /* Points: les pics du spectre correspondant aux vertices de l'arbre.
               row.mass = masse du vertex (mesurée), row.mz = mz de la formule.
               setPoints/match calcule l'erreur : (measured - formula.mz)/formula.mz * 1e6
               L'intensité vient du vertex du graphe. */
            const points=[]
            const intensityByIndex=new Map(graph.vertices.map(v=>[v.index,v.intensity]))
            for(const row of result.rows){
                const formula=row.formula
                const measuredMz=row.mass
                if(!Number.isFinite(measuredMz)||measuredMz<=0) continue
                const intensity=intensityByIndex.get(row.index)??0
                points.push({mz:measuredMz,key:formula.key,intensity})
            }
            collection.setPoints(points)
            collections.push(collection)
        }
        this.outputs[1]=collections
        this.resolveChildren()
        /* LES FORMULES ARRIVENT APRÈS LE PREMIER COUP DE PINCEAU: `renderForest`
           a peint avant que le crible n'ait tourné — anneaux gris, pas
           d'étiquette, pas de couleur d'erreur. On repeint alors, UNE SEULE
           FOIS: le cache rend `fresh` faux aux visites suivantes, donc une
           sélection qui ne change rien ne paie pas ce second rendu. */
        if(fresh) this.renderForestOverview()
    }

    /* LA PHRASE SOUS LA COURBE, et elle dit CE QUI EST GARDÉ.

       Un graphique sans légende oblige à compter les points; une légende sans
       graphique laisse deviner où l'on coupe. Les deux ensemble disent en une
       ligne ce que la liste des groupes va montrer en détail. */
    renderForestCurveLine(){
        if(!this.forestCurveLabel) return
        const weights=this.forestWeights??[]
        if(!weights.length){
            this.forestCurveLabel.textContent=""
            return
        }
        const used=this.forestCut||weights.length
        const suggestion=this.forestSuggestion
        const parts=[`${used} of ${weights.length} link(s) kept`]
        if(this.forestCut&&suggestion){
            /* ON DIT QUAND MÊME CE QUE LE DÉTECTEUR PENSE, même quand
               l'utilisateur a choisi ailleurs: sinon une coupure manuelle
               devient une affirmation, alors qu'elle n'est qu'un choix. */
            if(suggestion.index===used){
                parts.push(`cut at the detected step (${suggestion.reason})`)
                /* ET SI C'EST LE PROGRAMME QUI L'A POSÉE, ON LE DIT. La
                   coupure est automatique au premier calcul: sans le mot, la
                   ligne ferait croire que l'utilisateur l'a choisie, et il ne
                   l'a pas fait — il vient de la voir apparaître. */
                if(this.forestCutAutomatic) parts.push("applied on its own")
            }else{
                parts.push(`detector suggested ${suggestion.index} (${suggestion.reason})`)
            }
        }
        parts.push("click the curve to cut elsewhere, double-click to take the suggestion")
        this.forestCurveLabel.textContent=parts.join("  ·  ")
    }


    /* L'ARBRE D'UN LOT, et le lien entre les deux tableaux est ISOLÉ ICI.

       `forests` et `forestComponents` se remplissent dans la même boucle et
       d'abord à la même taille — mais deux tableaux parallèles sont un contrat
       implicite, et un `indexOf` qui ne trouve pas doit renvoyer `null` plutôt
       qu'un autre lot. Une fonction, un endroit. */
    forestForestOf(batch){
        const index=(this.forestComponents??[]).indexOf(batch)
        if(index<0) return null
        return (this.forests??[])[index]??null
    }

    /* LA LISTE DES COMPOSANTS.

       PAS de virtualisation ici, et c'est un choix à MESURER plus tard: le
       nombre de composants est BORNE par le nombre de pics moins les liens, donc
       il est de l'ordre du millier pour un spectre de 10 000 points — pas de
       dix mille comme une liste de formules, où chaque pic peut en porter
       `bestMatches`. Un bloc de mille lignes se peint en une frame; un de dix
       mille non. La virtualisation viendrait le jour où ce plafond tombe, et elle
       viendrait ici, pas dans le rendu. */
    renderForestList(){
        const list=this.forestList
        if(!list) return
        list.replaceChildren()
        const batches=this.forestComponents??[]
        if(!batches.length){
            const empty=CE("div",{},["— no network yet —"])
            stylize(empty,{fontSize:"0.8em",opacity:"0.5",padding:"2px"})
            list.appendChild(empty)
            return
        }
        for(const batch of batches){
            if(!batch?.components?.length) continue
            const batchIndex=(this.forestComponents??[]).indexOf(batch)
            const graphsBatch=(this.forestGraphs??[])[batchIndex]
            /* LIGNES FUSIONNÉES D'ABORD: un graphe mergé remplace ses sources.
               Les rangs absorbés sont masqués — la liste montre UNE ligne
               fusionnée (taille/poids cumulés, segments ajoutés en infobulle),
               pas N lignes dont N−1 fantômes. */
            const shownMerged=new Set()
            for(const graph of graphsBatch?.graphs??[]){
                if(!graph?.mergedFrom?.length) continue
                if(graph.size<this.forestMinSize) continue
                shownMerged.add(graph.rank)
                list.appendChild(this.forestMergedRow(graph,batch))
            }
            for(const component of batch.components){
                if(component.size>=this.forestMinSize){
                    const absorbed=[...(this.forestMerges?.values()??[])]
                        .some(merged=>merged.mergedFrom?.includes(component.rank)
                            &&shownMerged.has(merged.rank))
                    if(!absorbed) list.appendChild(this.forestRow(component,batch))
                }
            }
        }
    }

    /* UNE LIGNE DE GRAPHE FUSIONNÉ: même contrat que `forestRow`, mais les
       chiffres viennent du graphe mergé (sommets/liens concaténés) et
       l'infobulle distingue les liens d'origine des segments ajoutés. */
    forestMergedRow(graph,batch){
        const isSelected=this.forestSelected.has(graph.rank)
        const root=graph.vertices.find(v=>v.index===graph.rootIndex)
        const row=CE("div",{className:"an-forest-row",pilot:this},[
            componentLine({rank:graph.rank,size:graph.size,
                rootMass:root?.mass??graph.meanMass,peakMass:root?.mass??graph.meanMass,
                weight:graph.weight,links:graph.links})
        ])
        stylize(row,{
            fontSize:"0.8em",lineHeight:"1.35",cursor:"pointer",
            padding:"2px 4px",borderRadius:"3px",
            background:isSelected?"rgba(172,255,47,0.18)":"rgba(255,178,46,0.08)",
            border:isSelected?"2px solid #aef22e":"1px dashed rgba(255,178,46,0.55)",
            boxShadow:isSelected?"0 0 8px rgba(172,255,47,0.4)":"none"
        })
        const points=batch.points
        const mergedLabels=new Set((graph.mergedLinks??[]).map(link=>`${link.u}-${link.v}`))
        row.title=[
            `merged from ${graph.mergedFrom.map(rank=>`#${rank}`).join(", ")} · root ${(root?.mass??0).toFixed(5)}`,
            `total error ${graph.weight.toFixed(3)} Da over ${graph.links.length} link(s)`,
            ...graph.links.map(link=>{
                const from=points?.x?.[link.u]
                const to=points?.x?.[link.v]
                const masses=[from,to].filter(v=>Number.isFinite(v))
                    .map(v=>v.toFixed(4)).join(" ↔ ")
                const tag=mergedLabels.has(`${link.u}-${link.v}`)?" [merge]":""
                return `${link.label??`#${link.standard}`}: ${masses} (${link.weight.toFixed(3)} Da)${tag}`
            }),
            "",
            "click to toggle selection, Ctrl+click for additive"
        ].join("\n")
        row.addEventListener("click",(e)=>{
            if(Number.isFinite(root?.mass)){
                if(this.probeInput) this.probeInput.value=String(root.mass)
                this.probeMass(root.mass)
            }
            const additive=e.ctrlKey||e.metaKey
            if(!additive) this.forestSelected.clear()
            if(this.forestSelected.has(graph.rank)){
                this.forestSelected.delete(graph.rank)
            }else{
                this.forestSelected.add(graph.rank)
            }
            this.renderForest()
        })
        return row
    }

    /* UNE LIGNE DE COMPOSANT, et son infobulle porte les PIÈCES.

       La ligne dit la taille, l'ancêtre et l'erreur totale; l'infobulle dit
       quelles références ont fait les liens et quelles masses sont reliées. Sur
       une ligne de six mots, il n'y a pas la place du détail — et le détail est
       ce qui permet de JUGER le groupe.
       
       Le clic TOGGLE la sélection. Ctrl/Cmd + clic = additive (garde les autres).
       La sélection synchronise la liste et le graphe. */
    forestRow(component,batch){
        const isSelected=this.forestSelected.has(component.rank)
        /* LA RACINE AFFICHÉE EST CELLE QUI PROPAGE, PAS CELLE DU NOYAU.
           `component.rootMass` est la racine Rust (`forest.componentRoot`) ;
           la sonde, les étiquettes du graphe et la Formula Collection partent
           de `graph.rootIndex` (désignée par `forestRoot`). La ligne disait
           l'une pendant que tout le reste disait l'autre. On affiche la masse
           du sommet racine du graphe, avec repli sur le composant. */
        const batchIndex=(this.forestComponents??[]).indexOf(batch)
        const graphsBatch=(this.forestGraphs??[])[batchIndex]
        const treeGraph=graphsBatch?.graphs?.find(g=>g.rank===component.rank)
        const treeRoot=treeGraph?.vertices?.find(v=>v.index===treeGraph.rootIndex)
        const displayRootMass=treeRoot?.mass??component.rootMass
        const row=CE("div",{className:"an-forest-row",pilot:this},[
            componentLine({...component,rootMass:displayRootMass})
        ])
        stylize(row,{
            fontSize:"0.8em",lineHeight:"1.35",cursor:"pointer",
            padding:"2px 4px",borderRadius:"3px",
            background:isSelected?"rgba(172,255,47,0.18)":"rgba(255,255,255,0.05)",
            border:isSelected?"2px solid #aef22e":"1px solid rgba(255,255,255,0.12)",
            boxShadow:isSelected?"0 0 8px rgba(172,255,47,0.4)":"none"
        })
        const points=batch.points
        row.title=[
            `root ${displayRootMass.toFixed(5)} · tallest ${component.peakMass.toFixed(5)}`,
            `total error ${component.weight.toFixed(3)} Da over ${component.links.length} link(s)`,
            ...component.links.map(link=>{
                const from=points?.x?.[link.u]
                const to=points?.x?.[link.v]
                const masses=[from,to].filter(v=>Number.isFinite(v))
                    .map(v=>v.toFixed(4)).join(" ↔ ")
                return `${link.label??`#${link.standard}`}: ${masses} (${link.weight.toFixed(3)} Da)`
            }),
            "",
            "click to toggle selection, Ctrl+click for additive"
        ].join("\n")
        row.addEventListener("click",(e)=>{
            /* LE GRAPHE NE VIT PAS DANS CE LOT: `batch` est un lot de
               `forestComponents` (title, points, components), et les graphes
               vivent dans le lot PARALLÈLE de `forestGraphs` (title, points,
               graphs) bâti par `buildForestGraphs`. L'ancien code cherchait
               `batch.graphs` — indéfini ici — donc `graph` restait indéfini et
               la masse retombait sur `component.rootMass`, la racine du noyau
               Rust. La sonde lisait alors une racine pendant que `attributeTree`,
               les étiquettes du graphe et la sortie en propageaient une autre
               (`graph.rootIndex`, désignée par `forestRoot`): la sonde disait
               juste, tout le reste disait autre chose. On rejoint le graphe par
               l'index du lot, et la masse sondée est celle du sommet racine. */
            const batchIndex=(this.forestComponents??[]).indexOf(batch)
            const graphsBatch=(this.forestGraphs??[])[batchIndex]
            const graph=graphsBatch?.graphs?.find(g=>g.rank===component.rank)
            const rootVertex=graph?.vertices?.find(v=>v.index===graph.rootIndex)
            const mass=rootVertex?.mass??component.rootMass
            if(Number.isFinite(mass)){
                if(this.probeInput) this.probeInput.value=String(mass)
                this.probeMass(mass)
            }
            /* LA RACINE N'EST PAS TOUCHÉE ICI, ET C'EST LE CORRECTIF.

               CE BLOC RACINAIT L'ARBRE SUR `component.root` — la racine que le
               noyau Rust rend dans `forest.componentRoot`. Ce n'est PAS la même
               valeur que `graph.rootIndex`, que `forestGraph` a choisie par
               `forestRoot` (le défaut de masse le plus élevé parmi les pics près
               de la moyenne). Deux autorités pour une seule décision.

               La conséquence était invisible et silencieuse: le MÊME arbre se
               propageait depuis un pic différent selon qu'on l'avait obtenu par
               « Grow network » ou en cliquant sa ligne dans la liste. Les
               formules changeaient, l'erreur ppm changeait, et rien ne le
               signalait — un `graph.rootIndex` est un nombre, il est juste faux.

               `forestRoot` est donc le SEUL endroit qui décide, et un clic sur
               une ligne ne fait que SONDE et SÉLECTION. Celui qui veut une autre
               racine la prend en cliquant un SOMMET du graphe, où le geste veut
               explicitement dire « propage depuis ce pic » — et ce chemin-là
               invalide bien le cache de cet arbre.

               `comp.root` n'est plus réécrit non plus: il ne sert plus qu'à
               l'infobulle de la ligne, où il reste la racine du noyau.

               ET LE NOM DE LA SONDE N'EST PAS ÉCRIT EN CLAIR ICI, exprès: un
               commentaire qui cite l'appel fait matcher le commentaire au lieu
               du code, et le test de contrat vérifierait une phrase. */
            const additive=e.ctrlKey||e.metaKey
            if(!additive) this.forestSelected.clear()
            if(this.forestSelected.has(component.rank)){
                this.forestSelected.delete(component.rank)
            }else{
                this.forestSelected.add(component.rank)
            }
            this.renderForest()
        })
        return row
    }
}

