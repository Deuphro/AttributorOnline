import {Command,NodeWithAccordion} from "../core/index.js"
import {Plot2DWebGL} from "../ui/Plot2DWebGL.js"
import {Wave} from "../formats.js"
import {computePool} from "../workerPool.js"
import {CE,stylize} from "../util.js"
import {TRIM_METHODS,TRIM_LOW_COLOR,TRIM_HIGH_COLOR,CURSOR_COLORS,TRIM_CURSOR_STROKE,TRIM_CURSOR_FIELD_FONT,formatCursorValue,scaleToggle,binsOfHistogram,wavesFromInput} from "../utils/index.js"
export class TrimmerNode extends NodeWithAccordion{
    //60 bars is enough to read a distribution at panel size, and keeps the
    //kernel payload small: 60 f64 is nothing next to the wave itself.
    static HISTOGRAM_BINS=60
    constructor(title,origin,destinationFlow,position={x:180,y:10}){
        super(title,[[]],[[]],origin,destinationFlow,position)
        this.status="floating"
        this.parameters.method="passthrough"
        this.parameters.methodParams={}
        //the two cursors live in DATA space on the value axis
        this.parameters.lowBound=null
        this.parameters.highBound=null
        //log Y toggle: the frame is a histogram, and the low tail is exactly
        //where a trim threshold lives, so it is where linear wastes the space
        //log Y on by default: a mass spectrum spans orders of magnitude, and a
        //linear value axis crushes the entire low tail into the bottom pixel
        this.parameters.logY=true
        //the linear value span, kept aside so the log toggle can restore it
        this.linearValueDomain=[0,100000]
        this.dragDebounceTimer=null
        this.graph=null
        //real histogram bins, replaced by the trimHistogram kernel on resolve
        this.bins=[]
        this.trimResult=null
        //monotonic ticket: only the newest kernel run may publish its result
        this.trimRun=0
        this.lastInputWave=null
        this.dragDebounceTimer=null
        //separate timer for the trim itself: the children debounce guards the
        //subtree re-resolve, this one guards the postMessage copy of the core
        this.trimDebounceTimer=null
        //a second ticket, for the MULTIPLEX: a resolve launched by hand while a
        //loop over N spectra is still walking them must not be overwritten by
        //the older loop when it finally reaches the end
        this.resolveRun=0
        /* MULTIPLEX. Several links on input 0, or one link carrying several
           waves, are the same question to this node: "treat them all the
           same way". The count is read at every resolve and is NOT state — the
           number of cables is the flow's business, not the node's, and writing
           it into `parameters` would put it in every session file for nothing. */
        this.multiplexCount=0
        this.skippedInputs=0
        /* the totals of the LAST multiplexed resolve, for the readout */
        this.multiplexTotals=null
        const inputAnchors=this.DOMelt.querySelectorAll('.input.anchor')
        if(inputAnchors[0]) inputAnchors[0].innerHTML='<title>Input: one Wave (XY or 1D), or several at once — each is then trimmed on its own data</title>'
        const outputAnchors=this.DOMelt.querySelectorAll('.output.anchor')
        if(outputAnchors[0]) outputAnchors[0].innerHTML='<title>Output: one trimmed Wave per input Wave</title>'
    }
    registered(e){
        if(e.detail.msg.caster!==this||this.accordion){
            return
        }
        super.registered(e)
        this.setupTrimmerUI()
    }
    currentMethod(){
        return TRIM_METHODS[this.parameters.method]??TRIM_METHODS.passthrough
    }
    //Effective parameters, WITHOUT persisting the defaults. Writing the defaults
    //back would make an untouched field indistinguishable from one the user
    //typed, and the data-driven default below depends on telling them apart.
    methodParams(){
        const params={...this.parameters.methodParams}
        for(const field of this.currentMethod().fields??[]){
            if(!Number.isFinite(params[field.key])) params[field.key]=field.value
        }
        return params
    }
    //Data-driven default threshold, read off the histogram that has just been
    //computed: the value below which `fraction` of the points lie. No extra
    //kernel round trip, and it lands where the data actually is instead of on a
    //hardcoded constant that means nothing on a real spectrum.
    quantileThreshold(fraction=0.05,bins=this.bins){
        if(!bins?.length) return 0
        let total=0
        for(const bin of bins) total+=bin.count
        if(!(total>0)) return bins[0].value
        const target=total*fraction
        let seen=0
        for(let i=0;i<bins.length;i++){
            const next=seen+bins[i].count
            if(next>=target){
                //interpolate INSIDE the bin, so the answer is a value and not a
                //bar edge: the cursor then lands between two real points
                if(bins[i].count>0){
                    const ratio=(target-seen)/bins[i].count
                    const width=bins.length>1?Math.abs(bins[1].value-bins[0].value):0
                    return bins[i].value-width/2+ratio*width
                }
                return bins[i].value
            }
            seen=next
        }
        return bins[bins.length-1].value
    }
    //The threshold actually sent to the kernel: the user value when there is
    //one, the data-driven quantile otherwise.
    //
    //`bins` is a PARAMETER and not `this.bins` because the multiplexed path
    //asks the question about ONE input at a time, with THAT input's
    //histogram: a quantile read off another spectrum's distribution is a number
    //that means nothing here.
    effectiveThreshold(bins=this.bins){
        const set=this.parameters.methodParams?.threshold
        return Number.isFinite(set)?set:this.quantileThreshold(0.05,bins)
    }
    /* THE INPUT WAVES, in link order, and the count of values that were not
       waves at all.

       The trimmer takes 1D as readily as XY — the histogram is read on the Y
       block either way — so unlike F-KMD there is nothing to refuse here, only
       to count. */
    collectInputWaves(){
        const {waves,skipped}=wavesFromInput(this.inputs[0])
        return {waves,skipped}
    }
    /* True when this node is being asked to treat SEVERAL spectra the same way
       instead of tuning one. It is a property of the LINKS, read fresh on
       every resolve: the moment a second cable lands the node changes its
       mind, and the moment it is removed it changes back. */
    isMultiplexed(){
        return this.multiplexCount>1
    }
/* The value domain of an EXPLICIT linear span, on the current scale.

       `trimValueDomain()` reads the node's own span, which is the span of the
       wave currently on the frame. The multiplexed path holds no such wave —
       it holds N of them — so it asks the same question about each one's own
       span, and the two cannot drift apart because the arithmetic lives here
       and only here. */
    valueDomainOnScale(linear){
        const [low,high]=linear
        if(!this.parameters.logY) return [low,high]
        if(!(high>0)){
            return [1,10]//no data at all: a readable empty frame beats NaN
        }
        const pad=Math.pow(10,0.1)
        const floor=low>0?low:high/1e6
        return [Math.max(floor/pad,Number.MIN_VALUE),high*pad]
    }

    //Value axis domain for the CURRENT scale mode. On a log axis the histogram
    //already reports the smallest and the LARGEST POSITIVE value (log10 of 0 is
    //undefined), so there is no "half a bin width" fudge left to invent: the
    //honest floor is the data minimum. The padding is multiplicative, a tenth
    //of a decade each side, because an additive margin would vanish next to a
    //spectrum spanning thousands.
    trimValueDomain(){
        //the arithmetic, and the reasoning behind it, live in
        //valueDomainOnScale; this is only "the node's own span, please"
        return this.valueDomainOnScale(this.linearValueDomain)
    }
    setLogY(on){
        if(this.parameters.logY===on) return
        const before=this.trimSettingsSnapshot()
        this.parameters.logY=on
        if(this.graph){
            //plotScales() already honours axis.left.scale, so the toggle only
            //has to swap the scale and re-pin the matching domain
            this.graph.parameters.axis.left.scale=on?"log":"linear"
            //the COUNT axis follows too: it is part of the same log reading
            this.pinTrimDomains()
        }
        this.refreshTrimmerUI()
        //the BINS themselves change with the scale, not only their position: a
        //full resolve re-histograms in the new spacing and re-seeds an absent
        //cursor, which the scale change may have invalidated
        if(this.lastInputWave) this.startResolve()
        this.recordTrimSettings(before,"Trimmer scale")
    }
    setupTrimmerUI(){
        if(!this.accordion) return
        const content=this.accordion.DOMelt.content
        content.replaceChildren()
        stylize(content,{
            display:"grid",
            //THREE rows for THREE children: the control bar, the method
            //parameters, and the graph. Declaring only two left the 1fr on the
            //parameter row, and the graph fell into an implicit auto row where
            //its own height:100% overflowed the panel - that is what made the
            //inputs appear to spill over the graph.
            "grid-template-rows":"auto auto minmax(0, 1fr)",
            minHeight:"0",
            height:"100%",
            overflow:"hidden",
            padding:"4px",
            gap:"4px"
        })
        this.accordion.setSizingMode("viewport",{height:420})
        this.accordion.DOMelt.container.style.maxHeight="75%"
        const controls=CE("div",{
            style:{
                display:"grid",
                gridTemplateColumns:"minmax(0,1fr) auto auto auto",
                alignItems:"center",
                gap:"4px",
                fontSize:"0.85em",
                padding:"2px 4px",
                borderRadius:"4px",
                background:"rgba(255,255,255,0.05)"
            }
        },[])
        const methodSelect=CE("select",{title:"Trimming method"},[])
        for(const [key,method] of Object.entries(TRIM_METHODS)){
            methodSelect.append(new Option(method.label,key))
        }
        methodSelect.value=this.parameters.method
        //The method hint lives in the tooltip: as visible text it was long
        //enough to squeeze the select itself into a few characters.
        const applyHint=()=>{
            methodSelect.title=this.currentMethod().hint??""
        }
        applyHint()
        //the widgets ARE the visible state, and a restore pushes the parameters
        //into them: it can only do that if it can REACH them
        this.methodSelect=methodSelect
        this.applyMethodHint=applyHint
        methodSelect.addEventListener("change",async()=>{
            const before=this.trimSettingsSnapshot()
            this.parameters.method=methodSelect.value
            applyHint()
            //the new method exposes its own knobs: rebuild the row before the
            //guess, so the fields shown are the ones that were actually used
            this.renderMethodFields()
            //AWAITED before recording: the guess moves the cursors from the
            //kernel, and a command closed too early would undo back to bounds
            //the method that was just left never chose
            await this.guessFromKernel()
            this.recordTrimSettings(before,`Trimmer method ${this.parameters.method}`)
        })
        const guessBtn=CE("button",{type:"button",title:"Use the guess provided by the selected method"},["Guess"])
        guessBtn.addEventListener("click",()=>{this.guessFromKernel()})
        //kept, because updateTrimmerMultiplex() has to be able to grey it
        this.guessBtn=guessBtn
        //one control, two always-visible labels, the active one coloured
        const logBtn=scaleToggle({
            get:()=>this.parameters.logY,
            set:(value)=>this.setLogY(value),
            leftLabel:"Lin",
            rightLabel:"Log",
            title:"Value axis scale"
        })
        //scaleToggle paints itself from get() and hands the painter back as
        //wrap.paint, so a restore can re-sync the colours without a click
        this.logYToggle=logBtn
        //kept/total readout: without it there is no way to tell "trimmed 12000
        //of 50000" from "did nothing", which is exactly the ambiguity the cursors
        //alone cannot resolve
        const keptLabel=CE("span",{
            title:"Points kept by the trim, out of the input points",
            style:{opacity:"0.8",whiteSpace:"nowrap",justifySelf:"end"}
        },["0/0"])
        this.keptLabel=keptLabel
        controls.append(methodSelect,guessBtn,logBtn,keptLabel)
        content.append(controls)
        //Flex, not grid: auto-fit with a max-content track can grow PAST the
        //panel width, which wrapped k and window onto two lines. Flex keeps them
        //on one line and lets the row shrink instead.
        this.fieldsRow=CE("div",{
            //the class is what main.css hangs the greyed-out look on: these
            //fields are enabled again the moment the node stops being a batch
            className:"trim-fields",
            style:{
                display:"flex",
                //nowrap, not wrap: the two knobs must share ONE line, right under
                //the control bar, and the boxes are narrow enough for that
                flexWrap:"nowrap",
                alignItems:"center",
                gap:"8px",
                fontSize:"0.85em",
                padding:"2px 4px",
                overflow:"hidden"
            }
        },[])
        this.fieldsRow.style.display="none"
        content.append(this.fieldsRow)
        this.renderMethodFields()
        const graphContainer=CE("div",{
            className:"trim-graph-container",
            style:{position:"relative",width:"100%",height:"100%",minHeight:"200px",overflow:"hidden"}
        },[])
        content.append(graphContainer)
        this.graph=new Plot2DWebGL([],`${this.title} graph`,this.origin,graphContainer)
        //The trimmer frame holds NO traces, so Plot2D.dataBounds() is null, and
        //ensureValidScales reads a missing bound as "not strictly positive" and
        //forces EVERY log axis back to linear. The bars are binned in log, so on
        //a linear value axis they land unevenly and the log reading is lost.
        //Both domains here are pinned from the histogram, which already reports
        //strictly positive min/max, so that guard has nothing to protect: it
        //would only undo the scale the node asked for.
        this.graph.ensureValidScales=()=>{}
        //fixed frame: no wheel zoom, the histogram must stay fully readable
        this.graph.allowZoom=false
        this.graph.parameters.axis.bottom.label="Count"
        this.graph.parameters.axis.bottom.autoLabel=false
        this.graph.parameters.axis.left.label="Value"
        this.graph.parameters.axis.left.autoLabel=false
        //no trace yet, so dataBounds() is null and the auto fit has nothing to
        //work from: pin both domains so the frame is readable straight away
        this.graph.parameters.axis.left.autoDomain=false
        this.graph.parameters.axis.bottom.autoDomain=false
        this.graph.parameters.axis.left.scale=this.parameters.logY?"log":"linear"
        this.pinTrimDomains()
        const origDrawGraph=this.graph.drawGraph.bind(this.graph)
        this.graph.drawGraph=()=>{
            origDrawGraph()
            this.drawTrimmerOverlay()
        }
        this.graph.container.addEventListener("pointerdown",(event)=>this.handleTrimPointerDown(event))
        this.graph.container.addEventListener("pointermove",(event)=>this.handleTrimHover(event))
        this.graph.container.addEventListener("pointerleave",()=>this.setTrimHover(null))
        //no drawTrimmerOverlay() here: drawGraph below already calls it through
        //the hook above, and painting twice on setup only makes the first bars
        //flash before the second pass
        this.graph.drawGraph()
    }
    //Seeds the two cursors from the METHOD THRESHOLD, without trimming: this is
    //the "guess" step, it only decides where the cursors sit. Splitting it from
    //applyTrimBounds() matters, because the trim kernel takes the CURSOR as an
    //input: asking it for a guess with a cursor already set would just echo
    //that cursor back and the guess would never move.
    async seedBoundsFromKernel(){
        const domain=this.trimValueDomain()
        if(!domain.every(Number.isFinite)) return
        if(!this.lastInputWave){
            this.resetBoundsToFrame()
            this.refreshTrimmerUI()
            return
        }
        const bounds=await this.guessBoundsFor(this.lastInputWave,this.linearValueDomain,this.bins)
        this.parameters.lowBound=bounds.lowBound
        this.parameters.highBound=bounds.highBound
        this.refreshTrimmerUI()
    }
    /* THE GUESS ITSELF, as a PAIR, and about ONE input.

       This is what both paths ask, and the difference between them is only
       WHICH wave and WHICH histogram they pass: the interactive one passes the
       node's own, the multiplexed one passes each input's in turn. A method that
       places the lower bound at the 5 % quantile of a distribution means
       nothing at all unless the distribution is the one being cut — so `bins`
       is a parameter, never `this.bins`, in this function.

       RETURNS null when the span is not readable, which is the one case where
       there is no honest answer to give. A NaN bound sent to the kernel means
       "you decide": the kernel then reports its own threshold, which is exactly
       the value a guess needs. passthrough reports -Infinity (it trims nothing),
       which is useless as a cursor position, so it is mapped onto the frame
       instead: bottom and top.

       The threshold is used AS IS: it may sit below the data range (a legitimate
       "keep everything" setting) or above it. Clamping it into the frame used to
       push a threshold of 0.1 up onto the data minimum, which silently disabled
       the whole trim. Only a non-finite answer is replaced. */
    async guessBoundsFor(inputWave,linear=this.linearValueDomain,bins=this.bins){
        const domain=this.valueDomainOnScale(linear)
        if(!domain.every(Number.isFinite)) return null
        const frame={lowBound:domain[0],highBound:domain[1]}
        if(!inputWave) return frame
        try{
            //trim_guess returns ONE number: where the method wants the cursor.
            //The old code asked the FULL trim for it and discarded every kept
            //point, which cost three vectors built and cloned out of wasm on
            //every single change of k.
            const guess=await computePool.run("trimGuess",{
                core:inputWave.core,
                params:{
                    method:this.parameters.method,
                    stride:inputWave.degree===2&&inputWave.dims[1]===2?2:1,
                    k:this.methodParams().k,
                    window:this.methodParams().window,
                    threshold:this.effectiveThreshold(bins)
                }
            })
            return {lowBound:Number.isFinite(guess)?guess:domain[0],highBound:domain[1]}
        }catch(err){
            console.warn("[TrimmerNode] guess failed, falling back to the frame:",err)
            return frame
        }
    }
    //The Guess button, and the method-change path: seed the cursors from the
    //kernel, then actually trim with them.
    async guessFromKernel(){
        //The cursors belong to the SINGLE-input case. With several waves there
        //is nothing to seed: every input is already seeded from its own data on
        //every resolve, so the button would re-run the whole thing to obtain
        //exactly what is already published.
        if(this.isMultiplexed()){
            await this.startResolve()
            return
        }
        await this.seedBoundsFromKernel()
        await this.applyTrimBounds()
    }
    //Re-runs ONLY the trim kernel on the already-known input wave. The frame
    //stays untouched: a drag must not rescale the axis the user is dragging on.
    async applyTrimBounds(){
        const inputWave=this.lastInputWave
        if(!inputWave) return
        //the cursors are the single-input case's own state. Trimming the ONE
        //wave on the frame while N are published would leave the output
        //describing a spectrum that is not there any more, so the multiplexed
        //resolve is the only thing allowed to publish.
        if(this.isMultiplexed()) return
        //a drag fires dozens of events: only the newest run may publish, or the
        //output would flicker back to a stale trim
        const ticket=++this.trimRun
        const methodParams=this.methodParams()
        try{
            //trim_apply knows nothing about methods: the two cursors, and
            //nothing else, define the cut
            const result=await computePool.run("trimApply",{
                core:inputWave.core,
                params:{
                    stride:inputWave.degree===2&&inputWave.dims[1]===2?2:1,
                    lowBound:this.parameters.lowBound,
                    highBound:this.parameters.highBound
                }
            })
            if(ticket!==this.trimRun) return
            this.trimResult=result
            this.outputs[0]=result.keptCount
                ?[Wave.fromCoordinates(result.pointsX,result.pointsY,{
                    title:`${this.title} (trimmed)`,
                    method:this.parameters.method,
                    kept:result.keptCount,
                    total:result.totalCount
                },["x","y"])]
                :[]
            this.status="resolved"
            //repaint: the kept/total readout and the cursor fields are derived
            //from the new result, so a drag would otherwise leave a stale count
            this.refreshTrimmerUI()
            //the output just changed: everything downstream must recompute
            this.scheduleResolveChildren()
        }catch(err){
            console.error("[TrimmerNode] Error applying bounds:",err)
            this.status="error"
        }
    }
    //Pins both frame domains. Called on setup AND after every resolve, because
    //the first paint runs on the placeholder and the second on real data.
    pinTrimDomains(){
        if(!this.graph) return
        const bins=this.bins
        const maxCount=Math.max(...bins.map(bin=>bin.count),1)
        const bottom=this.graph.parameters.axis.bottom
        //A log VALUE axis with a linear COUNT axis hides the whole point of the
        //frame: the noise floor puts a couple of thousand points in one bar while
        //the peaks hold one or two, which is a few pixels on a linear count scale.
        //On a log histogram the count axis goes log too, so a bar of 1 is still
        //visible next to a bar of 2000.
        if(this.parameters.logY){
            bottom.scale="log"
            //0 has no place on a log axis. The floor sits BELOW 1 on purpose: a
            //peak bar that holds a single point would otherwise be drawn at the
            //origin with zero length, i.e. invisible. At 0.5 it spans a tenth of
            //the axis, so a one-point peak is still a visible mark.
            bottom.domain=[0.5,maxCount*1.2]
        }else{
            bottom.scale="linear"
            bottom.domain=[0,maxCount*1.1]
        }
        this.graph.parameters.axis.left.domain=this.trimValueDomain()
    }
    //Value axis domain derived from the real histogram. It starts at the
    //minimum bin rather than 0: a spectrum whose noise floor sits at 800 would
    //otherwise be squashed into the top 20% of the frame. The high end gets a
    //5% headroom so the tallest bar never touches the border.
    valueDomainFromBins(histogram){
        const min=Number.isFinite(histogram.min)?histogram.min:0
        const max=Number.isFinite(histogram.max)?histogram.max:1
        if(!(max>min)) return [min,min+1]
        return [min,max+(max-min)*0.05]
    }
    //Renders one number input per field declared by the selected method. The
    //registry stays the single source of truth: a method that declares no field
    //gets no row at all (passthrough), and a new one needs no change here.
    renderMethodFields(){
        const row=this.fieldsRow
        if(!row) return
        row.replaceChildren()
        const fields=this.currentMethod().fields??[]
        //"flex", never "": an empty string REMOVES the inline display, and the row
        //falls back to block, where two flex labels stack vertically
        row.style.display=fields.length?"flex":"none"
        const params=this.methodParams()
        for(const field of fields){
            const id=`trim-${this.parameters.method}-${field.key}`
            const input=CE("input",{
                id,
                type:"number",
                step:field.step??"any",
                min:field.min,
                title:field.title??field.key,
                //a compact box: the native spinners cost ~16px each and forced
                //k and window onto two lines. The node already hides them on
                //the cursor fields, so this stays consistent within the widget.
                style:{
                    width:"56px",
                    boxSizing:"border-box",
                    padding:"1px 4px",
                    fontSize:"0.85em",
                    "-moz-appearance":"textfield",
                    appearance:"textfield"
                }
            },[])
            //shows the EFFECTIVE value: with no user input the field displays the
            //data-driven quantile, so the box is never a misleading 0.
            //
            //...except while multiplexed. There is no single effective value
            //any more: each input carries its own threshold, and showing the
            //first one's would make a per-spectrum number look like a setting.
            //The method's own default is what is honest here.
            const shown=field.key==="threshold"&&!Number.isFinite(this.parameters.methodParams?.threshold)
                ?(this.isMultiplexed()?field.value:this.effectiveThreshold())
                :(params[field.key]??field.value)
            input.value=formatCursorValue(shown)
            input.title=this.isMultiplexed()
                ?`${field.title??field.key}. Applied to every input; each spectrum still gets its own threshold, read from its own data.`
                :(field.title??field.key)
            input.addEventListener("change",async()=>{
                const parsed=parseFloat(input.value)
                if(!Number.isFinite(parsed)){input.value=formatCursorValue(params[field.key]??field.value);return}
                const before=this.trimSettingsSnapshot()
                this.parameters.methodParams={...this.parameters.methodParams,[field.key]:parsed}
                //the knob moved: the method threshold moved with it, so the
                //cursor must be re-seeded and the wave re-trimmed
                await this.guessFromKernel()
                this.recordTrimSettings(before,`Trimmer ${field.key}`)
            })
            const label=CE("label",{
                for:id,
                //Label and box side by side, like the control bar. flex:none
                //stops the label being squeezed into a wrap, and the box has a
                //fixed width so the pair stays compact on one line.
                style:{display:"flex",alignItems:"center",gap:"4px",flex:"none",whiteSpace:"nowrap"}
            },[field.key])
            label.append(input)
            row.append(label)
        }
    }
    //Real bins, filled by the trimHistogram kernel. The placeholder stays as the
    //first paint so the frame is readable before any data arrives.
    //them without the kernel: before any wave is connected there is nothing for
    //the kernel to look at, and "keep everything" is the honest default. It used
    //to apply a per-method ratio here, which silently overrode the kernel's own
    //threshold - duplicated in drawTrimmerOverlay, and the source of a bug where
    //a hand-placed cursor was dragged back to an arbitrary fraction of the frame.
    resetBoundsToFrame(){
        const domain=this.trimValueDomain()
        if(!domain.every(Number.isFinite)) return false
        this.parameters.lowBound=domain[0]
        this.parameters.highBound=domain[1]
        return true
    }
    refreshTrimmerUI(){
        //the live kept/total count: the cursors alone cannot tell a real trim
        //from a no-op, this number does
        if(this.keptLabel&&this.trimResult){
            this.keptLabel.textContent=this.keptReadout()
            this.keptLabel.title=this.keptTitle()
        }
        this.graph?.drawGraph()
    }
    /* WHAT THE COUNTER SAYS, in the two states.

       With one input it is the plain kept/total the node has always shown. With
       several, the number that matters is the MULTIPLEX itself: "3 entries"
       says the node is treating them all the same way, and the totals say what
       that cost. A bare kept/total over a merged-looking figure would read as one
       spectrum that happened to be trimmed. */
    keptReadout(){
        if(!this.isMultiplexed()){
            return `${this.trimResult.keptCount}/${this.trimResult.totalCount}`
        }
        return `${this.multiplexCount} entrées · ${this.trimResult.keptCount}/${this.trimResult.totalCount}`
    }
    keptTitle(){
        return this.isMultiplexed()
            ?"Inputs read, and the points they kept, summed over them. Each input is trimmed on its own data: one threshold per spectrum, from the selected method."
            :"Points kept by the trim, out of the input points"
    }
    //bars + cursors, each cursor carrying its own number field
    drawTrimmerOverlay(){
        const graph=this.graph
        if(!graph?.graphSVG) return
        const zone=graph.graphzone
        if(!(zone.width>0&&zone.height>0)) return
        const {xScale,yScale}=graph.plotScales()
        const anchor=graph.graphSVG.select(".anchor")
        //Bars and cursors are separate groups. The bars are UPDATED in place by a
        //data join: removing and re-appending them on every paint makes the whole
        //set blink whenever the data or the scale changes, which a gradient makes
        //obvious. The cursors are cheap and carry inputs, so they are rebuilt.
        let barLayer=anchor.select(".trim-bars")
        if(barLayer.empty()) barLayer=anchor.append("g").attr("class","trim-bars")
        let cursorLayer=anchor.select(".trim-cursors")
        if(cursorLayer.empty()) cursorLayer=anchor.append("g").attr("class","trim-cursors")
        cursorLayer.selectAll("*").remove()
        /* THE CURSORS BELONG TO THE SINGLE-INPUT CASE.

           A multiplexed trimmer seeds every input from that input's own data, so
           a cursor here would be a bound for ONE of the N spectra — and the one
           on the frame would be whichever resolved first. Drawing it would offer
           a control that changes nothing about the other N-1, which is worse
           than offering none. The BARS stay whatever the answer: the frame still
           shows the distribution a threshold was read from, and there is one
           frame, so there is one spectrum's worth of bars to show. */
        const liveCursors=!this.isMultiplexed()
        //First paint, no data yet: seed the cursors once. With a wave connected,
        //startResolve has already placed them from the kernel, and this block
        //stays out of the way - it must never move a hand-placed cursor.
        if(liveCursors&&!Number.isFinite(this.parameters.highBound)){
            this.resetBoundsToFrame()
        }
        //xScale(0) is -Infinity on a log count axis, so the bar origin is the
        //DOMAIN floor: 0 when linear, 1 when log (a bar of 0 is not drawable, it
        //is simply not drawn)
        const bottomDomain=this.graph.parameters.axis.bottom.domain
        const x0=xScale(Number.isFinite(bottomDomain[0])?bottomDomain[0]:0)
        //horizontal bars: X = count, Y = the bin value
        const bins=this.bins
        const thickness=bins.length>1
            ?Math.abs(yScale(bins[1].value)-yScale(bins[0].value))*0.6
            :4
        //One shared gradient in USER space, not per-bar: an objectBoundingBox
        //gradient would restart on every rectangle, so a short bar would come
        //out fully bright while a long one showed the whole ramp. In user space
        //the ramp is anchored to the plot, and every bar reads the same way -
        //faint where it leaves the axis, bright green at its tip.
        //An id per SVG, taken from the element itself: Node carries no id of its
        //own, and a shared gradient id would make the first trimmer win for both.
        //d3's append() on an EMPTY selection creates nothing, so a <defs> that
        //does not exist yet must be appended first. Without this the gradient is
        //never created and fill="url(#...)" dangles: SVG then refuses to paint
        //the rect at all, which reads as "no bars".
        let defs=anchor.select("defs")
        if(defs.empty()) defs=anchor.append("defs")
        const gradId=`trim-bar-gradient-${graph.graphSVG.attr("id")}`
        //Bar fill: full green at the tip, fully TRANSPARENT at the axis.
        //
        //objectBoundingBox, not userSpaceOnUse: the ramp must run across EACH
        //bar's own width. In user space it spans the whole plot, so every bar
        //shows only the slice it happens to cover - a short one comes out a flat
        //mid-green, and the colour stops meaning anything.
        //
        //Transparent rather than black at the axis: opaque black paints over the
        //background instead of letting it show through.
        let grad=defs.select(`#${gradId}`)
        if(grad.empty()){
            grad=defs.append("linearGradient")
                .attr("id",gradId)
                .attr("x1","0%").attr("x2","100%").attr("y1","0%").attr("y2","0%")
            //transparent over the first 80% of EACH bar, green only in the last
            //20%. objectBoundingBox units, so the ramp follows every bar's own
            //width instead of spanning the plot - in user space a short bar would
            //only show the slice it happens to cover, as a flat mid-green
            grad.append("stop").attr("offset","0%").attr("stop-color","#00ff41").attr("stop-opacity",0)
            grad.append("stop").attr("offset","80%").attr("stop-color","#00ff41").attr("stop-opacity",0.5)
            grad.append("stop").attr("offset","100%").attr("stop-color","#00ff41").attr("stop-opacity",1)
        }
        //Data join keyed on the bin INDEX: the rects are reused and only their
        //geometry is rewritten, so a repaint never destroys the painted set. The
        //exit selection is what removes bins that the new histogram no longer has.
        const floor=Number.isFinite(bottomDomain[0])?bottomDomain[0]:0
        const drawable=bins.map((bin,index)=>{
            //on a log count axis an empty bin has nowhere to go
            if(bin.count<=0&&this.parameters.logY) return null
            const y=yScale(bin.value)
            const x1=xScale(Math.max(bin.count,floor))
            if(!Number.isFinite(y)||!Number.isFinite(x1)) return null
            return {index,bin,y,x1}
        }).filter(Boolean)
        barLayer.selectAll("rect.trim-bar")
            .data(drawable,d=>d.index)
            .join(
                enter=>enter.append("rect")
                    .attr("class","trim-bar")
                    .attr("fill",`url(#${gradId})`)
                    //no stroke: on a bar that fades to transparent the outline stays
                    //opaque, so empty bins would show up as a grid of thin
                    //rectangles and the fade would read as a boxed cell
                    .attr("stroke","none")
                    .style("pointer-events","none"),
                update=>update,
                exit=>exit.remove()
            )
            .attr("x",d=>Math.min(x0,d.x1))
            .attr("y",d=>d.y-thickness/2)
            .attr("width",d=>Math.max(1,Math.abs(d.x1-x0)))
            .attr("height",Math.max(2,thickness))
        if(!liveCursors) return
        for(const [key,color] of CURSOR_COLORS){
            const value=this.parameters[key]
            if(!Number.isFinite(value)) continue
            //a value bound is a HORIZONTAL line: X is the count axis and Y the
            //value axis, so the bound cuts the bars at their own value
            const y=yScale(value)
            if(!Number.isFinite(y)) continue
            const group=cursorLayer.append("g")
                .attr("class",`trim-cursor trim-cursor-${key}`)
                .style("cursor","ns-resize")
            group.append("title").text(key==="lowBound"?"Lower bound â€” drag to move":"Upper bound â€” drag to move")
            group.append("line")
                .attr("x1",0).attr("x2",zone.width).attr("y1",y).attr("y2",y)
                .attr("stroke",color).attr("stroke-width",TRIM_CURSOR_STROKE)
            //the field rides its own line: the control sits where it applies
            const field=document.createElement("input")
            field.type="number"
            field.step="any"
            field.value=formatCursorValue(value)
            //wider than 5.5em: values reach 100000 and carry decimals, and the
            //native spin buttons are pure noise here (you never nudge a
            //threshold by one, you drag the cursor or type it)
            field.style.cssText=`width:100px;box-sizing:border-box;padding:3px 6px;font-size:${TRIM_CURSOR_FIELD_FONT};font-weight:600;-moz-appearance:textfield;appearance:textfield;background:rgba(12,16,22,.82);color:${color};border:1px solid ${color};border-radius:4px`
            field.addEventListener("change",()=>{
                const parsed=parseFloat(field.value)
                if(!Number.isFinite(parsed)){field.value=String(value);return}
                //a typed bound is a DISCRETE act, so it is recorded HERE and not
                //in setTrimBound: the drag goes through that same function once
                //per pointermove, and a command per event would bury the stack
                const before=this.trimSettingsSnapshot()
                this.setTrimBound(key,parsed)
                this.recordTrimSettings(before,`Trimmer ${key}`)
            })
            //The box must be LARGER than the input it hosts. A foreignObject clips
            //its content, so an input wider or taller than the frame is simply
            //cut off - which is what a 92x20 frame around a 96px field at 0.95em
            //produced. Both numbers derive from the field, so they cannot drift.
            const fieldWidth=104
            const fieldHeight=26
            group.append("foreignObject")
                .attr("x",zone.width*0.5-fieldWidth/2).attr("y",y-fieldHeight/2)
                .attr("width",fieldWidth).attr("height",fieldHeight)
                .append(()=>field)
        }
    }

    setTrimBound(key,value){
        //no cursor exists while the node is multiplexed, so nothing may write
        //one: a bound typed here would apply to one spectrum and be read as
        //applying to all of them
        if(this.isMultiplexed()) return
        //the two bounds can never cross: each stops at the other
        if(key==="lowBound"&&Number.isFinite(this.parameters.highBound)){
            value=Math.min(value,this.parameters.highBound)
        }else if(key==="highBound"&&Number.isFinite(this.parameters.lowBound)){
            value=Math.max(value,this.parameters.lowBound)
        }
        if(this.parameters[key]===value) return
        this.parameters[key]=value
        //redraw instantly, so the cursor tracks the pointer, but DEBOUNCE the
        //kernel. A drag fires ~60 pointermove per second and each call copies
        //the whole core to the worker (megabytes on a real spectrum): running
        //the trim synchronously per event is what makes dragging feel heavy, not
        //the trim itself, which is linear and takes ~1ms in wasm.
        this.refreshTrimmerUI()
        this.scheduleTrim()
    }
    //Coalesces the trims of a drag into a single kernel run, then wakes the
    //children once. Same debounce idea as scheduleResolveChildren, but it guards
    //the expensive part: the postMessage copy.
    scheduleTrim(){
        if(this.trimDebounceTimer) clearTimeout(this.trimDebounceTimer)
        this.trimDebounceTimer=setTimeout(()=>{
            this.trimDebounceTimer=null
            this.applyTrimBounds()
        },90)
    }
    //Debounced downstream resolve. A drag fires dozens of pointermove events,
    //and each one would otherwise queue a kernel run plus a whole subtree
    //re-resolve: the downstream graphs would strobe and the last write could
    //land before the first. Same pattern as the peak-picking node.
    scheduleResolveChildren(){
        if(this.dragDebounceTimer) clearTimeout(this.dragDebounceTimer)
        this.dragDebounceTimer=setTimeout(()=>{
            this.dragDebounceTimer=null
            this.resolveChildren()
        },120)
    }
    //resolveChildren() is inherited from Node, which delegates to the flow.
    //A copy of that traversal used to live here, and another in the peak-picking
    //node: three identical implementations of "what is downstream of me" is
    //exactly how they drift apart.

    /* Every setting this node owns, in one object.

       The undo stack and the session file ask the SAME question - "what were
       the settings?" - and the two must not be able to drift apart, so there is
       one snapshot and both take it. That is also the shape serializeState
       writes, one field at a time. linearValueDomain is deliberately absent: it
       is read off the data on every resolve, and a saved copy would be a number
       nobody chose. */
    trimSettingsSnapshot(){
        return {
            method:this.parameters.method,
            methodParams:{...this.parameters.methodParams},
            lowBound:this.parameters.lowBound,
            highBound:this.parameters.highBound,
            logY:!!this.parameters.logY
        }
    }
    /* Puts a snapshot back AND re-applies it. The output matters as much as the
       cursors: a trimmer whose window moved back while its wave still shows the
       old cut is lying about what it did. applyTrimBounds returns early without
       an input wave, so this is safe before the first resolve. */
    restoreTrimSettings(snapshot){
        this.parameters.method=snapshot.method
        this.parameters.methodParams={...snapshot.methodParams}
        this.parameters.lowBound=snapshot.lowBound
        this.parameters.highBound=snapshot.highBound
        this.parameters.logY=!!snapshot.logY
        this.updateTrimmerControls()
        this.applyTrimBounds()
    }
    /* One command per DISCRETE act. A drag of a cursor records once, at
       pointerup: its dozens of setTrimBound calls in between are not acts, they
       are one act in progress, and a command each would bury every other undo.
       Nothing is recorded if nothing moved, so the scale toggle cannot be
       double-counted by a restore that goes through it. */
    recordTrimSettings(before,label){
        const after=this.trimSettingsSnapshot()
        const unchanged=before.method===after.method
            &&before.lowBound===after.lowBound
            &&before.highBound===after.highBound
            &&before.logY===after.logY
            &&Object.keys(before.methodParams).length===Object.keys(after.methodParams).length
            &&Object.entries(after.methodParams).every(([key,value])=>before.methodParams[key]===value)
        if(unchanged) return
        this.origin?.history?.record?.(new Command({
            label,
            undo:()=>this.restoreTrimSettings(before),
            redo:()=>this.restoreTrimSettings(after)
        }))
    }
    handleTrimPointerDown(event){
        const graph=this.graph
        if(!graph) return
        //no cursor is drawn while the node is a batch, so there is nothing to
        //grab: refusing the gesture here also keeps it out of the undo stack,
        //where a drag that moved nothing would be a command that undoes nothing
        if(this.isMultiplexed()) return
        const zone=graph.graphzone
        if(!(zone.width>0&&zone.height>0)) return
        event.preventDefault()
        const rect=graph.container.getBoundingClientRect()
        const {yScale}=graph.plotScales()
        const toValue=(y)=>yScale.invert(Math.min(Math.max(y,0),zone.height))
        const pointer=()=>event.clientY-rect.top-graph.parameters.margins.top
        //TELEPORT the nearest cursor to the pointer. Grabbing requires going
        //to fetch the cursor first, which is precisely the friction this
        //removes: the hand is already where the bound should land.
        //Non finite bounds are filtered out, otherwise a null highBound makes
        //yScale return NaN and the reduce below can only ever pick the other.
        const candidates=["lowBound","highBound"]
            .map(key=>{
                const value=this.parameters[key]
                if(!Number.isFinite(value)) return null
                const y=yScale(value)
                return Number.isFinite(y)?{key,distance:Math.abs(y-pointer())}:null
            })
            .filter(Boolean)
        const grabbed=candidates.reduce((best,entry)=>entry.distance<best.distance?entry:best,candidates[0]??null)
        if(!grabbed) return
        const key=grabbed.key
        const before=this.trimSettingsSnapshot()
        this.setTrimBound(key,toValue(pointer()))
        const onMove=(moveEvent)=>{
            this.setTrimBound(key,toValue(moveEvent.clientY-rect.top-graph.parameters.margins.top))
        }
        const onUp=()=>{
            window.removeEventListener("pointermove",onMove)
            window.removeEventListener("pointerup",onUp)
            //the last position must not wait for the debounce: the drag is over,
            //so publish the final trim now instead of ~90ms later
            if(this.trimDebounceTimer){
                clearTimeout(this.trimDebounceTimer)
                this.trimDebounceTimer=null
                this.applyTrimBounds()
            }
            this.recordTrimSettings(before,"Trimmer bounds")
        }
        window.addEventListener("pointermove",onMove)
        window.addEventListener("pointerup",onUp)
    }
    //Hover highlighting is parked, not deleted: the bin-snapping logic below is
    //the right place to hang a proper readout, and the pointer handlers are
    //still wired. Re-enable by giving setTrimHover a body.
    setTrimHover(index){
        void index
    }
    handleTrimHover(event){
        const graph=this.graph
        if(!graph?.graphSVG) return
        const rect=graph.container.getBoundingClientRect()
        const py=event.clientY-rect.top-graph.parameters.margins.top
        const {yScale}=graph.plotScales()
        let best=null
        let bestDistance=Infinity
        this.bins.forEach((bin,index)=>{
            const distance=Math.abs(yScale(bin.value)-py)
            if(distance<bestDistance){bestDistance=distance;best=index}
        })
        //half a bin, not a fixed pixel count: the snap follows the zoom level
        const half=this.bins.length>1
            ?Math.abs(yScale(this.bins[1].value)-yScale(this.bins[0].value))/2
            :4
        this.setTrimHover(bestDistance<=Math.max(half,4)?best:null)
    }
    /* THE RESOLVE, and the fork that decides everything else.

       The PORT is still constrained — a link must land on input 0, the only one
       there is — but the NUMBER of links is no longer a question. The old check
       refused to resolve as soon as a second cable arrived, and it was counting
       the links whose inputNode is this one, which are its CONSUMERS: wiring the
       trimmed wave to a second node made the trimmer refuse to resolve even
       though fan-out on the output is none of its business.

       What decides the shape of the resolve is not the number of cables but the
       number of WAVES they bring. One wave is the case this node was built for
       and it is resolved exactly as before — cursors, frame, hand-placed bounds
       and all. Several waves are a request to treat them all the same way, and
       that request is answered without one knob per spectrum. */
    async startResolve(){
        const inputLinks=(this.destination?.linkList??[]).filter(link=>link.outputNode===this)
        if(inputLinks.some(link=>link.inputAnchor.id!=="0")){
            this.status="error"
            this.outputs[0]=[]
            console.error("[TrimmerNode] only input 0 is read by this node")
            return
        }
        const {waves,skipped}=this.collectInputWaves()
        this.skippedInputs=skipped
        this.multiplexCount=waves.length
        this.updateTrimmerMultiplex()
        if(!waves.length){
            this.status="floating"
            this.outputs[0]=[]
            //the wave is gone: a later drag must not trim a stale input
            this.lastInputWave=null
            this.refreshTrimmerUI()
            return
        }
        if(waves.length===1){
            //the aggregate belonged to the multiplex this node no longer is: left
            //in place it would go on counting points that are no longer trimmed
            this.multiplexTotals=null
            await this.resolveOneInput(waves[0])
            return
        }
        await this.resolveMultiplexed(waves)
    }
    /* ONE WAVE IN, ONE TRIMMED WAVE OUT — the whole original resolve.

       Split out of startResolve, not rewritten: this is the single-input case
       the node has always had, and the only thing multiplexing changes about it
       is that it stops being the only case. */
    async resolveOneInput(inputWave){
        this.status="pending"
        this.lastInputWave=inputWave
        const stride=inputWave.degree===2&&inputWave.dims[1]===2?2:1
        try{
            //the frame is drawn from the FULL wave, before any trimming: the
            //user places the cursors on the input distribution, not on the
            //already-cut one
            this.adoptHistogram(await this.trimHistogramFor(inputWave,stride))
            //the cursors belong to the METHOD, not to this resolve: a re-resolve
            //with unchanged parameters must NOT move a bound the user placed by
            //hand. Only an absent bound is seeded, from the kernel threshold.
            if(!Number.isFinite(this.parameters.lowBound)||!Number.isFinite(this.parameters.highBound)){
                await this.seedBoundsFromKernel()
            }
            //then cut, with the cursors alone
            const result=await computePool.run("trimApply",{
                core:inputWave.core,
                params:{
                    stride,
                    lowBound:this.parameters.lowBound,
                    highBound:this.parameters.highBound
                }
            })
            this.trimResult=result
            this.outputs[0]=result.keptCount
                ?[Wave.fromCoordinates(result.pointsX,result.pointsY,{
                    title:`${this.title} (trimmed)`,
                    method:this.parameters.method,
                    kept:result.keptCount,
                    total:result.totalCount
                },["x","y"])]
                :[]
            this.status="resolved"
        }catch(err){
            console.error("[TrimmerNode] Error resolving:",err)
            this.status="error"
            this.outputs[0]=[]
        }
        this.refreshTrimmerUI()
    }
    /* N WAVES IN, N TRIMMED WAVES OUT, each cut on ITS OWN data.

       The method stays the user's to choose — that is what a multiplex asks for:
       one recipe, applied N times. Everything the recipe reads off the data is
       re-read per input, because a threshold measured on one spectrum says
       nothing about the next: the 5 % quantile of THIS histogram, the noise of
       THIS core. The cursors are not consulted at all; they belong to the
       single-input case, and this path leaves `parameters.lowBound/highBound`
       exactly as it found them, so pulling the second cable out gives back the
       window the user had placed by hand.

       SEQUENTIALLY, like F-KMD's and Attribution's: the pool holds a few
       workers, a burst would queue every multi-megabyte core at once and stall
       the interface on all of them instead of one at a time.

       A wave the kernel fails on is recorded and the resolve carries on: one
       broken spectrum is one broken result, not a dead node. "error" is only for
       when NOTHING came out — a node painted red over seven good products would
       be lying. */
    async resolveMultiplexed(waves){
        const run=++this.resolveRun
        this.status="pending"
        const products=[]
        const errors=[]
        let keptCount=0
        let totalCount=0
        let framed=false
        for(let i=0;i<waves.length;i++){
            if(run!==this.resolveRun) return       //superseded: publish nothing
            if(i>0) await new Promise(resolve=>setTimeout(resolve,0))
            if(run!==this.resolveRun) return
            const wave=waves[i]
            const label=wave.metadata?.title??`entrée ${i+1}`
            try{
                const stride=wave.degree===2&&wave.dims[1]===2?2:1
                const histogram=await this.trimHistogramFor(wave,stride)
                const bins=binsOfHistogram(histogram)
                const linear=this.valueDomainFromBins(histogram)
                if(!framed){
                    /* THE FRAME IS THE FIRST INPUT'S, and the counter says how
                       many there are. One picture standing for N distributions
                       would be a claim about a spectrum nobody has; the first
                       one is real data, and the readout is what warns the reader
                       that it is one of several. */
                    this.lastInputWave=wave
                    this.histogramDropped=histogram.dropped??0
                    this.bins=bins
                    this.linearValueDomain=linear
                    this.pinTrimDomains()
                    framed=true
                }
                const bounds=await this.guessBoundsFor(wave,linear,bins)
                if(!bounds) continue
                const result=await computePool.run("trimApply",{
                    core:wave.core,
                    params:{stride,lowBound:bounds.lowBound,highBound:bounds.highBound}
                })
                keptCount+=result.keptCount
                totalCount+=result.totalCount
                if(result.keptCount){
                    products.push(Wave.fromCoordinates(result.pointsX,result.pointsY,{
                        title:`${this.title} (trimmed)`,
                        method:this.parameters.method,
                        kept:result.keptCount,
                        total:result.totalCount,
                        //WHICH spectrum this is. They all share the node's title,
                        //and a consumer reading the metadata has no other way to
                        //tell three products apart.
                        source:label
                    },["x","y"]))
                }
            }catch(err){
                errors.push(`${label}: ${err?.message??String(err)}`)
            }
        }
        if(run!==this.resolveRun) return
        this.trimResult={keptCount,totalCount}
        this.multiplexTotals={inputs:waves.length,keptCount,totalCount,errors}
        this.outputs[0]=products
        this.status=errors.length&&!products.length?"error":"resolved"
        if(errors.length) console.error("[TrimmerNode] some inputs failed:",errors)
        this.refreshTrimmerUI()
    }
    /* The histogram kernel call, with the binning the AXIS scale asks for: on a
       log axis the bars must be evenly spaced in decades, otherwise every point
       piles into the first bar and the distribution is unreadable. Both paths
       call it, so neither can drift into a binning of its own. */
    async trimHistogramFor(wave,stride){
        return computePool.run("trimHistogram",{
            core:wave.core,
            params:{
                stride,
                //an upper bound: in log mode the kernel derives the real bar
                //count from the span of the data (bars per decade), because a
                //fixed count over a 2-decade spectrum comes out mostly empty
                bins:TrimmerNode.HISTOGRAM_BINS,
                scale:this.parameters.logY?"log":"linear"
            }
        })
    }
    /* Takes a histogram onto the frame: the bars, the value span, the domains.

       Array.from first: Float64Array.prototype.map returns a Float64Array, not an
       array of objects, so mapping the typed array straight through would
       silently produce a buffer of NaN instead of the bin objects. */
    adoptHistogram(histogram){
        this.histogramDropped=histogram.dropped??0
        this.bins=binsOfHistogram(histogram)
        this.linearValueDomain=this.valueDomainFromBins(histogram)
        this.pinTrimDomains()
    }

    /* THE CONTROLS, in the two states.

       The METHOD stays live: it is the one thing the N spectra share, and
       choosing it is choosing how all of them will be treated. Everything that
       tunes ONE spectrum — the cursors, and the Guess that moves them — goes
       grey, because a bound the user can still place while N spectra are
       published would look as though it applied to them, and would not.

       `disabled` and not a class of our own: the browser already knows how to
       grey a control it must not accept, and a hand-rolled opacity would leave
       the control perfectly clickable.

       `renderMethodFields()` runs LAST, because it rebuilds the field row from
       scratch — a field rebuilt after the greying would come back enabled. */
    updateTrimmerMultiplex(){
        const on=this.isMultiplexed()
        if(this.guessBtn) this.guessBtn.disabled=on
        if(this.methodSelect){
            this.methodSelect.title=on
                ?"Trimming method, applied to EVERY input: each one is cut at the threshold this method reads off its own data."
                :"Trimming method"
        }
        this.renderMethodFields()
    }

    /* What this node IS, as opposed to what it computed.

       This is the only durable record of the settings. The undo stack cannot
       be one: a Command holds closures, and closures do not serialize, so the
       history dies with the tab whatever we do. The trimmer had neither half of
       this, and an exported session came back as a pass-through with no window
       - a silent loss of the one number the user had tuned.

       The MULTIPLEX is not in here, and deliberately: it is a property of the
       links, so spelling it out in the state would mean saying it twice — here,
       and in every session file — for something a resolve can read off the
       graph in one line. */
    serializeState(){
        return {
            method:this.parameters.method,
            //methodParams is stored VERBATIM, an untouched field staying ABSENT
            //rather than filled with its default: methodParams() must keep
            //telling "the user typed this" from "this is the method's default",
            //or effectiveThreshold quietly falls back to the data quantile and
            //the typed threshold is gone
            methodParams:{...this.parameters.methodParams},
            lowBound:this.parameters.lowBound,
            highBound:this.parameters.highBound,
            logY:!!this.parameters.logY,
            status:this.status
        }
    }
    /* Reads a state back, defensively on every field: a session saved by an
       older build, or one naming a method this build no longer knows, has to
       degrade to a default instead of throwing halfway through an import.

       The kernel is NOT run here. It is the flow's own resolve that will call
       startResolve(), in order, with the inputs rebuilt from the links - the
       same rule FKMDNode follows. */
    restoreState(state){
        if(!state) return
        if(typeof state.method==="string"&&TRIM_METHODS[state.method]){
            this.parameters.method=state.method
        }
        if(state.methodParams&&typeof state.methodParams==="object"){
            this.parameters.methodParams={...state.methodParams}
        }
        //null is a MEANINGFUL value here - "this cursor was never placed" - so
        //it is accepted, while undefined and NaN leave the default alone
        if(state.lowBound===null||Number.isFinite(state.lowBound)){
            this.parameters.lowBound=state.lowBound
        }
        if(state.highBound===null||Number.isFinite(state.highBound)){
            this.parameters.highBound=state.highBound
        }
        if(typeof state.logY==="boolean"){
            this.parameters.logY=state.logY
        }
        this.status=state.status??"floating"
        this.updateTrimmerControls()
    }
    /* Pushes the parameters into the widgets. Without it a restored node would
       trim with madResidual while its own dropdown still read "pass-through" -
       the node and its own inspector telling different stories. */
    updateTrimmerControls(){
        if(this.methodSelect) this.methodSelect.value=this.parameters.method
        this.applyMethodHint?.()
        this.renderMethodFields()
        if(this.logYToggle){
            //the toggle paints from get(), and a restore sets logY directly, so
            //the colours have to be re-read from the parameter
            this.logYToggle.paint()
        }
        if(this.graph){
            //setLogY normally re-pins the frame, and a restore does not go
            //through it, so the scale and the frame are set here instead
            this.graph.parameters.axis.left.scale=this.parameters.logY?"log":"linear"
            this.pinTrimDomains()
        }
        this.refreshTrimmerUI()
    }
}

