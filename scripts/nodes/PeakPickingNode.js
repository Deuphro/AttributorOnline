import {NodeWithAccordion} from "../core/index.js"
import {Plot2DWebGL} from "../ui/Plot2DWebGL.js"
import {Wave,XYTrace} from "../formats.js"
import {computePool} from "../workerPool.js"
import {CE,stylize} from "../util.js"
import {CONVENTIONAL_Z,clampClassifierSlope,formatSlope,keepAllSlopeFromFlat,clipSegmentToRect,publishedPeakY,massThroughMask,scaleToggle,wavesFromInput} from "../utils/index.js"
import {PAN_DBLCLICK_GUARD} from "../ui/Plot2D.js"

export class PeakPickingNode extends NodeWithAccordion{

    constructor(title,origin,destinationFlow,position={x:180,y:10}){
        super(
            title,
            [[]],  // 1 input: 1D or 2D wave
            //ONE output again. The index of each kept point used to ride on a
            //second slot so that the Anti-Radio node could walk the profile
            //around it; now that both stages live in this node, the index never
            //leaves it, and an output nothing consumes is just a cable to wire.
            [[]],
            origin,
            destinationFlow,
            position
        )
        this.status="floating"
        //classifier: a line through the origin, death = slope Ã— birth; null
        //until the first data (then fitted to keep every pair) or a click
        this.parameters.slope=null
        this.parameters.slopeAnchorBirth=null // where the marker sits on the line
        this.parameters.filtrationMode="superlevel" // "sublevel" or "superlevel"
        this.parameters.logLogAxes=false
        //anti-radio stage: the same z, the same source tracking, and the same
        //kernel, moved here rather than rewritten
        this.parameters.z=CONVENTIONAL_Z
        this.parameters.zSource="convention"
        this.pairsData=null
        this.lastInputWave=null
        this.dragDebounceTimer=null
        this.graph=null
        this.radioResult=null
        /* MULTIPLEX. Several links on input 0, or one link carrying several
           waves, are the same question: "treat them all the same way". The count
           is read at every resolve and is NOT state — the number of cables is the
           flow's business, not the node's, and writing it into `parameters` would
           put it in every session file for nothing. */
        this.multiplexCount=0
        this.skippedInputs=0
        this.multiplexTotals=null
        //monotonic ticket: a multiplexed resolve walking N spectra must not be
        //overwritten by a newer resolve that came in while it was still walking
        this.resolveRun=0
        /* the slope GUESSED on the first input, which the panel draws and the
           field shows while multiplexed. It is deliberately NOT `parameters.slope`:
           see resolveMultiplexed. */
        this.multiplexSlope=null

        // Tooltips on SVG anchors for clarity
        const inputAnchors=this.DOMelt.querySelectorAll('.input.anchor')
        if(inputAnchors[0]) inputAnchors[0].innerHTML='<title>Input: one Wave (XY or 1D), or several at once — each is then picked on its own data, with the default (guessed) slope and z</title>'
        const outputAnchors=this.DOMelt.querySelectorAll('.output.anchor')
        if(outputAnchors[0]) outputAnchors[0].innerHTML='<title>Output: the picked peaks — one wave per input Wave</title>'
    }

    registered(e){
        if(e.detail.msg.caster !== this || this.accordion){
            return
        }
        super.registered(e)
        this.setupAccordionUI()
    }

    setupAccordionUI(){
        if(!this.accordion) return
        const content = this.accordion.DOMelt.content
        content.replaceChildren()
        stylize(content, {
            display: "grid",
            //three rows, not two: the classifier controls, the plot, and the
            //anti-radio strip below it. The plot is the ONLY flexible one - the
            //two bars are content-sized, so adding a section under the graph
            //cannot squeeze the plot away.
            "grid-template-rows": "auto minmax(0, 1fr) auto",
            minHeight: "0",
            height: "100%",
            overflow: "hidden",
            padding: "4px",
            gap: "4px"
        })
        if(this.accordion.DOMelt.container){
            //A WebGL plot inside an auto-height ("content") accordion is a
            //ResizeObserver feedback loop: fold() blanks the container height,
            //the plot then measures a free box, the box grows with the plot,
            //and the whole left panel is swallowed by the 75% cap. Viewport
            //sizing hands the plot a BOUNDED box (the content becomes a grid
            //row), which is exactly what this accordion layout needs.
            this.accordion.setSizingMode("viewport",{height:360})
            this.accordion.DOMelt.container.style.maxHeight="75%"
        }

        // 1. Persistent-homology section
        //A plain block with a CAPTION, not a folding <details>: the two stages are
        //always in force, so a control that hides them implies they can be
        //switched off, and they cannot. The caption keeps the trace editor's
        //label style so a section header reads the same wherever it appears.
        const phSection=CE("div",{className:"pp-section"},[])
        phSection.append(CE("div",{className:"pp-caption"},["Persistent Homology"]))

        //no "Slope:" caption: it only stole a grid column and pushed the
        //neighbouring panels; the input carries the explanation in its title
        //and the value stays visible and editable. `size` (not width) is what
        //keeps it from eating the row: an input sized to its digits gives way
        //with the column, and the buttons keep their own width.
        this.slopeInput = CE("input", {
            type: "number",
            step: "any",
            size: 6,
            value: Number.isFinite(this.parameters.slope) ? formatSlope(this.parameters.slope) : "",
            placeholder: "auto",
            title: "Classifier slope (< 1): pairs under death = slope Ã— birth are kept",
            style: { width: "100%", minWidth: "0", padding: "2px" }
        }, [])
        this.slopeInput.addEventListener("change", () => {
            const val = parseFloat(this.slopeInput.value)
            if(Number.isFinite(val)){
                this.setSlope(val, true)
            }
        })

        const guessBtn = CE("button", {
            type: "button",
            title: "Fit the line through the mean point (mean death / mean birth)",
            style: { cursor: "pointer", padding: "2px 6px" }
        }, ["Guess"])
        //kept, because updatePeakMultiplex() has to be able to grey it
        this.slopeGuessBtn=guessBtn
        guessBtn.addEventListener("click", () => {
            const slope = this.guessSlope()
            if(slope !== null){
                this.setSlope(slope, true)
            }
        })

        //the SAME one-button scale switch as the trimmer, so both nodes read the
        //same way. It also fixes a drift the inline version had: it started on
        //"Log-log" but wrote "Log" after the first click.
        this.setLogLogAxes=(on)=>{
            this.parameters.logLogAxes=on
            const scale=on?"log":"linear"
            this.graph.parameters.axis.bottom.scale=scale
            this.graph.parameters.axis.left.scale=scale
            this.graph.parameters.axis.bottom.autoDomain=true
            this.graph.parameters.axis.left.autoDomain=true
            this.graph.drawGraph()
        }
        this.logLogBtn=scaleToggle({
            get:()=>this.parameters.logLogAxes,
            set:(on)=>this.setLogLogAxes(on),
            //"Lin / Log" like the trimmer: "Log-log" made this control twice as
            //wide. The tooltip says WHICH axes, the label stays the scale name.
            leftLabel:"Lin",
            rightLabel:"Log",
            title:"Scale of BOTH axes"
        })

        //no unit in the text: it costs width on the narrowest element of the
        //bar, the ratio is self-explanatory and the tooltip spells it out
        this.countLabel = CE("span", {
            className: "pp-readout",
            title: "Pairs kept / total pairs â€” persistence intervals kept under the classifier line"
        }, ["0/0"])

        //minmax(0,1fr) on the input and auto on everything else: the input is the
        //only element allowed to shrink, so the Guess button, the scale switch
        //and the count are the LAST things to disappear, not the first.
        const phRow=CE("div",{
            className:"pp-row",
            style:{gridTemplateColumns:"minmax(0,1fr) auto auto auto",fontSize:"0.85em"}
        },[])
        phRow.append(this.slopeInput, guessBtn, this.logLogBtn, this.countLabel)
        phSection.append(phRow)

        // 2. Graph container
        const graphContainer = CE("div", {
            className: "persistence-graph-container",
            style: {
                position: "relative",
                width: "100%",
                height: "100%",
                minHeight: "180px",
                overflow: "hidden"
            }
        }, [])

        content.append(phSection, graphContainer, this.buildAntiRadioSection())

        // 3. Plot2DWebGL instance
        this.graph = new Plot2DWebGL([], `${this.title} graph`, this.origin, graphContainer)
        this.graph.parameters.axis.bottom.label = "Birth"
        this.graph.parameters.axis.bottom.autoLabel = false
        this.graph.parameters.axis.left.label = "Death"
        this.graph.parameters.axis.left.autoLabel = false
        //The birth axis (bottom) sits 10px LOWER than the default. Increasing the
        //bottom margin moves the axis UP, not down: the margin is the space
        //BELOW the plot, so more of it lifts the frame. Lowering the axis is
        //therefore a SMALLER margin - 52 -> 42. The base margins are what
        //updateMargins() recomputes from, so bumping parameters.margins here
        //would be overwritten on the next redraw, and the value is absolute
        //rather than an increment so a rebuilt accordion cannot shift it twice.
        this.graph.parameters.baseMargins.bottom=38
        this.graph.updateMargins()

        // Hook drawGraph so it always repaints the SVG classifier, and let a
        // plain click anywhere on the plot place it (see handleClassifierClick)
        const origDrawGraph = this.graph.drawGraph.bind(this.graph)
        this.graph.drawGraph = () => {
            origDrawGraph()
            this.updateClassifierSVG()
        }
        this.graph.container.addEventListener("click", (event) => this.handleClassifierClick(event))

        this.graph.drawGraph()
    }

    /* The anti-radio section: a plain block under the plot, captioned like the
       classifier one. The label is a caption, not a caption on the row - a
       label in the grid took a column, and the number it labelled was the one
       element that had to be free to shrink. */
    buildAntiRadioSection(){
        const section=CE("div",{className:"pp-section"},[])
        section.append(CE("div",{
            className:"pp-caption",
            title:"Drops the peaks whose half-height width is out of the width population of this spectrum"
        },["Anti-radio"]))

        this.zInput=CE("input",{
            type:"number",
            step:"0.1",
            min:"0",
            //same reason as the slope: size to the digits so the field is the
            //element that gives way, never the buttons around it
            size:5,
            value:String(this.parameters.z),
            title:"Number of robust sigma above the median width above which a peak is called radio",
            style:{width:"100%",minWidth:"0",padding:"2px"}
        },[])
        this.zInput.addEventListener("change",()=>{
            const z=Number(this.zInput.value)
            //a non-positive or unreadable z would either keep everything or
            //reject on any spread at all: both are silent nonsense
            this.parameters.z=Number.isFinite(z)&&z>0?z:CONVENTIONAL_Z
            this.parameters.zSource="manual"
            //resolveChildren and NOT TrimmerNode.scheduleResolveChildren: that one
            //is a 120 ms debounce for a drag, and there is no drag here.
            this.applySlopeFilter().then(()=>this.resolveChildren())
        })
        const zGuess=CE("button",{
            type:"button",
            title:"Read z from the spectrum: half the gap between the tight peak population and the wide one. Falls back to 3 when the widths form a single population.",
            style:{cursor:"pointer",padding:"2px 6px"}
        },["Guess"])
        //kept, because updatePeakMultiplex() has to be able to grey it
        this.zGuessBtn=zGuess
        zGuess.addEventListener("click",()=>{this.guessZFromKernel()})
        //the measured width reference, and the kept/total ratio. The z is NOT
        //repeated here: it is on screen two cells to the left, and saying it
        //twice in the same row is the kind of redundancy that costs width.
        this.radioRef=CE("span",{
            className:"pp-readout",
            title:"Width reference measured on this spectrum (median peak width), in ppm"
        },[""])
        this.radioLabel=CE("span",{
            className:"pp-readout",
            title:"Peaks kept / candidates entering this stage"
        },[""])
        //ONE row, like the classifier's: the field gives way first (it is the
        //only 1fr), so the reference and the ratio stay put instead of pushing
        //each other off the panel.
        const arRow=CE("div",{
            className:"pp-row",
            style:{gridTemplateColumns:"minmax(0,1fr) auto auto auto",fontSize:"0.85em"}
        },[])
        arRow.append(this.zInput,zGuess,this.radioRef,this.radioLabel)
        section.append(arRow)
        return section
    }
    /* The z the kernel reads off the widths, or null when it cannot read one.

       Split from the commit so the automatic path and the button do the same
       measurement and only differ in what they do with the answer.

       `profile` and `indices` are PARAMETERS because the multiplexed resolve
       asks this question about each spectrum in turn, one at a time: a z read
       on the first spectrum is that spectrum's instrument resolution and says
       nothing about the second one's. The defaults keep the button and the
       automatic path reading the node's own current state. */
    async readZFromKernel(profile=this.lastInputWave,indices=this.persistenceKeptIndices){
        if(!profile||!indices?.length) return null
        //the width is measured on the profile, so there is nothing to read on a
        //1D wave: no mass axis means no ppm, which is the whole point
        if(!(profile.degree===2&&profile.dims[1]===2)) return null
        try{
            const z=await computePool.run("antiRadioGuessZ",{
                core:profile.core,
                pointsIndex:indices,
                params:{stride:2}
            })
            return Number.isFinite(z)&&z>0?z:null
        }catch(err){
            console.warn("[PeakPickingNode] anti-radio guess failed, keeping the current z:",err)
            return null
        }
    }
    applyZ(z,source){
        this.parameters.z=z
        this.parameters.zSource=source
        if(this.zInput) this.zInput.value=String(Number(z.toFixed(2)))
    }
    /* The Guess button: read a z and commit it whatever the current one is.
       A guess is not a privileged way of setting z, it is a way of CHOOSING
       it, so it goes through the same commit as the field. */
    async guessZFromKernel(){
        const z=await this.readZFromKernel()
        if(z===null) return
        this.applyZ(z,"guess")
        await this.applySlopeFilter()
        this.resolveChildren()
    }
    /* The z the filter runs with when nobody has chosen one, read from the
       spectrum like the slope's "auto".

       The condition is zSource, NOT "is z finite": z defaults to the 3Ïƒ
       convention, which is finite, so a finiteness test would never fire and
       the auto path would be dead code.

       A reading of exactly the convention is treated as NO reading: the kernel
       returns 3.0 both when it measured a gap and when it had no population to
       measure, and the two are not distinguishable from the number alone. So
       the state stays "convention" and the next resolve tries again - a first
       resolve on a short spectrum can be too poor to read, and the second one
       may not be. A genuine reading of 3.00 simply re-reads the same value. */
    async resolveZIfUnset(){
        if(this.parameters.zSource!=="convention") return
        const z=await this.readZFromKernel()
        if(z===null) return
        this.applyZ(z, z===CONVENTIONAL_Z ? "convention" : "guess")
    }
    /* Two readouts, matching the classifier's: the width reference in ppm, and
       the kept/total ratio. Neither carries the z - it is already in the field
       beside them - nor the word "ref", which only ever repeated the unit the
       number states. The ratio uses the same .pp-readout class as the
       classifier's count, so the two rows end on the same visual note. */
    renderRadioReadout(result, candidateCount){
        if(this.radioLabel) this.radioLabel.textContent=result?`${result.keptCount} / ${candidateCount}`:""
        if(!this.radioRef) return
        //no reference means the widths were not measurable, and "â€”" says that
        //without pretending the filter ran and found nothing
        this.radioRef.textContent=result&&Number.isFinite(result.referencePpm)
            ?`${result.referencePpm.toFixed(1)} ppm`
            :"â€”"
    }
    /* EVERY WAVE THE INPUT CARRIES, in link order.

       Unlike F-KMD's, nothing is refused here: the classifier runs on a 1D wave
       just as well as on an XY one — it is the anti-radio stage, further down,
       that needs a mass axis. A 1D input is therefore not skipped, it is
       published with stage 2 unrun, which is the truth about it. */
    collectInputWaves(){
        return wavesFromInput(this.inputs[0])
    }
    /* The FIRST of them, for the paths that only ever looked at one. */
    extractInputWave(){
        return this.collectInputWaves().waves[0]??null
    }
    /* True when this node is being asked to treat SEVERAL spectra the same way
       instead of tuning one. A property of the LINKS, read fresh on every
       resolve: a second cable changes the node's mind, and pulling it out gives
       the single-input behaviour back. */
    isMultiplexed(){
        return this.multiplexCount>1
    }
    /* The slope the PANEL draws and its field shows.

       `parameters.slope` for a single input — that is the user's line, or the
       kernel's fit when they never chose one. For several, the guess made on
       the FIRST input, and NOTHING is written to `parameters`: a slope fitted on
       one spectrum is not a setting, and letting it become one would make the
       second spectrum get cut by the first one's picture of the data. */
    displaySlope(){
        return Number.isFinite(this.parameters.slope)
            ?this.parameters.slope
            :this.multiplexSlope
    }

    //slope of the line through the origin and the centroid of the pairs â€”
    //a neutral split of the cloud (the old guess placed a threshold at mean(Y))
    //
    //The pairs are PARAMETERS because the multiplexed resolve guesses on one
    //spectrum at a time: reading them off the node's own fields would measure the
    //previous spectrum's cloud.
    guessSlope(births=this.persistenceBirths,deaths=this.persistenceDeaths){
        if(!births?.length) return null
        let sumBirth=0
        let sumDeath=0
        for(let i=0;i<births.length;i++){
            sumBirth+=births[i]
            sumDeath+=deaths[i]
        }
        if(sumBirth>0 && Number.isFinite(sumDeath / sumBirth)){
            return clampClassifierSlope(sumDeath / sumBirth)
        }
        return keepAllSlopeFromFlat(births,deaths)
    }

    incomingLinks(){
        return this.destination?.linkList?.filter(link=>link.outputNode===this)??[]
    }

    fail(message){
        this.status="error"
        this.outputs[0]=[]
        this.multiplexTotals=null
        this.persistenceBirths=null
        this.persistenceDeaths=null
        this.persistencePointsX=null
        this.persistencePointsY=null
        this.persistenceKeptPointsX=null
        this.persistenceKeptPointsY=null
        this.persistenceKeptIndices=null
        this.radioResult=null
        console.error(`[PeakPickingNode] ${message}`)
        this.graph?.setTraces([])
        this.graph?.drawGraph()
    }

    /* THE RESOLVE, and the fork that decides everything else.

       The PORT is still constrained — a link must land on input 0, the only one
       there is — but the NUMBER of links is no longer a question. The old check
       counted the links whose inputNode is this one, which are its CONSUMERS,
       and refused to resolve as soon as two nodes consumed the output: a bug
       that stayed latent only because the node happened to have one output.

       What decides the shape of the resolve is not the number of cables but the
       number of WAVES they bring. One wave is the case this node was built for
       and it is resolved exactly as before — the user's line, their z, the
       click on the diagram. Several waves are a request to treat them all the
       same way, and that request is answered with the DEFAULTS applied N times:
       a slope guessed on each spectrum, a z read on each spectrum, and not one
       of those readings written into the node. */
    async startResolve(){
        const links=this.incomingLinks()
        if(links.some(link=>link.inputAnchor.id!=="0")){
            this.fail("only input 0 is read by this node")
            return
        }
        const {waves,skipped}=this.collectInputWaves()
        this.skippedInputs=skipped
        this.multiplexCount=waves.length
        this.updatePeakMultiplex()
        if(!waves.length){
            this.status = "floating"
            this.outputs[0] = []
            this.multiplexTotals=null
            return
        }
        if(waves.length===1){
            //the aggregate belonged to the multiplex this node no longer is: left
            //in place it would go on counting spectra that are gone, and the drawn
            //line would keep showing a guess that no longer describes anything
            this.multiplexTotals=null
            this.multiplexSlope=null
            await this.resolveOneInput(waves[0])
            return
        }
        await this.resolveMultiplexed(waves)
    }
    /* ONE WAVE IN, THE PEAKS OF THAT WAVE OUT — the whole original resolve.

       Split out of startResolve, not rewritten: this is the single-input case the
       node has always had, and the only thing multiplexing changes about it is
       that it stops being the only case. */
    async resolveOneInput(inputWave){
        this.status = "pending"
        this.lastInputWave = inputWave

        const stride=inputWave.degree===2&&inputWave.dims[1]===2?2:1

        try{
            const analysis=await computePool.run("persistentHomology0D", {
                core: inputWave.core,
                params: { mode: this.parameters.filtrationMode ?? "sublevel", stride }
            })
            this.adoptAnalysis(analysis)
            if(!Number.isFinite(this.parameters.slope) && Number.isFinite(analysis.slope)){
                this.parameters.slope=analysis.slope
            }
            this.status="resolved"
            await this.applySlopeFilter()
            this.updateControlsUI()
        }catch(err){
            //fail() and not a bare status: a silent red node tells the user
            //nothing, and "error" here can come from the KERNEL (a stale wasm
            //build still exposes the 5-argument classify_persistence_0d) as
            //easily as from the data. The reason belongs on screen.
            this.fail(`resolving failed: ${err?.message??String(err)}`)
        }
    }
    /* THE ANALYSIS, onto the node's own fields.

       Both paths hand their H0 result here rather than each writing eight fields
       of its own, because the panel reads those fields and the multiplexed path
       has to make the panel describe a spectrum it is no longer working on. */
    adoptAnalysis(analysis){
        this.persistenceBirths=analysis.births
        this.persistenceDeaths=analysis.deaths
        this.persistencePointsX=analysis.pointsX
        this.persistencePointsY=analysis.pointsY
        this.persistenceBirthIndices=analysis.birthIndices
        /* The integrated mass and its centroid, kept beside the births.
           NOT thrown away here: `pointsY` is the intensity of the single
           point that BORN each component — its chief — so it is what the
           output used to carry, and it is exactly the number the union-find
           integration exists to replace. */
        this.persistenceIntegratedMass=analysis.integratedMass
        this.persistenceCentroidX=analysis.centroidX
        this.pairsData={count:analysis.births.length}
    }
    /* N WAVES IN, N PEAK LISTS OUT, each measured on ITS OWN spectrum.

       THE DEFAULTS, EVERY TIME. The classifier slope is the kernel's own fit for
       that spectrum — or the centroid guess when it has none — and the z is read
       off that spectrum's own widths. Both are what the node already does with a
       null slope and a `convention` z, which is to say what it does before anyone
       has touched it. That is the whole point of putting several spectra here:
       the same treatment, N times, instead of one pane of settings per spectrum.

       AND NOTHING IS WRITTEN DOWN. Neither `parameters.slope` nor `parameters.z`
       is touched, and that is correctness rather than squeamishness: the node has
       one slope field and one z field, so a multiplexed resolve that wrote the
       first spectrum's guess into them would have the second spectrum cut by the
       first one's picture of the data — and, on the next resolve, every other one
       as well. A guess that becomes a setting is precisely the bug this path
       exists to avoid.

       SEQUENTIALLY, like F-KMD's, Attribution's and the trimmer's: the pool holds
       a few workers, a burst would queue every multi-megabyte core at once and
       stall the interface on all of them rather than one at a time.

       A spectrum the kernel fails on is recorded and the resolve carries on: one
       broken spectrum is one broken result, not a dead node. "error" is only for
       when NOTHING came out. */
    async resolveMultiplexed(waves){
        const run=++this.resolveRun
        this.status="pending"
        const products=[]
        const errors=[]
        let keptTotal=0
        let pairsTotal=0
        let shown=null
        for(let i=0;i<waves.length;i++){
            if(run!==this.resolveRun) return       //superseded: publish nothing
            if(i>0) await new Promise(resolve=>setTimeout(resolve,0))
            if(run!==this.resolveRun) return
            const wave=waves[i]
            const label=wave.metadata?.title??`input ${i+1}`
            try{
                const picked=await this.pickPeaksFrom(wave)
                if(picked.output) products.push(picked.output)
                keptTotal+=picked.keptCount
                pairsTotal+=picked.pairCount
                //the FIRST spectrum is the one the panel will describe
                if(!shown) shown=picked
            }catch(err){
                errors.push(`${label}: ${err?.message??String(err)}`)
            }
        }
        if(run!==this.resolveRun) return
        this.outputs[0]=products
        this.multiplexTotals={inputs:waves.length,keptTotal,pairsTotal,errors}
        /* THE PANEL DESCRIBES THE FIRST SPECTRUM, and says so.

           There is one diagram, one drawn line and one width reference, so they
           show the first input: real data, and the spectrum whose slope the line
           belongs to. The counter then speaks for all N, because the aggregate is
           the only figure that can. */
        if(shown) this.showPicked(shown)
        this.status=errors.length&&!products.length?"error":"resolved"
        if(errors.length) console.error("[PeakPickingNode] some inputs failed:",errors)
        this.updateControlsUI()
    }
    /* ONE SPECTRUM -> ONE PEAK LIST, on the defaults, touching no node state.

       The two stages in the order they require: the classifier needs a slope, the
       width filter needs the peaks the classifier kept, and the z is read between
       the two because it measures THOSE peaks. It returns what it found rather
       than publishing it — publishing N results one at a time would leave the
       output describing whichever spectrum happened to resolve last. */
    async pickPeaksFrom(inputWave){
        const stride=inputWave.degree===2&&inputWave.dims[1]===2?2:1
        const analysis=await computePool.run("persistentHomology0D",{
            core:inputWave.core,
            params:{mode:this.parameters.filtrationMode??"sublevel",stride}
        })
        /* the kernel's own fit, or the centroid guess when it has none — the two
           things a null slope already means. Either way it is a reading of THIS
           diagram, which is the only honest source for a line that cuts it. */
        const slope=Number.isFinite(analysis.slope)
            ?clampClassifierSlope(analysis.slope)
            :(this.guessSlope(analysis.births,analysis.deaths)??0)
        const classification=await computePool.run("classifyPersistence0D",{
            births:analysis.births,
            deaths:analysis.deaths,
            pointsX:analysis.pointsX,
            pointsY:analysis.pointsY,
            pointsIndex:analysis.birthIndices,
            integratedMass:analysis.integratedMass,
            centroidX:analysis.centroidX,
            params:{slope}
        })
        const publishedY=publishedPeakY(classification)
        const candidates=classification.keptPointsX.length
        let z=this.parameters.z
        let radioResult=null
        /* The width stage needs a mass axis, exactly as it does for one input:
           on a 1D wave there is no ppm to measure, the stage does not run, and the
           classified peaks are published as they are. */
        if(candidates&&inputWave.degree===2&&inputWave.dims[1]===2){
            z=await this.readZFromKernel(inputWave,classification.keptIndices)??CONVENTIONAL_Z
            try{
                radioResult=await computePool.run("antiRadioFilter",{
                    core:inputWave.core,
                    pointsX:classification.keptPointsX,
                    pointsY:classification.keptPointsY,
                    pointsIndex:classification.keptIndices,
                    params:{stride:2,z}
                })
            }catch(err){
                //a failing filter must not take the peaks with it: the classified
                //result is still valid, and hiding it would lose real work
                console.error("[PeakPickingNode] anti-radio failed, keeping the classified peaks:",err)
            }
        }
        const label=inputWave.metadata?.title??null
        let output=null
        if(radioResult){
            const masked=massThroughMask(classification.keptIntegratedMass,radioResult.isRadio,candidates)
            output=this.peaksWave(
                radioResult.pointsX,
                masked&&masked.length===radioResult.pointsX.length?masked:radioResult.pointsY,
                radioResult.keptCount,slope,z,label
            )
        }else if(candidates){
            output=this.peaksWave(classification.keptPointsX,publishedY,candidates,slope,z,label)
        }
        return {
            wave:inputWave,
            analysis,
            classification,
            slope,
            z,
            radioResult,
            output,
            keptCount:radioResult?radioResult.keptCount:candidates,
            pairCount:analysis.births.length
        }
    }
    /* Puts ONE spectrum's result on the panel: its state, its diagram, its
       readouts. The multiplexed resolve calls it once, with the first input, and
       what it writes is exactly what a single-input resolve would have left — it
       is the same code, not a second rendering of the same data. */
    showPicked(picked){
        this.lastInputWave=picked.wave
        this.adoptAnalysis(picked.analysis)
        this.adoptClassification(picked.classification)
        //the drawn line belongs to THIS spectrum and to no other
        this.multiplexSlope=picked.slope
        this.radioResult=picked.radioResult
        this.renderRadioReadout(picked.radioResult,picked.classification.keptPointsX.length)
        this.paintDiagram(picked.classification)
    }
    /* THE CONTROLS, in the two states.

       Everything that decides for ONE spectrum goes grey: the slope field, its
       Guess, the z field, its Guess. Left live they would offer to settle a
       question that has N answers — and the value they hold would be the first
       spectrum's guess, which is not a setting of anything. The Lin/Log switch
       stays live: it is how the diagram is DRAWN, not what the node decides.

       `disabled` and not a class of our own: the browser already knows how to
       grey a control it must not accept, and a hand-rolled opacity would leave it
       perfectly clickable. */
    updatePeakMultiplex(){
        const on=this.isMultiplexed()
        for(const control of [this.slopeInput,this.slopeGuessBtn,this.zInput,this.zGuessBtn]){
            if(control) control.disabled=on
        }
        if(this.slopeInput){
            this.slopeInput.title=on
                ?"Classifier slope — GUESSED on each spectrum in turn. This field shows the first one's, and typing another would only move that one."
                :"Classifier slope (< 1): pairs under death = slope × birth are kept"
        }
        if(this.zInput){
            this.zInput.title=on
                ?"Width threshold in robust sigma — read from EACH spectrum's own peak widths, so there is no one value to show."
                :"Number of robust sigma above the median width above which a peak is called radio"
        }
    }
    /* THE CLASSIFICATION, onto the node's own fields, and nothing else.

       The classified points are held in memory rather than published: the
       anti-radio stage reads them together with their indices, and the OUTPUT is
       whatever survives both stages. */
    adoptClassification(classification){
        this.persistenceKeptPointsX=classification.keptPointsX
        this.persistenceKeptPointsY=classification.keptPointsY
        this.persistenceKeptIndices=classification.keptIndices
        this.persistenceKeptCount=classification.keptCount
        this.persistenceKeptMass=classification.keptIntegratedMass
        this.persistenceKeptCentroidX=classification.keptCentroidX
        this.persistencePublishedY=publishedPeakY(classification)
    }
    /* The diagram, from a classification. Extracted from applySlopeFilter so the
       multiplexed path paints the very same picture rather than a second
       rendering of the same data. */
    paintDiagram(classification){
        if(!this.graph) return
        const traces=[]
        if(classification.keptBirths.length){
            traces.push(new XYTrace({
                id:`${this.title}:kept`,title:`Kept (${classification.keptCount})`,
                wave:Wave.fromCoordinates(classification.keptBirths,classification.keptDeaths,{},["birth","death"]),
                options:{color:"#2ecc71",mode:"points",marker:{shape:"circle",size:4},layer:"gl"}
            }))
        }
        if(classification.discardedBirths.length){
            traces.push(new XYTrace({
                id:`${this.title}:discarded`,
                title:`Discarded (${classification.discardedBirths.length})`,
                wave:Wave.fromCoordinates(classification.discardedBirths,classification.discardedDeaths,{},["birth","death"]),
                options:{color:"#7f8c8d",mode:"points",marker:{shape:"circle",size:3},layer:"gl"}
            }))
        }
        this.graph.setTraces(traces)
        this.graph.drawGraph()
        this.updateClassifierSVG()
    }

    async applySlopeFilter(){
        if(!this.persistenceBirths) return
        const slope=Number.isFinite(this.parameters.slope)?this.parameters.slope:0
        const classification=await computePool.run("classifyPersistence0D",{
            births:this.persistenceBirths,
            deaths:this.persistenceDeaths,
            pointsX:this.persistencePointsX,
            pointsY:this.persistencePointsY,
            //the point's own position in the input wave, carried through the
            //classifier untouched so the second output can be published
            pointsIndex:this.persistenceBirthIndices,
            //and so is the mass: the classifier decides WHICH points survive,
            //and the area belongs to the one it keeps
            integratedMass:this.persistenceIntegratedMass,
            centroidX:this.persistenceCentroidX,
            params:{slope}
        })
        const pairCount=this.persistenceBirths.length
        this.adoptClassification(classification)

        //The auto z runs HERE, between the classification and the filter: the
        //guess measures the CLASSIFIED peaks at their input indices, so those
        //indices must exist first. Placing it after this one call is also what
        //keeps a resolve at a single classifier run instead of two.
        await this.resolveZIfUnset()

        await this.applyAntiRadio()

        this.paintDiagram(classification)
        if(this.countLabel) this.countLabel.textContent=this.countReadout(classification.keptCount,pairCount)
    }
    /* THE COUNTER, in the two states: one input reads as it always has, and
       several announce themselves before they give the aggregate, because a
       "412/1103" over three spectra is not a figure about any of them. */
    countReadout(keptCount,pairCount){
        return this.isMultiplexed()
            ?`${this.multiplexCount} entrées · ${keptCount}/${pairCount}`
            :`${keptCount}/${pairCount}`
    }

    /* The second stage, in this node: drop the classified peaks whose
       half-height width sits out of the width population of THIS spectrum.

       It runs on the RAW profile (the only thing with samples on both sides of a
       peak) at the indices the classifier carried through, and its result is the
       node's single output. When the input has no mass axis the stage is SKIPPED
       and the classified peaks are published as they are: a width in ppm cannot
       be computed on a 1D wave, and silently passing everything through would
       claim the stage had found nothing. */
    async applyAntiRadio(){
        const profile=this.lastInputWave
        const px=this.persistenceKeptPointsX
        /* anti-radio is given the CHIEF (`py`), because the width it measures is
           the height at half maximum of the profile, and the chief is the point
           standing at that peak. The integrated mass is an AREA over several
           points and would report a width that is not the peak's width. */
        const py=this.persistenceKeptPointsY
        /* What gets PUBLISHED is different: the area, if the kernel gave us one. */
        const publishedY=this.persistencePublishedY??py
        const indices=this.persistenceKeptIndices
        if(!profile||!px?.length){ this.publishOutput(px,publishedY,0); return }
        if(!(profile.degree===2&&profile.dims[1]===2)){
            this.radioResult=null
            this.publishOutput(px,publishedY,px.length)
            this.renderRadioReadout(null,px.length)
            return
        }
        try{
            const result=await computePool.run("antiRadioFilter",{
                core:profile.core,
                pointsX:px,pointsY:py,pointsIndex:indices,
                params:{stride:2,z:this.parameters.z}
            })
            this.radioResult=result
            //the mass, cut by the SAME mask — see massThroughMask
            const filteredMass=massThroughMask(this.persistenceKeptMass,result.isRadio,px.length)
            this.publishOutput(
                result.pointsX,
                filteredMass&&filteredMass.length===result.pointsX.length
                    ?filteredMass
                    :result.pointsY,
                result.keptCount
            )
            this.renderRadioReadout(result,px.length)
        }catch(err){
            //a failing filter must not take the peaks with it: the classified
            //result is still valid, and hiding it would lose real work
            console.error("[PeakPickingNode] anti-radio failed, publishing the classified peaks:",err)
            this.radioResult=null
            this.publishOutput(px,publishedY,px.length)
            this.renderRadioReadout(null,px.length)
        }
    }
    /* THE PEAKS AS A WAVE, or null when there are none.

       One builder for both paths, because the columns that travel with a peak
       are a CONTRACT — the slope and the z that decided it, how many survived,
       how many were offered — and a second builder is a second chance to publish
       a mass under the x of a peak it does not belong to.

       `slope` and `z` are PARAMETERS: while multiplexed, they are that
       spectrum's own readings and not the node's settings, and the metadata has
       to say which. `source` names the spectrum, because N products otherwise
       all carry the same title. */
    peaksWave(pointsX,pointsY,kept,slope=this.parameters.slope,z=this.parameters.z,source=null){
        if(!kept||!pointsX?.length) return null
        return Wave.fromCoordinates(pointsX,pointsY,{
            title:`${this.title} (peaks)`,
            slope,
            z,
            kept,
            total:this.persistenceKeptCount??kept,
            source,
            sourceWave:source??this.lastInputWave?.metadata?.title??"unknown",
            traceMode:"sticks-to-zero"
        },["x","y"])
    }
    /* Publishes ONE result on the output slot — the single-input case's own
       ending. The multiplexed path does NOT come through here: it has N results
       and a slot that must hold all of them at once, so it collects them and
       writes the slot once, at the end. */
    publishOutput(pointsX,pointsY,kept){
        const wave=this.peaksWave(pointsX,pointsY,kept)
        this.outputs[0]=wave?[wave]:[]
    }

    updateControlsUI(){
        //the DISPLAYED slope, not the stored one: while multiplexed the stored
        //one is null on purpose and the field shows the first spectrum's guess
        const slope=this.displaySlope()
        if(this.slopeInput && Number.isFinite(slope)){
            this.slopeInput.value = formatSlope(slope)
        }
        if(this.countLabel && this.pairsData){
            //the multiplexed case counts over all of them, which is the only
            //figure that can speak for N; one input reads as it always has
            const totals=this.multiplexTotals
            this.countLabel.textContent = totals
                ?this.countReadout(totals.keptTotal,totals.pairsTotal)
                :this.countReadout(this.outputs[0]?.[0]?.dims?.[0]??0,this.pairsData.count)
        }
    }

    //the classifier: a dashed line through the origin (death = slope Ã— birth)
    //clipped to the graph zone, plus the marker point that fixes the slope
    //(see handleClassifierClick)
    updateClassifierSVG(){
        if(!this.graph || !this.graph.graphSVG) return
        const anchor = this.graph.graphSVG.select(".anchor")
        if(anchor.empty()) return

        let group = anchor.select(".classifier-group")
        if(group.empty()){
            group = anchor.append("g")
                .attr("class", "classifier-group")
            group.append("title")
                .text("Classifier â€” click on the graph to place it: every pair under the line is kept")
            group.append("line")
                .attr("class", "classifier-line")
                .attr("stroke", "#e74c3c")
                .attr("stroke-width", 2)
                .attr("stroke-dasharray", "6,4")
            group.append("circle")
                .attr("class", "classifier-point")
                .attr("r", 5)
                .attr("fill", "#e74c3c")
                .attr("stroke", "#ffffff")
                .attr("stroke-width", 1.5)
        }

        //the DISPLAYED line: the user's own while there is one input, and the first
        //spectrum's guess while there are several — the line drawn on the diagram
        //is the one that cut that spectrum, and any other would be a lie about it
        const slope = this.displaySlope()
        if(!Number.isFinite(slope)){
            group.style("display", "none")
            return
        }
        group.style("display", null)

        const zone = this.graph.graphzone
        const { xScale, yScale } = this.graph.plotScales()

        //the line death = slope Ã— birth sampled across the whole visible
        //x-range, so the segment always spans the graph zone and the clip
        //only trims its ends (a birth 1â†’10 sample used to cut it at 10)
        let b0 = xScale.invert(0)
        let b1 = xScale.invert(zone.width)
        if(this.graph.parameters.axis.left.scale === "log"){
            //a log axis has no zero: keep the sampled deaths strictly positive
            b0 = Math.max(b0, 1e-300)
            b1 = Math.max(b1, 1e-300)
        }
        const x0 = xScale(b0), y0 = yScale(slope * b0)
        const x1 = xScale(b1), y1 = yScale(slope * b1)
        const finite = [x0, y0, x1, y1].every(Number.isFinite)
        const clipped = finite ? clipSegmentToRect(x0, y0, x1, y1, zone.width, zone.height) : null
        const line = group.select(".classifier-line")
        if(clipped){
            line.style("display", null)
                .attr("x1", clipped[0])
                .attr("y1", clipped[1])
                .attr("x2", clipped[2])
                .attr("y2", clipped[3])
        }else{
            line.style("display", "none")
        }

        //the marker sits on the line at the last clicked birth (mid-view
        //until the first click): data space, so it follows zoom and pan
        const anchorBirth = Number.isFinite(this.parameters.slopeAnchorBirth)
            ? this.parameters.slopeAnchorBirth
            : xScale.invert(zone.width / 2)
        const px = xScale(anchorBirth)
        const py = yScale(slope * anchorBirth)
        const inside = Number.isFinite(px) && Number.isFinite(py)
            && px >= 0 && px <= zone.width && py >= 0 && py <= zone.height
        const point = group.select(".classifier-point")
        if(!inside){
            point.style("display", "none")
            return
        }
        point.style("display", null).attr("cx", px).attr("cy", py)
    }

    //a plain click places the classifier: the line passes through the origin
    //and the clicked point, so its slope is death/birth â€” clamped above 1
    //since every pair lives strictly above the diagonal death = birth
    handleClassifierClick(event){
        if(!this.graph) return
        //a click here sets ONE line, and while multiplexed each spectrum is cut
        //by its own — so the click would move the first spectrum and leave the
        //others exactly where they were. The control is greyed; this is the same
        //rule reached by the keyboard, by a drag, or by a restored session.
        if(this.isMultiplexed()) return
        //the tail of a pan drag also fires a click: ignore it (like dblclick)
        if(performance.now()-(this.graph.lastPanEndAt??-Infinity)<PAN_DBLCLICK_GUARD) return
        const zone=this.graph.graphzone
        if(!(zone.width>0&&zone.height>0)) return
        const rect=this.graph.container.getBoundingClientRect()
        const px=Math.min(Math.max(event.clientX-rect.left-this.graph.parameters.margins.left,0),zone.width)
        const py=Math.min(Math.max(event.clientY-rect.top-this.graph.parameters.margins.top,0),zone.height)
        const {xScale,yScale}=this.graph.plotScales()
        const birth=xScale.invert(px)
        const death=yScale.invert(py)
        const slope=clampClassifierSlope(death/birth)
        //re-clicking the very same pixel must not redo the whole chain
        if(this.parameters.slope===slope&&this.parameters.slopeAnchorBirth===birth) return
        //remember where the marker sits on the line (data space: it follows
        //zoom and pan, and stays on the line whatever the slope becomes)
        this.parameters.slopeAnchorBirth=birth
        this.setSlope(slope,true)
    }

    setSlope(newSlope, commit = false){
        //the single-input case's decision. While multiplexed the slope is read
        //off each spectrum in turn, and storing one would apply it to all of them
        //on the next resolve — the exact "a guess became a setting" bug the
        //multiplexed path refuses to commit.
        if(this.isMultiplexed()) return
        this.parameters.slope = clampClassifierSlope(newSlope)
        if(this.slopeInput){
            this.slopeInput.value = formatSlope(this.parameters.slope)
        }
        this.updateClassifierSVG()
        this.applySlopeFilter()

        if(commit){
            if(this.dragDebounceTimer){
                clearTimeout(this.dragDebounceTimer)
                this.dragDebounceTimer = null
            }
            this.resolveChildren()
        }else{
            if(this.dragDebounceTimer) clearTimeout(this.dragDebounceTimer)
            this.dragDebounceTimer = setTimeout(() => {
                this.resolveChildren()
            }, 120)
        }
    }

    //resolveChildren() is inherited from Node: this class used to carry its own
    //copy of the traversal, identical to TrimmerNode's, and both now delegate
    //to the flow.

    serializeState(){
        return {
            slope: this.parameters.slope,
            slopeAnchorBirth: this.parameters.slopeAnchorBirth,
            filtrationMode: this.parameters.filtrationMode,
            //both stages travel together: a session that kept the classifier but
            //lost the anti-radio settings would come back looking filtered
            z: this.parameters.z,
            zSource: this.parameters.zSource,
            status: this.status
        }
    }

    restoreState(state){
        if(!state) return
        if(Number.isFinite(state.slope)) this.parameters.slope = state.slope
        if(Number.isFinite(state.slopeAnchorBirth)) this.parameters.slopeAnchorBirth = state.slopeAnchorBirth
        if(state.filtrationMode !== undefined) this.parameters.filtrationMode = state.filtrationMode
        if(Number.isFinite(state.z)&&state.z>0) this.parameters.z = state.z
        //a session saved before the anti-radio stage existed has no zSource: it
        //is read as the convention, which is what it was
        this.parameters.zSource = state.zSource ?? "convention"
        this.status = state.status ?? "floating"
        this.updateControlsUI()
    }

    suicide(options={}){
        this.graph?.dispose?.()
        this.accordion?.suicide()
        super.suicide(options)
    }
}

/* ChatNode — the first node of the "tools" category, and the first one with
   nothing to do with a spectrum.

   WHY A NODE AT ALL. A chat is a tool, not data: it computes nothing, it has
   no wave in and no wave out. But it is per-WORKSPACE — you want a different
   room while you work on a different file — and the workspace IS a node on
   the graph. Making the chat a node is what ties it to the session it was set
   up in, instead of floating in a global corner that outlives everything.

   CE QUE CE NŒUD NE FAIT PAS, ET C'EST IMPORTANT
   It carries NO data: no inputs, no outputs, and startResolve does nothing. A
   node that resolved to something would be auto-wired into somebody's pipeline
   and given a column of its own, as if it belonged between two filters. Being
   inert is what keeps it at the edge of the graph where it belongs. */

