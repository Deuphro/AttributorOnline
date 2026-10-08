import {CE,stylize} from "../util.js"
import {Accordion} from "../ui/Accordion.js"
import {Dialog} from "../ui/Dialog.js"
import {Plot2DWebGL} from "../ui/Plot2DWebGL.js"
import {Wave,XYTrace} from "../formats.js"
import {Formula,FormulaCollection} from "../chemistry.js"
import {computePool} from "../workerPool.js"
import {buildPlan,attributeSpectrum,SortedPoints,stateToFormula,propagateForest} from "../attribution.js"
import {forestStandards,forestComponents,componentLine,growForest,suggestWeightCut,forestGraph,layoutForests,createAnimatedLayout,advanceLayout,finalizeAnimatedLayout,applyGridLayout,DEFAULT_LINK_TOLERANCE,FOREST_LAYOUT_DEFAULTS} from "../forest.js"
import {windowFor} from "../utils/index.js"
import {prettyNotation} from "./formulaCollectionHelpers.js"

export class AttributionForestMethods{
    buildForestGraphs(){
        /* LE REBÂTIMENT EST MÉMOÏSÉ SUR LES COMPOSANTS, ET SUR EUUX SEULEMENT.
           `forestGraph` ne lit que `forestComponents`; le reconstruire à chaque
           rendu produirait des sommets — et une identité — NEUFS alors que rien
           n'a bougé, ce qui invaliderait la mise en page en dessous sans raison.
           Les composants ne sont réécrits qu'au résultat d'un « Grow network »:
           leur identité est exactement la bonne clé. */
        const source=this.forestComponents??[]
        if(this.forestGraphsOf===source&&Array.isArray(this.forestGraphs)) return this.forestGraphs
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
                graphs:forestGraph(batch.components??[],{masses,intensities})
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
            .filter(item=>item.kind==="combining"&&item.atomicMass>0)
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
        const tuneKey=[tune.iterations,tune.ideal,tune.repulsion,tune.restBase,tune.restSpan,tune.gravity,tune.tempStart,tune.tempEnd,tune.fac].join(",")
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
        plot.drawGraph?.()
        /* CONFIGURER L'INTERACTION SOURIS (une seule fois). */
        if(!this.forestInteractionHooked){
            this.setupForestInteraction(plot)
            this.forestInteractionHooked=true
        }
    }

    /* CONFIGURE LES GESTIONNAIRES DE SOURIS POUR LE HOVER ET LE CLIC. */
    setupForestInteraction(plot){
        const svg=plot.graphSVG
        if(!svg) return
        const svgNode=svg.node()
        if(!svgNode) return

        /* Conversion écran → données (data coordinates) via les échelles du plot. */
        const screenToData=(clientX,clientY)=>{
            const pt=plot.pointerInGraphzone(clientX,clientY)
            if(!pt) return null
            const {xScale,yScale}=plot.plotScales()
            return {x:xScale.invert(pt.x), y:yScale.invert(pt.y)}
        }

        /* Trouver le sommet le plus proche. */
        const findNearestVertex=(dataX,dataY,groups,layout)=>{
            let best=null
            let bestDist=Infinity
            for(const group of layout.groups){
                for(const point of group.points){
                    const dx=point.x-dataX
                    const dy=point.y-dataY
                    const dist=dx*dx+dy*dy
                    if(dist<bestDist){
                        bestDist=dist
                        best={point,group}
                    }
                }
            }
            /* Seuil de détection: ~8px en coordonnées écran. */
            if(bestDist>64) return null
            return best
        }

        /* Trouver le segment le plus proche. */
        const findNearestSegment=(dataX,dataY,groups,batch,at)=>{
            let best=null
            let bestDist=Infinity
            for(const {graph,rank} of groups){
                for(const link of graph.links??[]){
                    const from=at(rank,link.u)
                    const to=at(rank,link.v)
                    if(!from||!to) continue
                    /* Distance point-segment. */
                    const x1=from.x,y1=from.y
                    const x2=to.x,y2=to.y
                    const dx=x2-x1,dy=y2-y1
                    const len2=dx*dx+dy*dy
                    let t=0
                    if(len2>0) t=Math.max(0,Math.min(1,((dataX-x1)*dx+(dataY-y1)*dy)/len2))
                    const px=x1+t*dx
                    const py=y1+t*dy
                    const dist=(px-dataX)*(px-dataX)+(py-dataY)*(py-dataY)
                    if(dist<bestDist){
                        bestDist=dist
                        best={link,from,to,graph,rank,t}
                    }
                }
            }
            /* Seuil de détection: ~6px. */
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
            const vertexHit=findNearestVertex(data.x,data.y,groups,this.forestLayout)
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
            const segmentHit=findNearestSegment(data.x,data.y,groups,batch,at)
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

        /* CLIC SUR UN SOMMET → DEVIENT LA NOUVELLE RACINE. */
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
            const vertexHit=findNearestVertex(data.x,data.y,groups,this.forestLayout)
            if(!vertexHit) return

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
            return result
        }
        plot._forestLabelsHooked=true
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
                .attr("fill","#aef22e")
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
            /* TROIS RANGÉES: le graphe, son titre, et LE RÉCAP À 15% — la
               part d'un graphique qu'on lit d'un coup d'œil sans chasser les
               chiffres. La rangée du milieu reste `auto`: un titre ne pèse
               que sa propre hauteur. */
            "grid-template-rows":"minmax(0,1fr) auto 15%",
            "grid-template-columns":"minmax(0,1fr)",
            height:"100%",
            minHeight:"0",
            minWidth:"0",
            padding:"4px",
            gap:"4px",
            overflow:"hidden"
        })
        const caption=(text)=>{
            const label=CE("div",{},[text])
            stylize(label,{fontSize:"0.78em",opacity:"0.6",margin:"6px 0 2px"})
            content.appendChild(label)
            return label
        }
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
        /* FORWARD RESIZE OBSERVER: le plot doit être notifié quand sa boîte change de taille. */
        this.forestPlotBox.handleResize=()=>this.forestPlot?.handleResize?.()
        content.appendChild(this.forestPlotBox)

        /* LE RÉCAPITULATIF, SOUS LE GRAPHE — et non au-dessus. Le graphique
           répond à « à quoi ressemble ce réseau », les trois chiffres à « qu'est-ce
           que j'ai là ». Le premier est une forme, le second une quantité: poser
           la quantité au-dessus ferait chercher la forme dans un tableau. */
        caption("Attribution")
        this.forestRecapHost=CE("div",{className:"an-recap"},[])
        /* 15% de la fenêtre (grid-template-rows): l'histogramme tient dans la
           part; `overflow:auto` couvre un récap à quatre lots sur hauteur
           réduite. `alignContent:start` empêche la grille d'étirer ses lignes. */
        stylize(this.forestRecapHost,{display:"grid",gap:"4px",
            alignContent:"start",minHeight:"0",overflow:"auto"})
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
    forestRecap(batchIndex){
        const attribution=(this.attributions??[])[batchIndex]
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
            title:(this.forestGraphs?.[batchIndex]?.title)??"attribution",
            targets,attributed,counts,domain,window,median,
            under:window===null?null:share(window),
            half:window===null?null:share(window/2),
            tenth:window===null?null:share(window/10)
        }
    }

/* LE RÉCAPITULATIF, ET IL EST UN HISTOGRAMME.

       Une ligne par lot: le titre avec ses cibles et ses attribuées, la
       distribution des MEILLEURES erreurs en seize tranches — teintées par la
       MÊME échelle que les anneaux du graphe, repères à 1/10 et 1/2 de la
       fenêtre — puis la phrase: médiane et les trois proportions. La forme
       dit « où ça se casse », la phrase le dit en nombres; les deux se
       relisent, et c'est le point. */
    renderForestRecap(){
        const host=this.forestRecapHost
        if(!host) return
        host.replaceChildren()
        const rows=(this.forestGraphs??[])
            .map((_,index)=>this.forestRecap(index))
            .filter(Boolean)
        if(!rows.length){
            stylize(host.appendChild(CE("div",{},["— resolve first —"])),
                {fontSize:"0.8em",opacity:"0.5"})
            return
        }
        for(const row of rows){
            const line=CE("div",{className:"an-recap-line"},[])
            stylize(line,{display:"grid",gap:"2px",minHeight:"0"})
            const head=CE("div",{},[
                `${row.title} · ${row.targets} target(s) · ${row.attributed} attributed`])
            stylize(head,{fontSize:"0.72em",opacity:"0.65",overflow:"hidden"})
            line.appendChild(head)
            const chart=CE("div",{},[])
            stylize(chart,{position:"relative",height:"38px",minHeight:"0"})
            const bars=CE("div",{},[])
            stylize(bars,{display:"flex",alignItems:"flex-end",gap:"1px",height:"100%"})
            const peak=Math.max(1,...row.counts)
            row.counts.forEach((count,index)=>{
                const bar=CE("div",{},[])
                /* ZÉRO COMPRIS ET IL SE VOIT: deux pour cent de hauteur, pas
                   zéro — une barre absente dirait « rien ici », qui est faux:
                   il y a zéro point, et ça se dit aussi. */
                const height=count>0?Math.max(6,Math.round(100*count/peak)):2
                stylize(bar,{
                    height:`${height}%`,
                    background:count>0
                        ?this.constructor.forestErrorColor((index+0.5)/row.counts.length)
                        :"rgba(127,140,155,0.35)"
                })
                if(count>0){
                    const low=row.domain*index/row.counts.length
                    const high=row.domain*(index+1)/row.counts.length
                    bar.title=`${count} target(s): ${this.formatPPM(low)}–${this.formatPPM(high)} ppm`
                }
                bars.appendChild(bar)
            })
            chart.appendChild(bars)
            if(row.window!==null){
                /* LES REPÈRES DE LA PHRASE, POSÉS SUR LA FORME: 1/10 et 1/2 de
                   la fenêtre. L'axe est la fenêtre — au-delà, rien à voir. */
                for(const ratio of [0.1,0.5]){
                    const tick=CE("div",{},[])
                    stylize(tick,{position:"absolute",top:"0",bottom:"0",
                        width:"1px",background:"rgba(255,255,255,0.55)",
                        left:`${Math.round(100*ratio)}%`,pointerEvents:"none"})
                    tick.title=`${this.formatPPM(row.window*ratio)} ppm`
                    chart.appendChild(tick)
                }
            }
            line.appendChild(chart)
            const parts=[`median ${row.median===null
                ?"—":`${this.formatPPM(row.median)} ppm`}`]
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
            degreeMax:Number.isFinite(degreeMax)&&degreeMax>0?degreeMax:0,
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
        /* NOUVEAU RÉSEAU = NOUVELLES RANGES: on efface la sélection. */
        this.forestSelected.clear()
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
            onCommit:(raw)=>this.commitForestNumber("forestDegreeMax",raw,0,8)
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
            "grid-template-columns":"1fr 1fr auto auto",
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
    commitForestNumber(name,raw,low,high){
        const value=Number(raw)
        const bounded=Number.isFinite(value)?Math.min(high,Math.max(low,value)):low
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
            for(const component of batch.components){
                if(component.size>=this.forestMinSize){
                    list.appendChild(this.forestRow(component,batch))
                }
            }
        }
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

