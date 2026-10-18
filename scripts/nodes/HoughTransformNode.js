import {Wave,SurfaceTrace,Scatter3DTrace,XYTrace} from "../formats.js"
import {NodeWithRightAccordionGraph} from "./NodeWithRightAccordionGraph.js"
import {Plot3DWebGL} from "../ui/Plot3DWebGL.js"
import {Plot2D} from "../ui/Plot2D.js"
import {CE,stylize} from "../util.js"
import {wavesFromInput} from "../utils/index.js"
import {scorePairs,scoreCutoffs} from "../chemistry.js"
import {computePool} from "../workerPool.js"

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
        this.parameters.gridX=256
        this.parameters.gridY=256
        this.parameters.heightScale=0.55
        /* An accumulator is peaked by nature: one relation gathers the votes of
           every pair at once, so its range is one cell against thousands. On a
           linear scale that is a flat sheet with a needle, which is why log is
           the default here and the linear scale is the opt-in. */
        this.parameters.heightScaleLog=true
        this.parameters.colormap="Tcherenkov"
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
        this.parameters.neighbours=12
        this.parameters.bandwidth=2
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
        this.gridXInput=numberField("grid x","gridX",8,256)
        this.gridYInput=numberField("grid y","gridY",8,256)
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
        const detectionCaption=CE("label",{},["elements"])
        const detectionBox=CE("div",{style:{"grid-column":"1 / -1","white-space":"pre-wrap",
            fontFamily:"ui-monospace, monospace","font-size":"0.85em","max-height":"220px",
            "overflow-y":"auto",opacity:"0.95"}},[])
        this.detectionBox=detectionBox
        content.append(detectionCaption,detectionBox)
        const detectionHint=CE("div",{style:{"grid-column":"1 / -1",opacity:"0.7","font-size":"0.9em"}},
            ["each peak of the accumulator is a slope; an element answers when A/z = k/(1-s) — the ranking is the share of votes it collected"])
        content.append(detectionHint)
        /* LE GRAPHE DU SCORE — barres log10 par candidat, lignes k·MAD.
           Rendu avec Plot2D (SVG) au lieu d'un canvas brut. Le wrapper a
           une hauteur fixe parce que Plot2D lit clientHeight pour dessiner. */
        this.scoreWrapper=CE("div",{style:{"grid-column":"1 / -1",height:"150px",overflow:"hidden"}},[])
        content.append(this.scoreWrapper)
        this.scorePlot=new Plot2D([],"HoughTransform score",this.origin,this.scoreWrapper)
        const heightCaption=CE("label",{},["height"])
        this.heightInput=CE("input",{type:"range",min:0.05,max:1,step:0.05,value:this.parameters.heightScale},[])
        stylize(this.heightInput,{width:"100%"})
        this.heightInput.addEventListener("input",()=>{
            this.parameters.heightScale=Number(this.heightInput.value)
            //the height is a TRACE OPTION, not the data: the grid does not
            //change, so no resolve and no re-upload of the wave
            this.applyTraces()
        })
        content.append(heightCaption,this.heightInput)
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
        for(const [value,label] of [["viridis","viridis"],["grayscale","grayscale"],
                                    ["coolwarm","cool / warm"],["tcherenkov","Tcherenkov"],
                                    ["glow","glow — white body, Cherenkov peak"]]){
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

    renderDetection(){
        if(!this.detectionBox) return
        const rows=this.detection??[]
        if(!rows.length){
            this.detectionBox.textContent="no signature in the accumulator"
            this.renderScoreGraph()
            return
        }
        this.detectionBox.textContent=rows.slice(0,14).map((row,i)=>{
            /* LE SCORE, LA PENTE, LE MULTIPLE. La somme des |1/residu| fait le tri : quelques votes tres bons battent des votes mediocres. */
            const delta=(row.bestDelta*1e6).toFixed(1)
            const rank=String(i+1).padStart(2);
            const label=row.symbol.padEnd(3);
            const score=row.score>1e9?row.score.toExponential(2):row.score.toPrecision(4);
            return `${rank}. ${label} z=${row.charge} x${row.topMultiple??"?"} ${row.votes} votes score ${score} dslope ${delta}e-6`;
        }).join("\n")+(rows.length>14?`\n… and ${rows.length-14} more`:"")
        this.renderScoreGraph()
    }

    /* LE GRAPHE DU SCORE — barres linéaires par candidat, lignes k·MAD.

       Rendu avec Plot2D (SVG). Une trace de barres (segments verticaux de 0
       jusqu'au score) et une trace par ligne k·MAD (segments horizontaux,
       couleur distincte par k). Les axes sont fixes :
       X = rang linéaire, Y = score linéaire. Le symbole de chaque élément
       est écrit au-dessus de sa barre. */
    renderScoreGraph(){
        if(!this.scorePlot) return
        const rows=this.detection??[]
        if(!rows.length){
            this.scorePlot.setTraces([])
            this.scorePlot.drawGraph()
            this._clearScoreLabels()
            return
        }
        const scores=rows.map(r=>Math.max(r.score,0))
        const cutoffs=scoreCutoffs(rows,{ks:[1,2,4]})
        let lo=0
        let hi=Math.max(...scores)
        if(cutoffs) hi=Math.max(hi,...cutoffs.lines.map(l=>l.score))
        if(!(hi>lo)) hi=lo+1
        const n=rows.length
        /* BARRES : segments verticaux (rank, 0) → (rank, score).
           Le mode "segments" relie les points deux à deux, donc chaque paire
           consécutive forme une barre. Trait épais = barre épaisse. */
        const barXs=[]
        const barYs=[]
        for(let i=0;i<n;i++){
            barXs.push(i,i)
            barYs.push(lo,scores[i])
        }
        const barWave=Wave.fromCoordinates(
            new Float64Array(barXs),
            new Float64Array(barYs),
            {title:"score bars"},
            ["rank","score"]
        )
        const barTrace=new XYTrace({
            id:"score-bars",
            title:"scores",
            wave:barWave,
            options:{
                color:"rgba(120,160,220,0.8)",
                mode:"segments",
                line:{size:Math.max(1,Math.min(6,Math.floor(80/Math.max(n,1))))},
                layer:"svg"
            }
        })
        const traces=[barTrace]
        /* LIGNES k·MAD : un segment horizontal par valeur de k, chacune dans
           sa propre trace pour avoir une couleur distincte. k=1,2,4. */
        const lineInfos=[]
        if(cutoffs){
            const colors={1:"rgba(255,220,100,0.8)",2:"rgba(255,150,80,0.8)",4:"rgba(255,90,90,0.9)"}
            for(const line of cutoffs.lines){
                const lineWave=Wave.fromCoordinates(
                    new Float64Array([0,n-1]),
                    new Float64Array([line.score,line.score]),
                    {title:`k=${line.k}`},
                    ["x","y"]
                )
                traces.push(new XYTrace({
                    id:`score-mad-k${line.k}`,
                    title:`k=${line.k}`,
                    wave:lineWave,
                    options:{
                        color:colors[line.k]?? "rgba(255,255,255,0.6)",
                        mode:"segments",
                        line:{size:1},
                        layer:"svg"
                    }
                }))
                lineInfos.push({value:line.score,label:`k=${line.k}`,color:colors[line.k]})
            }
            /* LIGNE médiane : median pur, sans facteur k ni MAD.
               Niveau central de la population des scores. */
            const medWave=Wave.fromCoordinates(
                new Float64Array([0,n-1]),
                new Float64Array([cutoffs.median,cutoffs.median]),
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
            lineInfos.push({value:cutoffs.median,label:"median",color:"rgba(255,255,255,0.85)"})
            /* LIGNE Otsu : seuil optimal entre "good" et "bad" par la
               méthode d'Otsu (variance inter-classes maximale). Aucun
               seuil arbitraire — le score de séparation est calculé pour
               chaque coupure possible. */
            if(cutoffs.otsu){
                const otsuWave=Wave.fromCoordinates(
                    new Float64Array([0,n-1]),
                    new Float64Array([cutoffs.otsu.score,cutoffs.otsu.score]),
                    {title:`otsu (${cutoffs.otsu.nGood} good)`},
                    ["x","y"]
                )
                traces.push(new XYTrace({
                    id:"score-otsu",
                    title:"otsu",
                    wave:otsuWave,
                    options:{
                        color:"rgba(100,255,100,0.9)",
                        mode:"segments",
                        line:{size:2},
                        layer:"svg"
                    }
                }))
                lineInfos.push({value:cutoffs.otsu.score,label:`otsu (${cutoffs.otsu.nGood} good)`,color:"rgba(100,255,100,0.9)"})
            }
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
        /* ÉTIQUETTES : symbole de l'élément au-dessus de chaque barre. */
        this._drawScoreLabels(rows,scores,n,hi)
        /* ÉTIQUETTES DES LIGNES : nom de chaque ligne horizontale à droite. */
        this._drawScoreLineLabels(lineInfos,n,hi)
    }
    /* Retire les étiquettes de score précédentes avant un nouveau dessin. */
    _clearScoreLabels(){
        if(!this.scoreWrapper) return
        this.scoreWrapper.querySelectorAll(".score-label,.score-line-label").forEach(el=>el.remove())
    }
    /* Écrit le symbole de chaque élément au sommet de sa barre, en utilisant
       les échelles du plot juste après drawGraph(). */
    _drawScoreLabels(rows,scores,n,hi){
        this._clearScoreLabels()
        if(!this.scorePlot.graphSVG) return
        const {xScale,yScale}=this.scorePlot.plotScales()
        const anchor=this.scorePlot.graphSVG.select(".anchor")
        for(let i=0;i<n;i++){
            const x=xScale(i)
            const y=yScale(scores[i])
            anchor.append("text")
                .attr("class","score-label")
                .attr("x",x)
                .attr("y",y-5)
                .attr("text-anchor","middle")
                .attr("font-size","9px")
                .attr("fill","rgba(255,255,255,0.9)")
                .attr("font-family","ui-monospace, monospace")
                .text(rows[i].symbol??`?`)
        }
    }
    /* Écrit le nom de chaque ligne horizontale (k·MAD, médiane, otsu)
       à droite du plot, à la hauteur de sa valeur score. */
    _drawScoreLineLabels(lineInfos,n,hi){
        if(!this.scorePlot.graphSVG) return
        const {xScale,yScale}=this.scorePlot.plotScales()
        const anchor=this.scorePlot.graphSVG.select(".anchor")
        const xRight=xScale(n-1)+12
        for(const info of lineInfos){
            const y=yScale(info.value)
            anchor.append("text")
                .attr("class","score-line-label")
                .attr("x",xRight)
                .attr("y",y+3)
                .attr("text-anchor","start")
                .attr("font-size","9px")
                .attr("fill",info.color)
                .attr("font-family","ui-monospace, monospace")
                .text(info.label)
        }
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
        this.renderDetection()
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
        if(typeof state.colormap==="string") this.parameters.colormap=state.colormap
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
        if(this.heightInput) this.heightInput.value=this.parameters.heightScale
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
        if(this.scorePlot){
            /* Plot2D n'a pas de dispose() : on retire ses écouteurs nommés
               et on détache son conteneur du DOM. */
            try{this.scorePlot.container.removeEventListener("wheel",this.scorePlot._onWheel)}catch(e){}
            try{this.scorePlot.container.removeEventListener("dblclick",this.scorePlot._onDblClick)}catch(e){}
            try{this.scorePlot.container.removeEventListener("mousedown",this.scorePlot._onMouseDown)}catch(e){}
            if(this.scorePlot.zoomDrawFrame) cancelAnimationFrame(this.scorePlot.zoomDrawFrame)
            if(this.scorePlot.zoomGestureTimer) clearTimeout(this.scorePlot.zoomGestureTimer)
            this.scoreWrapper?.remove()
        }
        this.graph?.dispose?.()
        super.suicide(options)
    }
}
