import {CE,stylize} from "../util.js"
import {Accordion} from "../ui/Accordion.js"
import {Dialog} from "../ui/Dialog.js"
import {Plot2DWebGL} from "../ui/Plot2DWebGL.js"
import {Wave,XYTrace} from "../formats.js"
import {Formula,FormulaCollection} from "../chemistry.js"
import {computePool} from "../workerPool.js"
import {buildPlan,attributeSpectrum,SortedPoints,stateToFormula,propagateForest} from "../attribution.js"
import {forestStandards,forestComponents,componentLine,growForest,suggestWeightCut,forestGraph,layoutForests,DEFAULT_LINK_TOLERANCE} from "../forest.js"
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
        const cached=this.forestAttributions
        const ppm=Number(this.parameters.ppm)>0?Number(this.parameters.ppm):10
        const bestMatches=Math.max(1,Math.trunc(Number(this.parameters.bestMatches))||3)
        if(cached&&cached.graph===graph&&cached.plan===plan
            &&cached.linkPlan===linkPlan&&cached.ppm===ppm
            &&cached.bestMatches===bestMatches){
            return cached.result
        }
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
        this.forestAttributions={graph,plan,linkPlan,ppm,bestMatches,result}
        return result
    }


/* LA MISE EN PLACE, CALCULÉE UNE FOIS PAR RÉSEAU.

       Elle vient de `forest.js` et ne dépend que du graphe: elle n'est donc PAS
       dans le rendu. Un moteur de force recalculé à chaque image donnerait deux
       réseaux différents pour un même « Grow network », et la comparaison d'un
       run à l'autre — le seul usage de ce graphique — deviendrait impossible.

       AFFICHE SEULEMENT LES ARBRES SÉLECTIONNÉS, côte à côte en force-directed. */
    forestOverviewLayout(){
        const box=this.forestPlotBox
        if(!box) return null
        const batch=this.forestGraphs?.[0]
        if(!batch?.graphs?.length) return null
        const width=Math.max(240,Math.round(box.clientWidth||600))
        const height=Math.max(160,Math.round(box.clientHeight||this.forestPlotHeight||260))
        /* FILTRER LES GRAPHES SÉLECTIONNÉS. */
        const selectedGraphs=batch.graphs.filter(g=>this.forestSelected.has(g.rank))
        if(!selectedGraphs.length) return null
        /* LA MISE EN PAGE EST MÉMOÏSÉE, clé = graphes sélectionnés (même objets, même ordre) + taille boîte. */
        const cached=this.forestLayoutOf
        if(cached&&cached.width===width&&cached.height===height
            &&cached.graphs.length===selectedGraphs.length
            &&cached.graphs.every((g,i)=>g===selectedGraphs[i])){
            return cached.layout
        }
        const layout=layoutForests(selectedGraphs,{width,height})
        this.forestLayoutOf={graphs:selectedGraphs,width,height,layout}
        return layout
    }

    /* LE DESSIN, ET IL NE FAIT QUE LIRE DES POSITIONS.

       LES SEGMENTS SONT GROUPÉS PAR TRANCHE D'ERREUR — huit traces, pas une par
       lien. Une trace par lien donnerait dix mille entrées de légende et dix
       mille nœuds; huit traces donnent huit valeurs d'opacité, et c'est
       exactement ce que l'œil sait comparer. Le regroupement est donc une
       décision de LISSAGE visuel, pas de donnée: l'erreur exacte reste dans la
       liste des liens et dans l'infobulle du pic. */
    static FOREST_OPACITY_STEPS=8

    /* LA PALETTE DES BRIQUES, et elle est celle du programme.

       Le bleu `#78b4ff` des listes ionisantes ouvre la série, puis le vert de
       l'accent, puis l'orange et le rouge d'alerte que la feuille de style
       declare pour `.badge.warn` et `.badge.req`. Une palette inventée ici
       ferait un graphique qui ne ressemble à rien du reste de l'application. */
    static FOREST_FORMULA_COLOURS=["#78b4ff","#aef22e","#ffb02e","#ff6363","#c58cff"]

    renderForestPlot(){
        const plot=this.forestPlot
        if(!plot) return
        const layout=this.forestOverviewLayout()
        if(!layout){
            plot.traces=[]
            plot.drawGraph?.()
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
        const tolerance=Number(this.parameters.forestTolerance)
        const traces=[]

        /* UNE TRACE DE SEGMENTS, et elle tient tous les liens qu'on lui donne
           dans UN SEUL chemin SVG. C'est ce qui permet à un réseau de cent mille
           pics de rester un objet DOM unique au lieu de cent mille. */
        const segmentTrace=(id,title,colour,opacity,pairs,size)=>{
            if(!pairs.length) return
            traces.push(new XYTrace({
                id,title,mode:"segments",layer:"svg",
                options:{mode:"segments",layer:"svg",color:colour,opacity,
                    line:{size}},
                /* PAS DE `points` EN PLUS: `XYTrace` ne lit que `{id,title,wave,
                   options}`, et ses `points` viennent du wave. */
                wave:Wave.fromCoordinates(
                    Float64Array.from(pairs,pair=>pair[0]),Float64Array.from(pairs,pair=>pair[1]),{},["x","y"])
            }))
        }

        for(let step=0;step<this.constructor.FOREST_OPACITY_STEPS;step++){
            const low=step/this.constructor.FOREST_OPACITY_STEPS
            const high=(step+1)/this.constructor.FOREST_OPACITY_STEPS
            const pairs=[]
            for(const {graph,rank} of groups){
                for(const link of graph.links??[]){
                    const ratio=tolerance>0?Number(link.weight||0)/tolerance:0
                    if(!(ratio>=low&&ratio<high)) continue
                    const from=at(rank,link.u)
                    const to=at(rank,link.v)
                    if(!from||!to) continue
                    pairs.push([from.x,from.y],[to.x,to.y])
                }
            }
            /* L'OPACITÉ VIENT DE LA TRANCHE ET NON DU LIEN: deux liens d'une même
               tranche partagent la même valeur, donc l'écart entre eux serait du
               bruit de segmentation — et ce bruit se voit, parce que deux liens
               identiques seraient arrondis différemment. */
            segmentTrace(
                `${this.title}:forest:error:${step}`,
                `link error ${(low*tolerance).toFixed(2)}–${(high*tolerance).toFixed(2)} Da`,
                "#dfe6ee",0.12+0.88*(low+high)/2,pairs,1)
        }

        /* LES SOMMETS: blancs pour non-sélectionnés, colorés pour sélectionnés.
           Pour les arbres sélectionnés, on ajoute les formules en infobulle et
           un glow sur la racine. */
        const pointsSelected=[]
        const pointsUnselected=[]
        const rootGlows=[]  // {x,y,rank} pour les racines sélectionnées
        const vertexLabels=[]  // {x,y,text,rank} pour étiquettes de formule
        for(const {graph,rank} of groups){
            const isTreeSelected=this.forestSelected.has(rank)
            for(const vertex of graph.vertices??[]){
                const point=at(rank,vertex.index)
                if(!point) continue
                if(isTreeSelected){
                    pointsSelected.push([point.x,point.y])
                    /* Racine = glow */
                    if(vertex.isRoot){
                        rootGlows.push({x:point.x,y:point.y,rank})
                    }
                    /* Étiquettes de formule pour arbres sélectionnés (si peu de sommets) */
                    if(graph.vertices.length<=40){
                        const attr=this.forestAttributions?.result
                        if(attr){
                            const row=attr.rows.find(r=>r.index===vertex.index)
                            if(row){
                                vertexLabels.push({
                                    x:point.x,y:point.y,
                                    text:`${row.notation} (${row.errorPpm?.toFixed(1)??"?"} ppm)`,
                                    rank
                                })
                            }
                        }
                    }
                }else{
                    pointsUnselected.push([point.x,point.y])
                }
            }
        }
        if(pointsUnselected.length){
            traces.push(new XYTrace({
                id:`${this.title}:forest:peaks:unselected`,
                title:"measured peaks (unselected)",
                mode:"points",layer:"svg",
                options:{mode:"points",layer:"svg",color:"#dfe6ee",line:{size:1},
                    marker:{shape:"circle",size:3}},
                wave:Wave.fromCoordinates(
                    Float64Array.from(pointsUnselected,pair=>pair[0]),Float64Array.from(pointsUnselected,pair=>pair[1]),{},["x","y"])
            }))
        }
        if(pointsSelected.length){
            traces.push(new XYTrace({
                id:`${this.title}:forest:peaks:selected`,
                title:"measured peaks (selected)",
                mode:"points",layer:"svg",
                options:{mode:"points",layer:"svg",color:"#aef22e",line:{size:2},
                    marker:{shape:"circle",size:5}},
                wave:Wave.fromCoordinates(
                    Float64Array.from(pointsSelected,pair=>pair[0]),Float64Array.from(pointsSelected,pair=>pair[1]),{},["x","y"])
            }))
        }
        /* GLOW SUR LES RACINES SÉLECTIONNÉES: cercles radiaux plus grands */
        if(rootGlows.length){
            const glowPairs=[]
            for(const glow of rootGlows){
                const r=12
                glowPairs.push([glow.x-r,glow.y],[glow.x+r,glow.y])
                glowPairs.push([glow.x,glow.y-r],[glow.x,glow.y+r])
            }
            traces.push(new XYTrace({
                id:`${this.title}:forest:rootglow`,
                title:"selected roots",
                mode:"segments",layer:"svg",
                options:{mode:"segments",layer:"svg",color:"#aef22e",opacity:0.6,
                    line:{size:2}},
                wave:Wave.fromCoordinates(
                    Float64Array.from(glowPairs,pair=>pair[0]),Float64Array.from(glowPairs,pair=>pair[1]),{},["x","y"])
            }))
        }
        /* ÉTIQUETTES DE FORMULES sur les sommets (arbres sélectionnés, ≤40 sommets) */
        if(vertexLabels.length){
            /* On utilise une trace de type "text" via SVG direct dans le hook de dessin,
               mais XYTrace ne supporte pas le texte. On ajoute les labels via un hook
               post-dessin dans plot.drawGraph. */
            this.forestVertexLabels=vertexLabels
        }else{
            this.forestVertexLabels=null
        }

        /* `traces`, ET NON `data`: `resolveRenderTraces()` et `dataBounds()` lisent
           `this.traces` quand il y en a, et ne retombent sur `this.data` qu'en
           dernier recours. Écrire dans `data` laissait donc `traces` vide — rien
           n'était dessiné et les bornes restaient nulles, sans une seule erreur:
           un cadre muet. C'est le défaut le plus coûteux, il ne se signale pas. */
        plot.traces=traces
        /* Hook pour dessiner les étiquettes de formule après le rendu */
        const origDraw=plot.drawGraph.bind(plot)
        plot.drawGraph=()=>{
            origDraw()
            if(this.forestVertexLabels?.length){
                this.drawForestVertexLabels(plot)
            }
        }
        plot.drawGraph?.()
    }

    /* Dessine les étiquettes de formule sur les sommets (SVG direct). */
    drawForestVertexLabels(plot){
        const svg=plot.graphSVG
        if(!svg) return
        const anchor=svg.select(".anchor")
        if(!anchor) return
        let labelLayer=anchor.select(".forest-vertex-labels")
        if(labelLayer.empty()) labelLayer=anchor.append("g").attr("class","forest-vertex-labels")
        labelLayer.selectAll("*").remove()
        for(const label of this.forestVertexLabels){
            labelLayer.append("text")
                .attr("x",label.x)
                .attr("y",label.y-8)
                .attr("text-anchor","middle")
                .attr("font-size","9px")
                .attr("fill","#aef22e")
                .attr("pointer-events","none")
                .text(label.text)
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
            "grid-template-rows":"minmax(0,1fr) auto auto",
            height:"100%",
            minHeight:"0",
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
            /* PAS DE HAUTEUR EN px: la fenêtre a la sienne et se redimensionne.
               Un cadre de 260px figé laisserait une bande morte en dessous, puis
               une seconde bande dès qu'on élargit la fenêtre. */
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
        stylize(this.forestRecapHost,{display:"grid",gap:"4px"})
        content.appendChild(this.forestRecapHost)

        /* LE PLOT, EN DERNIER: tout ce qui occupe de la place est déjà en place,
           donc la boîte qu'il mesure est exactement celle qu'il dessinera. */
        this.forestPlot=new Plot2DWebGL([],
            `${this.title} network`,this.origin,this.forestPlotBox)
        this.forestPlot.parameters.axis.left.autoLabel=false
        this.forestPlot.parameters.axis.bottom.autoLabel=false
        this.forestPlot.parameters.axis.left.label=""
        this.forestPlot.parameters.axis.bottom.label=""

        /* FORCER UN RESIZE APRÈS CRÉATION: le conteneur peut ne pas avoir sa taille
           finale au moment où le constructeur appelle drawGraph(). Un rAF assure
           que le layout est fait avant de mesurer. */
        requestAnimationFrame(()=>this.forestPlot?.handleResize?.())

        /* ET IL EST REPEINT TOUT DE SUITE, pas au prochain resolve: la fenêtre
           vient d'être recréée et montrerait un cadre vide à qui l'ouvrirait
           alors que les données existent déjà. */
        this.renderForestOverview()
    }




/* LES TROIS NOMBRES, ET ILS SONT LUS, JAMAIS RECOMPTÉS.

       Ils existent déjà: `attribution.pointCount`, les entrées qui passent la
       fenêtre, et le nombre d'entrées. Les REPRODUIRE serait l'échec le plus
       facile à commettre — un compteur dupliqué diverge de celui qu'il duplique
       au premier resolve, et les deux restent vrais séparément. */
    forestRecap(batchIndex){
        const attribution=(this.attributions??[])[batchIndex]
        if(!attribution) return null
        const entries=attribution.entries??[]
        return {
            title:(this.forestGraphs?.[batchIndex]?.title)??"attribution",
            /* LES CIBLES: les positions de pic soumises, pas les lignes du
               tableau de formules. */
            targets:attribution.pointCount??0,
            /* LES MATCHS, ET CE SONT CEUX QUI PASSENT LA FENÊTRE. Une formule
               présente mais hors fenêtre est un CANDIDAT, pas une
               correspondance, et la compter ferait monter un nombre qui n'a pas
               de sens. */
            matched:entries.filter(entry=>entry.inWindow).length,
            /* LES CAS POSSIBLES: les formules qui ont survécu au crible et
               qu'on peut donc vérifier. Le nombre de combinaisons ÉNUMÉRÉES
               n'est pas mis ici — c'est du travail de machine, et `visited` le
               dit déjà à qui le veut. */
            possible:entries.length
        }
    }

/* LE RÉCAPITULATIF, ET CHAQUE NOMBRE A SA BARRE.

       La barre est une PART, pas une valeur: elle est normée sur le plus grand
       des trois du même lot, donc elle dit une proportion à l'intérieur d'une
       série. C'est le seul moyen honnête quand trois grandeurs n'ont pas la même
       unité — et trois grandeurs sans commune mesure, alignées en colonnes, se
       lisent très bien. */
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
            const cells=[["targets",row.targets],["matched",row.matched],["possible",row.possible]]
            const top=Math.max(...cells.map(([,value])=>value))||1
            const line=CE("div",{className:"an-recap-line"},[])
            stylize(line,{display:"grid",gap:"2px"})
            line.appendChild(CE("div",{style:{fontSize:"0.72em",opacity:"0.65"}},[row.title]))
            const grid=CE("div",{},[])
            stylize(grid,{display:"grid",gridTemplateColumns:"repeat(3,minmax(0,1fr))",gap:"6px"})
            for(const [label,value] of cells){
                const cell=CE("div",{},[])
                stylize(cell,{display:"grid",gap:"1px",minWidth:"0"})
                const bar=CE("div",{},[])
                /* `minWidth` GARDE LE TICK: une valeur nulle donnerait une barre
                   de largeur nulle, donc un nombre qui n'a pas l'air d'être
                   mesuré. Zéro est une RÉPONSE, et elle doit se voir. */
                stylize(bar,{
                    height:"3px",minWidth:"1px",
                    width:`${Math.round(100*value/top)}%`,
                    background:"var(--accent)",opacity:"0.8"
                })
                cell.appendChild(bar)
                const text=CE("div",{},[`${value} ${label}`])
                stylize(text,{fontSize:"0.72em",opacity:"0.9",overflow:"hidden"})
                cell.appendChild(text)
                grid.appendChild(cell)
            }
            line.appendChild(grid)
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
    renderForestOverview(){
        if(!this.forestPlot) return
        this.renderForestRecap()
        this.renderForestPlot()
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
        this.renderForestList()
        /* LE GRAPHE ET LE RÉCAPITULATIF, ICI ET NULLE PART AILLEURS. C'est
           cette méthode que `startForest` appelle sur chacune de ses
           branches — résultat, aucune référence, plan illisible — donc c'est
           le seul endroit où les deux sont repeints ensemble. */
        this.buildForestGraphs()
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
        const plan=this.buildPlan()
        const linkPlan=this.forestLinkPlan
        const ppm=Number(this.parameters.ppm)>0?Number(this.parameters.ppm):10
        const batch=this.forestGraphs?.[0]
        if(!batch?.graphs?.length) {
            this.outputs[1]=[]
            return
        }
        const references=(linkPlan?.items??[])
            .filter(item=>item.kind==="combining"&&item.atomicMass>0)
            .map(item=>({composition:item.composition??null}))
        const collections=[]
        for(const graph of batch.graphs){
            const rank=graph.rank
            if(!this.forestSelected.has(rank)) continue
            if(!Number.isInteger(graph.rootIndex)) continue
            const rootVertex=graph.vertices.find(v=>v.index===graph.rootIndex)
            if(!rootVertex||!Number.isFinite(rootVertex.mass)) continue
            let probed
            try{
                probed=attributeSpectrum(plan,windowFor(rootVertex.mass),{
                    limit:Infinity,ppm,
                    bestMatches:Math.max(1,Math.trunc(Number(this.parameters.bestMatches))||3)
                })
            }catch{
                continue
            }
            const centre=(probed.entries??[])
                .filter(entry=>entry.target?.index===1)
                .sort((a,b)=>Math.abs(a.errorPpm)-Math.abs(b.errorPpm))
            if(!centre.length) continue
            const rootFormula=centre[0].formula
            if(!rootFormula) continue
            const result=propagateForest(graph,rootFormula,references,{table:this.loadedTable})
            if(!result) continue
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
        const row=CE("div",{className:"an-forest-row",pilot:this},[
            componentLine(component)
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
            `root ${component.rootMass.toFixed(5)} · tallest ${component.peakMass.toFixed(5)}`,
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
            const mass=component.rootMass
            if(Number.isFinite(mass)){
                if(this.probeInput) this.probeInput.value=String(mass)
                this.probeMass(mass)
            }
            const additive=e.ctrlKey||e.metaKey
            if(!additive) this.forestSelected.clear()
            if(this.forestSelected.has(component.rank)){
                this.forestSelected.delete(component.rank)
            }else{
                this.forestSelected.add(component.rank)
            }
            this.renderForest()
            this.renderForestOverview()
        })
        return row
    }
}

