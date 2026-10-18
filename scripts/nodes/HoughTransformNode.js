import {Wave,SurfaceTrace,Scatter3DTrace,XYTrace} from "../formats.js"
import {NodeWithRightAccordionGraph} from "./NodeWithRightAccordionGraph.js"
import {Plot3DWebGL} from "../ui/Plot3DWebGL.js"
import {Plot2D} from "../ui/Plot2D.js"
import {CE,stylize} from "../util.js"
import {wavesFromInput} from "../utils/index.js"
import {scorePairs,scoreCutoffs} from "../chemistry.js"
import {computePool} from "../workerPool.js"

/* LA COULEUR DU SEUIL, au niveau module : c'est elle qui départage les
   candidats (et non plus une k·MAD parmi d'autres), et trois endroits
   doivent s'accorder dessus — le paint de la barre, son étiquette et le
   readout sous le graphe. */
const OTSU_COLOR="#2ecc71"


/* =====================================================================
   HoughTransformNode — the Hough accumulator of (slope, intercept), as a
   surface on [-1,1]^2.

   THE SHAPE OF THE NODE, settled first:
     • one input, one output;
     • the input is multiplexed (any number of XY waves on input 0) and
       every wave is accumulated into the SAME surface;
     • the output is ONE wave, a 3-column grid [x, y, z] already mapped
       on [-1,1]^2, which is exactly what a Rust kernel would return and
       what a BufferGeometry wants.

   THE ACCUMULATION IS THE KERNEL'S: `startResolve` flattens every accepted
   XY wave into one [masses…, intensities…] core — the layout `houghPrepare`
   splits in half — and runs `computePool.run("houghTransform", …)`. The
   worker answers with the grid, the pair count and how many peaks were fed;
   all three reach the readout and the metadata, so a refusal (<2 usable
   peaks) is NAMED instead of passing for a flat "no relation found". The
   grid sizes, the (slope, intercept) box and the view stay the node's.

   THE VIEW is a Plot3DWebGL — the 3D counterpart of Plot2DWebGL, built on
   GLSceneLayer. It used to hijack a Plot2DWebGL, and that cost four
   workarounds: a perspective camera swapped over the orthographic one (and
   over Plot2DWebGL's own `glCamera` alias), a `svg.main` hidden because it
   covered the canvas and ate the pointer, margins pinched to 8 because they
   were reserved for axes that meant nothing, and a capture-phase listener on
   the dialog to get the events back. None of that is here any more: the 3D
   layer is perspective by construction, the overlay is transparent to the
   pointer, there are no 2D margins, and the gestures live on the container.
   ===================================================================== */

/* THE (SLOPE, INTERCEPT) DOMAIN, kept in one place because three things must
   agree on it: what the node asks the kernel for, what the axis labels claim,
   and what the metadata of the output wave records. The wave's x,y are
   NORMALISED onto [-1,1] — each axis linearly mapped from this box — and the
   box travels with the wave, so the mapping stays reversible.

   The domain is deliberately NARROW: slopes within ±0.001, intercepts within
   ±0.2. A pair whose line falls outside votes for NOTHING (the kernel drops
   it, and the readout's pair count says how many survived), so this box IS
   the question the surface answers. The defaults below double as the kernel
   default (worker: bounds ?? [-0.001,0.001,-0.2,0.2]), restated here so the
   node owns what it asks for rather than inheriting it. */

export class HoughTransformNode extends NodeWithRightAccordionGraph{
    constructor(title,origin,destinationFlow,position={x:180,y:10}){
        //one multiplexed input, one grid output
        super(title,[[]],[[]],origin,destinationFlow,position)
        this.status="floating"
        /* grid sizes, how tall the surface is drawn, and which colormap.
           Plain numbers on `parameters` because serializeState() owns them. */
        this.parameters.gridX=512
        this.parameters.gridY=512
        this.parameters.heightScale=0.55
        /* An accumulator is peaked by nature: one relation gathers the votes of
           every pair at once, so its range is one cell against thousands. On a
           linear scale that is a flat sheet with a needle, which is why log is
           the default here and the linear scale is the opt-in. */
        this.parameters.heightScaleLog=true
        /* EN MINUSCULES : les clés de COLORMAPS (Plot3DWebGL) et les `value`
           du select sont minuscules — « Tcherenkov » ne trouvait ni l'une ni
           l'autre et la surface retombait sur la viridis par défaut. */
        this.parameters.colormap="tcherenkov"
        this.parameters.showScatter=false
        /* The (slope, intercept) box the kernel is asked for. Editable from
           the inspector and persisted with the session. */
        this.parameters.slopeMin=-0.001
        this.parameters.slopeMax=0.008
        this.parameters.interceptMin=-5
        this.parameters.interceptMax=0.2
        /* THE KERNEL'S OWN KNOBS. They live here rather than in the worker
           because they are DECISIONS the user makes about their data, and a
           default buried in kernelWorker.js is a decision nobody took:
           - keep:      the N most intense peaks, 0 = all of them. Above a few
                        hundred peaks the pair count is quadratic, and the
                        extra pairs are the weakest ones.
           - neighbours: how many occupied cells each cell averages over. THIS
                        IS THE SHAPE OF THE OCTAGONS: the kernel convolves with
                        k discrete gaussians, not with a continuous one, so a
                        small k gives a polygon with k sides and a large one
                        gives a round blob that costs a scan per cell.
           - bandwidth: the floor added to the local covariance, in cells. It
                        is what keeps a lone occupied cell from having a
                        singular one — and the ceiling, past which the ellipse
                        is wider than the grid. */
        this.parameters.keep=0
        this.parameters.neighbours=2
        this.parameters.bandwidth=0.5
        /* LA LISTE D'ÉLÉMENTS. `signatureCharges` parce que A_E/z change de pente
           avec z: le carbone à z=1 est de pente nulle (12.000000/1), le même
           carbone à z=3 donne 4.000000 et reste nul, mais l'azote à z=7 tombe à
           2.00044 et devient détectable. Une seule charge ne verrait qu'une
           fraction des séries réellement présentes.

           PAS DE TOLÉRANCE : la détection est un ordre, pas un filtre — chaque
           paire vote pour le candidat le plus proche en pente, et le compte
           des votes fait le tri. Un seuil serait une façon de mettre un filtre
           là où la formulation n'en demande aucun. */
        this.parameters.signatureCharges=[1]
        this.surface=null
        this.collectedWaves=[]
        this.lastAnswer=null
        this.detection=[]
        /* LE SEUIL DE SÉLECTION DU GRAPHE DE SCORE : null = suivre l'Otsu
           (ce que les données devinent), une valeur = la main de l'utilisateur
           posée en glissant la barre verte. Champ d'instance, PAS persisté :
           il n'a de sens que vis-à-vis de la distribution courante, et un
           seuil relu sur une session rechargée mentirait sur des scores
           recalculés. Le bouton Guess remet null. */
        this.scoreThreshold=null
        /* Monotonic ticket — FKMDNode's pattern: a resolve waiting on the
           worker must not be overwritten by a newer one that started while it
           was still in flight. */
        this.resolveRun=0
        this.kernelErrors=[]
        const inputAnchors=this.DOMelt.querySelectorAll('.input.anchor')
        if(inputAnchors[0]) inputAnchors[0].innerHTML='<title>Input: one or more XY waves (X=mass, Y=intensity), accumulated together</title>'
        const outputAnchors=this.DOMelt.querySelectorAll('.output.anchor')
        if(outputAnchors[0]) outputAnchors[0].innerHTML='<title>Output: one grid wave [x, y, z] on [-1,1]^2</title>'
    }
    /* THE 3D PLOT IS THE ONLY ONE THIS NODE HAS. Declared here rather than
       created after super.registered(): the base class would otherwise open a
       Plot2DWebGL first, and disposing it a moment later still burns a WebGL
       context. Browsers cap those per page — Chrome at 16 — and past the cap
       it drops the OLDEST LIVE one, which belongs to a plot the user is still
       looking at. So one node, one context, from the start. */
    /* The (slopeMin, slopeMax, interceptMin, interceptMax) box the kernel is
       asked for. Read through this so the inspector and the kernel always agree. */
    bounds(){
        return [this.parameters.slopeMin,this.parameters.slopeMax,
                this.parameters.interceptMin,this.parameters.interceptMax]
    }
    /* The Hough surface lies on a VERTICAL plane of the cube, so the camera
       belongs in the horizontal one: theta 0, phi pi/2 looks the surface
       face-on. The plot's own pi/4, pi/3 is a 30-degree oblique and turns the
       surface nearly edge-on. */
    createGraph(dialog,label){
        const plot=new Plot3DWebGL([],`${label} surface`,this.origin,dialog.DOMelt.content,
            {theta:0,phi:Math.PI/2})
        const b=this.bounds()
        plot.axisLabels={x:`slope [${b[0]}, ${b[1]}]`,y:`intercept [${b[2]}, ${b[3]}]`,z:"intensity"}
        return plot
    }
    registered(e){
        if(e.detail.msg.caster!==this||this.accordion){
            return
        }
        super.registered(e)
        /* L'Hough surface est un plan vertical : l'orthographique est la vue
           naturelle (pas de perspective qui écrase le relief). */
        this.graph?.setCameraType?.(true)
        this.setupUI()
        //the first resolve runs the kernel on NO input at all: it publishes a
        //zeroed grid whose readout names the refusal, so the view is never an
        //empty grey box — and never a flat surface without saying why
        this.startResolve().then(()=>this.resolveChildren())
    }

    /* --- inspector ---------------------------------------------------- */
    setupUI(){
        if(!this.accordion) return
        const content=this.accordion.DOMelt.content
        content.replaceChildren()
        this.accordion.setSizingMode("content")
        stylize(content,{
            display:"grid",
            "grid-template-columns":"auto minmax(0, 1fr)",
            padding:"4px",
            gap:"4px",
            "align-items":"center",
            "font-size":"0.85em"
        })
        const numberField=(label,key,min,max)=>{
            const caption=CE("label",{},[label])
            const input=CE("input",{type:"number",value:this.parameters[key],min,max,step:1},[])
            stylize(input,{width:"100%","box-sizing":"border-box",fontFamily:"inherit","font-size":"0.9em"})
            input.addEventListener("change",()=>{
                const value=Math.max(min,Math.min(max,Math.trunc(Number(input.value))||min))
                this.parameters[key]=value
                input.value=value
                this.startResolve().then(()=>this.resolveChildren())
            })
            content.append(caption,input)
            return input
        }
        const decimalField=(label,key,min,max,step=0.0001,decimals=4)=>{
            const caption=CE("label",{},[label])
            const input=CE("input",{type:"number",value:this.parameters[key].toFixed(decimals),min,max,step},[])
            stylize(input,{width:"100%","box-sizing":"border-box",fontFamily:"inherit","font-size":"0.9em"})
            input.addEventListener("change",()=>{
                const value=Math.max(min,Math.min(max,Number(input.value)||this.parameters[key]))
                this.parameters[key]=value
                input.value=value.toFixed(decimals)
                this.startResolve().then(()=>this.resolveChildren())
            })
            content.append(caption,input)
            return input
        }
        this.gridXInput=numberField("grid x","gridX",8,512)
        this.gridYInput=numberField("grid y","gridY",8,512)
        this.slopeMinInput=decimalField("slope min","slopeMin",-1,1)
        this.slopeMaxInput=decimalField("slope max","slopeMax",-1,1)
        this.interceptMinInput=decimalField("intercept min","interceptMin",-10,10)
        this.interceptMaxInput=decimalField("intercept max","interceptMax",-10,10)
        this.keepInput=numberField("keep (0 = all)","keep",0,20000)
        this.neighboursInput=numberField("neighbours","neighbours",2,256)
        this.bandwidthInput=decimalField("bandwidth","bandwidth",0.05,50,0.05,2)
        const kernelHint=CE("div",{style:{"grid-column":"1 / -1",opacity:"0.7","font-size":"0.9em"}},
            ["the kernel's own settings: each cell is averaged over its n nearest occupied neighbours with a local covariance, so n is the number of sides of the blobs and bandwidth their minimum width"])
        content.append(kernelHint)
        const chargeField=(label,key,min,max)=>{
            const caption=CE("label",{},[label])
            const input=CE("input",{type:"number",value:this.parameters[key].join(" "),min,max,step:1},[])
            stylize(input,{width:"100%","box-sizing":"border-box",fontFamily:"inherit","font-size":"0.9em"})
            input.addEventListener("change",()=>{
                /* A LIST IS PARSED, NOT CLAMPED. `Math.trunc("1 2 3")` is NaN,
                   and a NaN that silently becomes the minimum would leave the
                   widget showing "1 2 3" while the detector runs on charge 1 —
                   a control that lies about its own value, which is worse than
                   one that refuses. */
                const charges=String(input.value).split(/[^0-9]+/)
                    .map(v=>Math.trunc(Number(v)))
                    .filter(v=>Number.isFinite(v)&&v>=min&&v<=max)
                this.parameters[key]=charges.length?charges:[1]
                input.value=this.parameters[key].join(" ")
                this.startResolve().then(()=>this.resolveChildren())
            })
            content.append(caption,input)
            return input
        }
        this.chargesInput=chargeField("signature charges","signatureCharges",1,12)
        /* PAS DE LISTE D'ÉLÉMENTS ÉCRITE : le graphe de score porte déjà un
           candidat par rang, symbole au-dessus de chaque barre — une deuxième
           copie en texte ne faisait que diverger d'un graphe qui bouge. */
        const detectionHint=CE("div",{style:{"grid-column":"1 / -1",opacity:"0.7","font-size":"0.9em"}},
            ["each peak of the accumulator is a slope; an element answers when A/z = k/(1-s) — the score graph below ranks the candidates"])
        content.append(detectionHint)
        /* LE GRAPHE DU SCORE — barres linéaires par candidat, une barre de
           seuil verte DÉPLAÇABLE à la souris (Otsu par défaut). Rendu avec
           Plot2D (SVG) au lieu d'un canvas brut. Le wrapper a une hauteur
           fixe parce que Plot2D lit clientHeight pour dessiner. */
        this.scoreWrapper=CE("div",{
            style:{"grid-column":"1 / -1",height:"150px",overflow:"hidden",cursor:"ns-resize"}
        },[])
        content.append(this.scoreWrapper)
        this.scorePlot=new Plot2D([],"HoughTransform score",this.origin,this.scoreWrapper)
        /* PAS DE ZOOM : ce graphe est une LECTURE du seuil. Les axes sont
           épinglés par renderScoreGraph (autoDomain=false) ; la molette, le
           pan et le double-clic reset remettraient des domaines que personne
           ne redemande — et les barres ne sont même plus des traces. */
        this.scorePlot.allowZoom=false
        /* TOUT LE REPEINT VIENT DU CACHE : barres, étiquettes d'éléments,
           médiane et barre de seuil sont peints par _paintScoreOverlay()
           depuis this._scoreOverlay, et l'enveloppe de drawGraph le rappelle
           après chaque redessin (resize compris). C'est ce qui fait suivre
           les étiquettes au redimensionnement : posées une fois hors du
           chemin de redraw, elles restaient accrochées à d'anciens pixels. */
        const origDrawGraph=this.scorePlot.drawGraph.bind(this.scorePlot)
        this.scorePlot.drawGraph=(...args)=>{
            const out=origDrawGraph(...args)
            this._paintScoreOverlay()
            return out
        }
        /* LA BARRE DE SEUIL PREND LA SOURIS : pointerdown dans la zone, et le
           seuil SAUTE à la hauteur du pointeur puis le suit (le motif du
           Trimmer — teleport + drag, sans aller chercher la barre au préalable).
           Plot2D ne peut pas le faire lui-même : allowZoom=false a éteint ses
           gestes, et c'est voulu. */
        this._onScorePointerDown=(event)=>this.handleScorePointerDown(event)
        this.scorePlot.container.addEventListener("pointerdown",this._onScorePointerDown)
        /* LA LIGNE DE COMMANDE DU SEUIL : le bouton Guess rend la main à
           l'Otsu, le readout dit ce qui est en vigueur — l'Otsu suivi, ou le
           seuil posé à la main. Sans ce readout, un seuil déplacé et un seuil
           Otsu se ressemblent et l'utilisateur ne sait plus ce qu'il regarde. */
        const thresholdRow=CE("div",{
            style:{"grid-column":"1 / -1",display:"flex",gap:"6px","align-items":"center"}
        },[])
        this.thresholdGuessBtn=CE("button",{
            type:"button",
            title:"Put the threshold back on the Otsu value computed from the scores"
        },["Guess"])
        stylize(this.thresholdGuessBtn,{padding:"2px 8px",cursor:"pointer"})
        this.thresholdGuessBtn.addEventListener("click",()=>this.guessScoreThreshold())
        this.thresholdReadout=CE("span",{
            style:{opacity:"0.8",whiteSpace:"nowrap",fontFamily:"ui-monospace, monospace","font-size":"0.85em"}
        },[])
        thresholdRow.append(this.thresholdGuessBtn,this.thresholdReadout)
        content.append(thresholdRow)
        const thresholdHint=CE("div",{style:{"grid-column":"1 / -1",opacity:"0.7","font-size":"0.9em"}},
            ["drag inside the graph to move the threshold — candidates below it fade to 50 %; Guess restores the Otsu cut"])
        content.append(thresholdHint)
        const scaleCaption=CE("label",{},["height scale"])
        this.scaleInput=CE("select",{},[])
        for(const [value,label] of [["log","log — ridges visible"],
                                    ["linear","linear — peak height"]]){
            this.scaleInput.append(CE("option",{value},[label]))
        }
        this.scaleInput.value=this.parameters.heightScaleLog?"log":"linear"
        stylize(this.scaleInput,{width:"100%",fontFamily:"inherit","font-size":"0.9em"})
        this.scaleInput.addEventListener("change",()=>{
            this.parameters.heightScaleLog=this.scaleInput.value==="log"
            this.applyTraces()
        })
        content.append(scaleCaption,this.scaleInput)
        const scaleHint=CE("div",{style:{"grid-column":"1 / -1",opacity:"0.7","font-size":"0.9em"}},
            ["a vote count spans orders of magnitude: one relation can collect the votes of every pair at once, and on a linear scale that flattens the whole surface into a sheet"])
        content.append(scaleHint)
        const mapCaption=CE("label",{},["colormap"])
        this.mapInput=CE("select",{},[])
        for(const [value,label] of [["tcherenkov","Tcherenkov"],["viridis","viridis"],
                                    ["grayscale","grayscale"],["coolwarm","cool / warm"]]){
            this.mapInput.append(CE("option",{value},[label]))
        }
        this.mapInput.value=this.parameters.colormap
        stylize(this.mapInput,{width:"100%",fontFamily:"inherit","font-size":"0.9em"})
        this.mapInput.addEventListener("change",()=>{
            this.parameters.colormap=this.mapInput.value
            this.applyTraces()
        })
        content.append(mapCaption,this.mapInput)
        const scatterCaption=CE("label",{},["grid points"])
        this.scatterInput=CE("input",{type:"checkbox"},[])
        this.scatterInput.checked=!!this.parameters.showScatter
        stylize(this.scatterInput,{justifySelf:"start"})
        this.scatterInput.addEventListener("change",()=>{
            this.parameters.showScatter=this.scatterInput.checked
            this.applyTraces()
        })
        content.append(scatterCaption,this.scatterInput)
        const hint=CE("div",{style:{"grid-column":"1 / -1",opacity:"0.7"}},["drag: orbit · shift+drag: pan · wheel: zoom · double-click: reframe · shift+double-click: perspective ↔ orthographic"])
        content.append(hint)
        this.readout=CE("div",{style:{"grid-column":"1 / -1","white-space":"pre-wrap",opacity:"0.85"}},[])
        content.append(this.readout)
    }
    renderReadout(){
        if(!this.readout) return
        if(!this.surface){
            this.readout.textContent="no surface"
            return
        }
        const {nx,ny}=this.surface
        const lines=[
            `grid ${nx} x ${ny} = ${nx*ny} nodes — the (slope, intercept) sampling, not your data`,
            `votes in [${this.surface.zMin.toFixed(4)}, ${this.surface.zMax.toFixed(4)}]`,
            `height scale: ${this.parameters.heightScaleLog?"log":"linear"}` +
                (this.surface.zMax>0?` (max/min = ${(this.surface.zMax/Math.max(this.surface.zMin,1e-9)).toPrecision(3)})`:" — the range says nothing on a zero surface"),
            `inputs accumulated: ${this.collectedWaves.length}`,
            `peaks fed: ${this.surface.prepared} of ${this.surface.points} points`,
            `pairs voting: ${this.surface.pairs} — one line through each couple of peaks`,
            `kernel: keep ${this.parameters.keep||"all"}, ${this.parameters.neighbours} neighbours, bandwidth ${this.parameters.bandwidth}`,
            `elements: ${this.detection?.length??0} signature(s) over charges ${this.parameters.signatureCharges.join(", ")}`,
            `domain: slope [${this.surface.bounds[0]}, ${this.surface.bounds[1]}] intercept [${this.surface.bounds[2]}, ${this.surface.bounds[3]}]`
        ]
        if(this.collectedWaves.length&&!this.kernelErrors.length&&this.surface.prepared<2){
            lines.push("refused: fewer than 2 usable peaks — the zeros are the kernel's answer, not a relation")
        }
        for(const err of this.kernelErrors??[]){
            lines.push(`kernel: ${err}`)
        }
        if(this.skippedInputs){
            lines.push(`${this.skippedInputs} entrée(s) ignorée(s): pas une wave XY`)
        }
        this.readout.textContent=lines.join("\n")
    }

    /* --- detection --------------------------------------------------- */
    /* LA TABLE, UNE FOIS ET SUR DEMANDE. Le motif est celui d'AttributionNode
       et de FKMDNode, pour la même raison: la table appartient à l'ORIGIN et
       doit être ATTENDUE, jamais lue en direct — l'App la charge en tâche de
       fond, donc un nœud qui lit `origin.table` au réveil annonce "no table"
       sur une table qui est encore en vol.

       Le cache s'appelle `loadedTable` et non `table` parce que le champ et la
       méthode ne peuvent pas porter le même nom: l'affectation du constructeur
       poserait une propriété propre qui masque la méthode, et le
       `this.table()` suivant lève "this.table is not a function" — ce qui est
       arrivé, et a emporté le nœud à la création. */
    async table(){
        if(this.loadedTable) return this.loadedTable
        if(this.origin.table){
            this.loadedTable=this.origin.table
            return this.loadedTable
        }
        const loaded=await this.origin.tableReady
        this.loadedTable=loaded??null
        return this.loadedTable
    }

    /* LE PROFIL DE PENTE: la masse de votes par colonne.

       La grille est indexée cell(y)*nx + CELL(x), donc nx court sur la PENTE et
       ny sur l'intercept. Sommer une colonne revient donc à dire « combien de
       votes cette pente a recueillis, tous intercepts confondus » — ce qui est
       la FRÉQUENCE d'apparition d'une signature, mesurée par le noyau lui-même
       et non estimée par la suite.

       Why this and not a peak list: the accumulator's peak in slope is the
       thing to count, and a column sum is that count already smoothed by the
       grid. A peak finder on the surface would answer the same question while
       depending on the bandwidth and the neighbour count the user just
       changed. */
    slopeProfile(){
        const answer=this.lastAnswer
        if(!(answer?.grid instanceof Float64Array)) return null
        const {nx,ny}=this.gridSize()
        if(answer.grid.length!==nx*ny) return null
        const profile=new Float64Array(nx)
        for(let iy=0;iy<ny;iy++){
            const row=iy*nx
            for(let ix=0;ix<nx;ix++){
                const v=answer.grid[row+ix]
                if(Number.isFinite(v)) profile[ix]+=v
            }
        }
        let max=0
        for(const v of profile) if(v>max) max=v
        return {profile,max}
    }

    /* UN MAXIMUM LOCAL, et le CENTROÏDE de son bassin.

       Le centroïde plutôt que la colonne elle-même: le vote d'une paire est
       réparti sur quatre cases (bilineaire, dans le noyau), donc la case la
       plus forte est décalée du centre réel de la tache. La moyenne pondérée par
       le profil, sur le bassin au-dessus de la moitié du maximum, revient au
       centre — et c'est ce centre qui est comparé à la masse NIST.

       Le bassin est borné par `mergeRadius` colonnes: sans borne, deux pics
       voisins et leurs bassins se touchent et un seul maximum les attire tous
       les deux. */
    /* Un paramètre nommé, et NON un déstructuré.

       Les tests de ce dépôt extraient le CORPS d'une méthode hors de son
       fichier et l'évaluent: `slopePeaks({profile,max})` perdrait ses deux
       paramètres avec la signature et l'appelerait sur un `profile` qui n'existe
       pas. Un paramètre nommé se reconstruit dans le harnais en une ligne,
       alors qu'un motif déconstruit demande de deviner la signature. */
    slopePeaks(summary,{mergeRadius=3}={}){
        const {profile,max}=summary
        if(!profile?.length||!(max>0)) return []
        const floor=max*1e-6
        const at=j=>profile[Math.min(profile.length-1,Math.max(0,j))]
        /* STRICT ON ONE SIDE. A plateau satisfies `>=` on both, so with a
           non-strict test a FLAT surface yields nx peaks — one per column —
           and the widget then reports a full table of elements that the data
           does not contain. A constant accumulator is the absence of a peak,
           not nx of them. */
        const isPeak=j=>at(j)>=at(j-1)&&at(j)>=at(j+1)&&(at(j)>at(j-1)||at(j)>at(j+1))&&at(j)>floor
        const candidates=[]
        for(let j=0;j<profile.length;j++) if(isPeak(j)) candidates.push(j)
        /* TWO PEAKS INSIDE THE RADIUS ARE ONE PEAK. The smoothing spreads a
           relation over several columns by construction, so taking the local
           maxima raw reports one relation three times, and the widget then
           lists the same element as if it had been found three times over. */
        const kept=[]
        for(const j of candidates){
            const previous=kept[kept.length-1]
            if(previous&&j-previous.column<=mergeRadius){
                if(at(j)>at(previous.column)) kept[kept.length-1]={column:j}
                continue
            }
            kept.push({column:j})
        }
        const out=[]
        for(const {column} of kept){
            let sum=0
            let weight=0
            for(let j=Math.max(0,column-mergeRadius);j<=Math.min(profile.length-1,column+mergeRadius);j++){
                const v=profile[j]
                if(v<max/2) continue
                sum+=j*v
                weight+=v
            }
            const centre=weight>0?sum/weight:column
            out.push({column,centre,mass:at(column),
                share:max>0?at(column)/max:0})
        }
        return out
    }

    /* LA LISTE. Les PAIRES d'abord, parce que le lien est déjà dedans.

       Le noyau rend, depuis cette version, le plan des paires qui ont voté :
       chaque paire porte sa pente ET son écart de masse, ensemble, dans le
       même enregistrement. Un histogramme global des écarts dirait quels pas
       ont eu lieu, pas QUELLE pente chacun a votée — et recoller les deux
       après coup serait une devinette, pas une lecture.

       Le classement est la SOMME DES POIDS : |1/(dm - n.A/z)| par paire, pas le compte. Quelques votes tres bons battent des votes mediocres. Les multiples partagent la pente (l'entier se simplifie dans eps/A). Le critere entier est round(dm)/round(A/z) SANS tolerance : un entier est un entier. */
    async detectElements(){
        const table=await this.table()
        const pairs=this.lastAnswer?.pairs
        if(!table||!(pairs?.length)){ this.detection=[]; return this.detection }
        const charges=this.parameters.signatureCharges
        this.detection=scorePairs(table,pairs,{charges})
        return this.detection
    }
    slopeAtColumn(profile,column){
        const [slopeMin,slopeMax]=this.bounds()
        const {nx}=this.gridSize()
        const span=slopeMax-slopeMin
        return slopeMin+span*(column/Math.max(1,nx-1))
    }

    /* PAS DE renderDetection : la liste écrite des candidats a été retirée —
       le graphe de score EST le classement (une barre par rang, symbole au-
       dessus, seuil déplacable), et une copie texte ne faisait qu'en diverger. */

    /* LE GRAPHE DU SCORE — barres linéaires par candidat, une barre de
       seuil VERTE DÉPLAÇABLE à la souris.

       Rendu avec Plot2D (SVG). Seule la MÉDIANE est une trace Plot2D
       (segment horizontal statique) : tout le reste — barres, seuil,
       étiquettes — est peint à la main par _paintScoreOverlay depuis le
       cache `this._scoreOverlay`, et repeinté par l'enveloppe de drawGraph
       à chaque redessin, resize compris. Les axes sont fixes : X = rang
       linéaire, Y = score linéaire.

       LE SEUIL N'EST PLUS UNE LIGNE k·MAD : k=1,2,4 et médiane encombraient
       un graphe dont la seule ligne qui compte est celle qui départage les
       candidats. Ce seuil est l'Otsu par défaut (variance inter-classes
       maximale — aucune constante arbitraire), et la main de l'utilisateur
       le déplace : `this.scoreThreshold` (champ d'instance, PAS persisté —
       un seuil relu sur une session rechargée mentirait sur une
       distribution recalculée) le fixe, Guess le remet à null et suit de
       nouveau l'Otsu. */
    renderScoreGraph(){
        if(!this.scorePlot) return
        const all=this.detection??[]
        if(!all.length){
            this._scoreOverlay=null
            this.scorePlot.setTraces([])
            this.scorePlot.drawGraph()
            this.updateThresholdReadout()
            return
        }
        /* LES STATISTIQUES SE CALCULENT SUR TOUTE LA POPULATION : médiane et
           Otsu sont des statistiques d'ensemble — tronquer avant fausserait. */
        const cutoffs=scoreCutoffs(all)
        const otsuScore=cutoffs?.otsu?.score??null
        const medianScore=cutoffs?.median??null
        /* LE SEUIL EN VIGUEUR : la main si elle existe, sinon l'Otsu. `let` :
           un seuil à la main gardé d'une session de données précédente peut
           dépasser le nouveau domaine après un recalcul, et la ligne se
           peindrait hors-zone — on le ramène dans l'axe (clamp). */
        let threshold=Number.isFinite(this.scoreThreshold)?this.scoreThreshold:otsuScore
        /* LES RANGS AFFICHÉS restent cadrés sur l'OTSU, pas sur le curseur :
           pendant un drag, le cadrage ne doit pas sauter à chaque pas — le
           seuil ne déplace que la ligne et l'estompage. scorePairs trie par
           score décroissant et otsu.score = values[cut] avec nGood = cut+1,
           donc les nGood premiers rangs sont exactement la classe « bonne »,
           plus DEUX FOIS autant des meilleurs en dessous. */
        let rows=all
        let nGood=0
        if(cutoffs?.otsu){
            nGood=cutoffs.otsu.nGood
            rows=all.slice(0,Math.min(all.length,3*nGood))
        }
        const scores=rows.map(r=>Math.max(r.score,0))
        const n=rows.length
        let lo=0
        let hi=Math.max(...scores)
        if(!(hi>lo)) hi=lo+1
        if(threshold!==null){
            threshold=Math.min(Math.max(threshold,lo),hi)
            if(this.scoreThreshold!==null) this.scoreThreshold=threshold
        }
        /* LE SEUIL EST PEINT À LA MAIN ET NON EN TRACE : il doit être
           prenable à la souris, et une trace Plot2D n'a ni pointeurs ni
           drag. Les symboles au-dessus du seuil EN VIGUEUR servent
           d'étiquette — le nom de ce qui est retenu, pas un décompte. */
        const activeGood=threshold===null?all.length:all.filter(r=>r.score>=threshold).length
        /* LES SYMBOLES RETENUS voyagent avec le cache : c'est le nom de ce qui
           est au-dessus du seuil EN VIGUEUR (les barres peintes), pas un
           décompte — ni dans l'étiquette de la ligne, ni dans le readout. */
        const goodSymbols=Number.isFinite(threshold)
            ?rows.filter((r,i)=>scores[i]>=threshold).map(r=>r.symbol)
            :[]
        /* LE CACHE TIENT TOUT LE MOBILIER : barres, étiquettes, médiane,
           seuil — c'est ce que _paintScoreOverlay relit à chaque drawGraph. */
        this._scoreOverlay={rows,scores,lo,hi,n,threshold,otsuScore,median:medianScore,nGood:activeGood,goodSymbols}
        const traces=[]
        /* LA MÉDIANE reste une trace Plot2D : c'est une droite statique, un
           repère de population, sans geste. Le SEUIL, lui, n'est plus une
           trace — il doit être prenable à la souris, et une trace Plot2D
           n'a ni pointeurs ni drag : _paintScoreOverlay le peint. */
        if(Number.isFinite(medianScore)){
            const medWave=Wave.fromCoordinates(
                new Float64Array([0,n-1]),
                new Float64Array([medianScore,medianScore]),
                {title:"median"},
                ["x","y"]
            )
            traces.push(new XYTrace({
                id:"score-median",
                title:"median",
                wave:medWave,
                options:{
                    color:"rgba(255,255,255,0.85)",
                    mode:"segments",
                    line:{size:1},
                    layer:"svg"
                }
            }))
        }
        this.scorePlot.setTraces(traces)
        /* AXES FIXES : le graphe de score est une lecture, pas un espace
           d'exploration. X = rang (linéaire), Y = score (linéaire). */
        this.scorePlot.parameters.axis.bottom.autoDomain=false
        this.scorePlot.parameters.axis.bottom.domain=[-0.5,n-0.5]
        this.scorePlot.parameters.axis.bottom.label="rank"
        this.scorePlot.parameters.axis.bottom.scale="linear"
        this.scorePlot.parameters.axis.left.autoDomain=false
        this.scorePlot.parameters.axis.left.domain=[lo,hi]
        this.scorePlot.parameters.axis.left.label="score"
        this.scorePlot.parameters.axis.left.scale="linear"
        this.scorePlot.drawGraph()
        /* BARRES, ÉTIQUETTES ET SEUIL sont repeints par l'enveloppe de
           drawGraph (voir setupUI) — resize compris. Il ne reste ici qu'à
           dire ce que la lecture affiche. */
        this.updateThresholdReadout()
    }
    /* TOUT LE MOBILIER DU GRAPHE, REPEINT D'UN SEUL COUP : les BARRES
       (dégradé PAR BARRE — blanc opaque au sommet, #46BEFF à 50 % au milieu,
       #01287F transparent à la base ; un dégradé unique sur toute la hauteur
       de l'axe écraserait la falaise : les bons candidats vivent en bas de
       l'axe linéaire), les ÉTIQUETTES de symbole, l'étiquette de la médiane
       et la barre de SEUIL.

       UNE SEULE COUCHE DESSINÉE, `.score-overlay`, APRÈS g.trace : les
       barres y sont d'abord, puis médiane-étiquette et seuil par-dessus.
       Tout y est repeint à CHAQUE drawGraph — l'enveloppe posée à la
       création du plot — ce qui inclut le resize : c'est la condition pour
       que les étiquettes SUIVENT le cadrage, elles qui auparavant étaient
       posées une fois hors du chemin de redraw et restaient accrochées à
       d'anciens pixels pendant que les barres, elles, suivaient. */
    _paintScoreOverlay(){
        const cached=this._scoreOverlay
        if(!this.scorePlot?.graphSVG) return
        const anchor=this.scorePlot.graphSVG.select(".anchor")
        if(anchor.empty()) return
        let layer=anchor.select(".score-overlay")
        if(layer.empty()) layer=anchor.append("g").attr("class","score-overlay")
        /* PLUS DE CANDIDAT : la couche précédente ne doit pas survivre — le
           cache null est l'occasion de laver, pas de faire un no-op. */
        layer.selectAll("*").remove()
        if(!cached) return
        const zone=this.scorePlot.graphzone
        if(!(zone.width>0&&zone.height>0)) return
        const {xScale,yScale}=this.scorePlot.plotScales()
        const {rows,scores,lo,hi,n,threshold,otsuScore,median,goodSymbols}=cached
        /* <defs> must be appended (not selected-into-existence): d3's append
           on an empty selection creates nothing, leaving fill="url(#...)"
           dangling — SVG then refuses to paint the rect at all. Le motif et
           le commentaire viennent de MassCalculatorNode.drawPeakBars. */
        let defs=anchor.select("defs")
        if(defs.empty()) defs=anchor.append("defs")
        /* l'id porte l'id du SVG : les refs url(#…) se résolvent dans tout le
           document, deux plots ne doivent pas répondre au même (règle posée
           par Plot2D.instanceCounter). */
        const gradId=`score-bar-gradient-${this.scorePlot.graphSVG.attr("id")}`
        let gradient=defs.select(`#${gradId}`)
        if(gradient.empty()){
            gradient=defs.append("linearGradient")
                .attr("id",gradId)
                .attr("x1","0%").attr("x2","0%")
                .attr("y1","0%").attr("y2","100%")
            gradient.append("stop").attr("offset","0%").attr("stop-color","#ffffff").attr("stop-opacity","1")
            gradient.append("stop").attr("offset","50%").attr("stop-color","#46BEFF").attr("stop-opacity","0.5")
            gradient.append("stop").attr("offset","100%").attr("stop-color","#01287F").attr("stop-opacity","0")
        }
        const width=Math.max(1,Math.min(6,Math.floor(80/Math.max(n,1))))
        const base=yScale(lo)
        for(let i=0;i<n;i++){
            const top=yScale(scores[i])
            layer.append("rect")
                .attr("x",xScale(i)-width/2)
                .attr("y",top)
                .attr("width",width)
                .attr("height",Math.max(0,base-top))
                .attr("fill",`url(#${gradId})`)
        }
        const xRight=xScale(n-1)+12
        /* L'ÉTIQUETTE DE LA MÉDIANE, à droite, à la hauteur de sa valeur. */
        if(Number.isFinite(median)){
            layer.append("text")
                .attr("class","score-line-label")
                .attr("x",xRight)
                .attr("y",yScale(median)+3)
                .attr("text-anchor","start")
                .attr("font-size","9px")
                .attr("fill","rgba(255,255,255,0.85)")
                .attr("font-family","ui-monospace, monospace")
                .text("median")
        }
        /* LA BARRE DE SEUIL, VERTE, DÉPLAÇABLE : quand la main a bougé le
           seuil, l'OTSU reste affiché en pointillé — l'endroit où « Guess »
           renverrait la barre, et la distance entre la coupure subie et la
           coupure devinée. */
        if(Number.isFinite(otsuScore)&&otsuScore!==threshold){
            const oy=yScale(otsuScore)
            layer.append("line")
                .attr("x1",0).attr("x2",zone.width)
                .attr("y1",oy).attr("y2",oy)
                .attr("stroke",OTSU_COLOR)
                .attr("stroke-width",1)
                .attr("stroke-dasharray","4 3")
                .attr("opacity",0.4)
            layer.append("text")
                .attr("class","score-line-label")
                .attr("x",xRight)
                .attr("y",oy+3)
                .attr("text-anchor","start")
                .attr("font-size","9px")
                .attr("fill",OTSU_COLOR)
                .attr("opacity",0.6)
                .attr("font-family","ui-monospace, monospace")
                .text("otsu")
        }
        if(Number.isFinite(threshold)){
            const y=yScale(threshold)
            layer.append("line")
                .attr("x1",0).attr("x2",zone.width)
                .attr("y1",y).attr("y2",y)
                .attr("stroke",OTSU_COLOR)
                .attr("stroke-width",2)
            /* LA POIGNÉE, à gauche : ce que la souris prend — un repère de
               prise visible sur une ligne de 2 px, qui suit le pointeur. */
            layer.append("path")
                .attr("d",`M0,${y-4} L8,${y} L0,${y+4} Z`)
                .attr("fill",OTSU_COLOR)
            layer.append("text")
                .attr("class","score-line-label")
                .attr("x",xRight)
                .attr("y",y+3)
                .attr("text-anchor","start")
                .attr("font-size","9px")
                .attr("fill",OTSU_COLOR)
                .attr("font-family","ui-monospace, monospace")
                .text(`seuil ${threshold.toPrecision(3)} — ${goodSymbols.length?goodSymbols.join(" "):"aucun"}`)
        }
        /* LE SYMBOLE DE L'ÉLÉMENT au sommet de sa barre — en pâle (50 %)
           sous le seuil EN VIGUEUR : le candidat reste lisible comme
           contexte (c'est un rang affiché), sans rivaliser avec la classe
           « bonne ». */
        for(let i=0;i<n;i++){
            const x=xScale(i)
            const y=yScale(scores[i])
            layer.append("text")
                .attr("class","score-label")
                .attr("x",x)
                .attr("y",y-5)
                .attr("text-anchor","middle")
                .attr("font-size","9px")
                .attr("fill","rgba(255,255,255,0.9)")
                .attr("opacity",Number.isFinite(threshold)&&scores[i]<threshold?0.5:1)
                .attr("font-family","ui-monospace, monospace")
                .text(rows[i].symbol??`?`)
        }
    }
    /* LA MAIN SUR LE SEUIL : pointerdown dans le graphe = le seuil SAUTE à
       la hauteur du pointeur puis le suit jusqu'au relâchement. Le motif
       (teleport + écouteurs window) vient de TrimmerNode.handleTrimPointerDown
       — et pour la même raison : les QUATRE sorties (up, cancel, blur, et
       pointercancel du tactile) doivent toutes désengager, sinon un drag
       interrompu laisse des écouteurs accrochés à window pour le reste de la
       session, en train de repeindre un nœud peut-être détruit. */
    handleScorePointerDown(event){
        if(event.button!==undefined&&event.button!==0) return
        const cached=this._scoreOverlay
        if(!cached||!this.scorePlot?.graphSVG) return
        const plot=this.scorePlot
        const rect=plot.container.getBoundingClientRect()
        const zone=plot.graphzone
        if(!(zone.width>0&&zone.height>0)) return
        const margins=plot.parameters.margins
        const {yScale}=plot.plotScales()
        const {lo,hi}=cached
        /* pixel → valeur : le pointeur projeté sur l'axe Y, clampé dans le
           domaine épinglé — on ne choisit pas un seuil hors des scores. */
        const toThreshold=(clientY)=>{
            const pixel=Math.min(Math.max(clientY-rect.top-margins.top,0),zone.height)
            return Math.min(Math.max(yScale.invert(pixel),lo),hi)
        }
        event.preventDefault()
        this.scoreThreshold=toThreshold(event.clientY)
        this.renderScoreGraph()
        const stopDrag=()=>{
            window.removeEventListener("pointermove",onMove)
            window.removeEventListener("pointerup",stopDrag)
            window.removeEventListener("pointercancel",stopDrag)
            window.removeEventListener("blur",stopDrag)
            this._scoreDragCleanup=null
        }
        const onMove=(moveEvent)=>{
            this.scoreThreshold=toThreshold(moveEvent.clientY)
            this.renderScoreGraph()
        }
        this._scoreDragCleanup=stopDrag
        window.addEventListener("pointermove",onMove)
        window.addEventListener("pointerup",stopDrag)
        window.addEventListener("pointercancel",stopDrag)
        window.addEventListener("blur",stopDrag)
    }
    /* LE SEUIL REDEVIENT CE QUE LES DONNÉES DISENT : null = suivre l'Otsu
       au prochain paint. */
    guessScoreThreshold(){
        this.scoreThreshold=null
        this.renderScoreGraph()
    }
    /* CE QUE LA LECTURE DIT DU SEUIL, à côté du bouton Guess : l'Otsu quand
       il est suivi, la valeur à la main ET l'Otsu de référence quand le
       seuil a été déplacé — sinon on compare à l'aveugle. */
    updateThresholdReadout(){
        if(!this.thresholdReadout) return
        const cached=this._scoreOverlay
        if(!cached||!Number.isFinite(cached.threshold)){
            this.thresholdReadout.textContent="aucun seuil"
            return
        }
        const fmt=(value)=>value.toPrecision(3)
        const names=(cached.goodSymbols??[]).join(" ")||"aucun"
        this.thresholdReadout.textContent=cached.otsuScore!==cached.threshold
            ?`seuil ${fmt(cached.threshold)} · otsu ${fmt(cached.otsuScore)} · ${names}`
            :`otsu ${fmt(cached.threshold)} · ${names}`
    }

    /* --- resolve ------------------------------------------------------ */
    /* THE KERNEL RUNS HERE, off the UI thread, and its answer may land after a
       newer resolve has started: every await is followed by the ticket check,
       so a stale reply is dropped instead of repainting an old grid over a new
       one. `startResolve` never REJECTS — a kernel failure becomes a status
       and a readout line, not an unhandled promise in somebody else's
       `.then()`. */
    async startResolve(){
        this.collectInputWaves()
        const run=++this.resolveRun
        this.kernelErrors=[]
        let answer=null
        if(this.collectedWaves.length){
            const {nx,ny}=this.gridSize()
            try{
                answer=await computePool.run("houghTransform",{
                    core:this.houghCore(),
                    params:{nx,ny,keep:Math.max(0,Math.trunc(this.parameters.keep)||0),
                        neighbours:Math.max(2,Math.trunc(this.parameters.neighbours)||12),
                        bandwidth:Number(this.parameters.bandwidth)||2,
                        bounds:this.bounds()}
                })
            }catch(err){
                if(run!==this.resolveRun) return
                this.kernelErrors=[err.message??String(err)]
            }
        }
        if(run!==this.resolveRun) return
        this.buildSurface(answer)
        /* LA REPONSE DU NOYEAU EST GARDÉE. Le profil de pente la relit pour la
           détection, et il n'y a pas de deuxième appel au noyau: le compter une
           fois de plus coûterait O(n²) sur tous les couples de pics pour
           retrouver un tableau que l'on avait déjà sous la main. */
        this.lastAnswer=answer
        this.outputs[0]=[this.surfaceWave]
        this.setStatus(this.kernelErrors.length?"error"
            :this.collectedWaves.length?"resolved":"floating")
        this.applyTraces()
        /* LA DÉTECTION EST ASYNCRE, parce que la table l'est — et elle est donc
           distincte du resolve: le kernel a déjà sa réponse, l'interprétation
           peut arriver après. Le billet est revérifié à l'arrivée, sinon une
           détection lente repeindrait la liste par-dessus une résolution
           plus récente. */
        await this.detectElements()
        if(run!==this.resolveRun) return
        /* La détection ne fait plus que REPEINDRE le graphe de score — la
           liste texte a été retirée, le graphique porte les candidats. */
        this.renderScoreGraph()
        this.renderReadout()
    }
    /* ONE FLAT [masses…, intensities…] CORE — the layout `houghPrepare` splits
       in half. A single XY wave is already columnar that way, but concatenating
       N wave cores would interleave the two planes, so the halves are rebuilt
       per wave through `index()`, the only accessor the layout guarantees. */
    houghCore(){
        let total=0
        for(const wave of this.collectedWaves) total+=Math.floor(wave.core.length/2)
        const core=new Float64Array(total*2)
        let offset=0
        for(const wave of this.collectedWaves){
            const n=Math.floor(wave.core.length/2)
            for(let i=0;i<n;i++){
                core[offset+i]=wave.core[wave.index(i,0)]
                core[total+offset+i]=wave.core[wave.index(i,1)]
            }
            offset+=n
        }
        return core
    }
    /* THE GRID SIZE, clamped ONCE: the kernel returns a grid sized by the nx/ny
       it was given, and buildSurface must slice it with the SAME numbers — two
       independent clamps that ever disagree would turn into a wrong-length
       grid (or worse, a silently transposed one). */
    gridSize(){
        return {
            nx:Math.max(2,Math.trunc(this.parameters.gridX)||64),
            ny:Math.max(2,Math.trunc(this.parameters.gridY)||48)
        }
    }
    collectInputWaves(){
        const {waves,skipped}=wavesFromInput(this.inputs[0])
        const accepted=[]
        for(const wave of waves){
            //the accumulator is a relation between peaks, so only an XY wave
            //means anything on this input
            if(wave.degree===2&&wave.dims[1]===2){
                accepted.push(wave)
            }
        }
        this.collectedWaves=accepted
        this.skippedInputs=skipped+(waves.length-accepted.length)
        return accepted
    }
    /* The grid, as a 3-column Wave: dims [gridX, gridY, 3], x and y on
       [-1,1], z whatever the kernel produced. Built through the canonical
       `index()` helper so the Wave owns the layout and the geometry is derived
       from it, never the other way round.

       THE KERNEL ORDERS ITS GRID CELL(y)*nx+CELL(x) — slope across x,
       intercept up y — which is this very loop: cell (ix,iy) reads
       grid[iy*nx+ix]. A missing or wrong-length grid (<2 usable peaks, stale
       wasm, a recorded failure) is written as zeros, and the metadata says
       WHICH case it is: a flat surface must never pass for "no relation
       found" without the readout naming the refusal. */
    buildSurface(answer=null){
        const {nx,ny}=this.gridSize()
        const grid=answer?.grid
        const usable=grid instanceof Float64Array&&grid.length===nx*ny
        const prepared=Math.trunc(Number(answer?.prepared))||0
        const pairs=Math.trunc(Number(answer?.count))||0
        const wave=new Wave(nx,ny,3)
        wave.labels=Wave.normalizeLabels(["slope","intercept","intensity"])
        let zMin=Infinity
        let zMax=-Infinity
        for(let iy=0;iy<ny;iy++){
            const v=(iy/(ny-1))*2-1
            for(let ix=0;ix<nx;ix++){
                const u=(ix/(nx-1))*2-1
                const z=usable?grid[iy*nx+ix]:0
                if(z<zMin) zMin=z
                if(z>zMax) zMax=z
                wave.core[wave.index(ix,iy,0)]=u
                wave.core[wave.index(ix,iy,1)]=v
                wave.core[wave.index(ix,iy,2)]=z
            }
        }
        if(!(zMax>zMin)) zMax=zMin+1
        wave.metadata={
            title:`${this.title} (Hough surface)`,
            "hough-surface":true,
            nx,
            ny,
            zMin,
            zMax,
            domain:"[-1,1]^2",
            bounds:[...this.bounds()],
            source:usable?"kernel (computePool houghTransform)"
                :this.kernelErrors.length?`kernel error: ${this.kernelErrors[0]}`
                :answer?"kernel refused the inputs"
                :"no kernel run (no usable input)",
            prepared,
            pairs,
            collected:this.collectedWaves.length
        }
        wave.touch()
        let points=0
        for(const w of this.collectedWaves) points+=Math.floor(w.core.length/2)
        this.surface={nx,ny,wave,zMin,zMax,prepared,pairs,points,bounds:this.bounds()}
        this.surfaceWave=wave
        return wave
    }
    setStatus(status){
        this.status=status
        dispatchEvent(this.events.broadcast.nodeStatusChanged.call(this,status))
    }

    /* Pushing the traces. Separate from buildSurface on purpose: height and
       colormap are TRACE OPTIONS, and changing them re-lays the same wave
       instead of rebuilding it — a 64x48 grid is cheap, but the separation is
       what keeps that true when the kernel makes it 600x600. */
    applyTraces(){
        if(!this.graph||!this.surfaceWave) return
        const traces=[]
        traces.push(new SurfaceTrace({
            id:"hough-surface",
            title:"Hough accumulator",
            wave:this.surfaceWave,
            options:{
                colormap:this.parameters.colormap,
                height:this.parameters.heightScale,
                scale:this.parameters.heightScaleLog?"log":"linear",
                //the data's own range, so a change of grid resolution cannot
                //shift what a colour means
                heightRange:[this.surface.zMin,this.surface.zMax]
            }
        }))
        if(this.parameters.showScatter){
            /* The SAME wave read as a cloud rather than a mesh: it exercises
               Scatter3DTrace on identical data, and shows that the two traces
               agree on the geometry. It is NOT the contributing peak pairs —
               those do not exist until the Rust kernel produces them, and
               claiming otherwise here would be a lie the readout repeats. */
            traces.push(new Scatter3DTrace({
                id:"hough-nodes",
                title:"grid nodes",
                wave:this.surfaceWave,
                options:{size:2,color:"#ffffff",stride:2,opacity:0.75}
            }))
        }
        this.graph.setTraces(traces)
    }

    /* --- persistence -------------------------------------------------- */
    serializeState(){
        return {
            gridX:this.parameters.gridX,
            gridY:this.parameters.gridY,
            heightScale:this.parameters.heightScale,
            heightScaleLog:this.parameters.heightScaleLog,
            keep:this.parameters.keep,
            neighbours:this.parameters.neighbours,
            bandwidth:this.parameters.bandwidth,
            signatureCharges:[...this.parameters.signatureCharges],
            colormap:this.parameters.colormap,
            showScatter:this.parameters.showScatter,
            slopeMin:this.parameters.slopeMin,
            slopeMax:this.parameters.slopeMax,
            interceptMin:this.parameters.interceptMin,
            interceptMax:this.parameters.interceptMax,
            plot:this.graph?.serializeState?.()??null
        }
    }
    restoreState(state){
        if(!state) return
        for(const key of ["gridX","gridY","heightScale","keep","neighbours","bandwidth","slopeMin","slopeMax","interceptMin","interceptMax"]){
            if(Number.isFinite(state[key])) this.parameters[key]=state[key]
        }
        /* LES COLORMAPS SONT STOCKÉES EN MINUSCULES : une session d'avant
           (« Tcherenkov », « glow ») est remise à plat au chargement. */
        if(typeof state.colormap==="string") this.parameters.colormap=state.colormap.toLowerCase()
        if(typeof state.showScatter==="boolean") this.parameters.showScatter=state.showScatter
        if(typeof state.heightScaleLog==="boolean") this.parameters.heightScaleLog=state.heightScaleLog
        if(Array.isArray(state.signatureCharges)&&state.signatureCharges.length){
            this.parameters.signatureCharges=state.signatureCharges
                .map(v=>Math.trunc(Number(v)))
                .filter(v=>Number.isFinite(v)&&v>=1&&v<=12)
        }
        if(this.gridXInput) this.gridXInput.value=this.parameters.gridX
        if(this.gridYInput) this.gridYInput.value=this.parameters.gridY
        if(this.slopeMinInput) this.slopeMinInput.value=this.parameters.slopeMin.toFixed(4)
        if(this.slopeMaxInput) this.slopeMaxInput.value=this.parameters.slopeMax.toFixed(4)
        if(this.interceptMinInput) this.interceptMinInput.value=this.parameters.interceptMin.toFixed(4)
        if(this.interceptMaxInput) this.interceptMaxInput.value=this.parameters.interceptMax.toFixed(4)
        if(this.keepInput) this.keepInput.value=this.parameters.keep
        if(this.neighboursInput) this.neighboursInput.value=this.parameters.neighbours
        if(this.bandwidthInput) this.bandwidthInput.value=this.parameters.bandwidth.toFixed(2)
        if(this.chargesInput) this.chargesInput.value=this.parameters.signatureCharges.join(" ")
        if(this.mapInput) this.mapInput.value=this.parameters.colormap
        if(this.scaleInput) this.scaleInput.value=this.parameters.heightScaleLog?"log":"linear"
        if(this.scatterInput) this.scatterInput.checked=this.parameters.showScatter
        this.startResolve().then(()=>{
            /* The camera is restored AFTER the traces: framing needs the box,
               and the box only exists once there is something in the scene.
               It is BEST-EFFORT: a camera that refuses to restore must not
               take the session import down with it (the rejection would abort
               importSession, leaving every later node uncreated) nor skip the
               children's resolve. */
            try{ this.graph?.restoreState?.(state.plot) }catch(err){
                console.warn(`[${this.title}] camera restore skipped:`,err)
            }
            this.resolveChildren()
        })
    }
    suicide(options={}){
        /* LE DRAG ÉVENTUEL SE TERMINE ICI : pointerup n'arrivera peut-être
           plus jamais (le nœud meurt sous le doigt), et laisser les
           écouteurs window vivre, c'est repeindre un cadavre à chaque
           mouvement de souris. */
        this._scoreDragCleanup?.()
        if(this.scorePlot){
            /* Plot2D n'a pas de dispose() : on retire ses écouteurs nommés
               et on détache son conteneur du DOM. */
            try{this.scorePlot.container.removeEventListener("wheel",this.scorePlot._onWheel)}catch(e){}
            try{this.scorePlot.container.removeEventListener("dblclick",this.scorePlot._onDblClick)}catch(e){}
            try{this.scorePlot.container.removeEventListener("mousedown",this.scorePlot._onMouseDown)}catch(e){}
            try{this.scorePlot.container.removeEventListener("pointerdown",this._onScorePointerDown)}catch(e){}
            if(this.scorePlot.zoomDrawFrame) cancelAnimationFrame(this.scorePlot.zoomDrawFrame)
            if(this.scorePlot.zoomGestureTimer) clearTimeout(this.scorePlot.zoomGestureTimer)
            this.scoreWrapper?.remove()
        }
        this.graph?.dispose?.()
        super.suicide(options)
    }
}
