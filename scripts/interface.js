import {$,CE,stylize,fakeData,DC,requestPOST,SingleJsonFile} from "./util.js"
import {save as saveSession, import as importSessionData} from "./sessions.js"
import * as d3 from "https://cdn.jsdelivr.net/npm/d3@7/+esm"
import {defaultMenu} from "../resources/config.js"
import { Data , Vector, Wave, XYTrace} from "./formats.js"
import {computePool} from "./workerPool.js"
import {GLTraceLayer,shapeId,parseCssColor,THREE_CDN} from "./plot2d-gl.js"

window.raie=new Wave(10,2)
window.eiar=new Wave(7)

class Command{
    constructor({label="action",undo,redo}={}){
        this.label=label
        this._undo=undo
        this._redo=redo
    }
    undo(){
        return this._undo?.()
    }
    redo(){
        return this._redo?.()
    }
}

class History{
    constructor(){
        this.undoStack=[]
        this.redoStack=[]
        this.replaying=false
    }
    record(command){
        if(this.replaying){
            return
        }
        if(!(command instanceof Command)){
            command=new Command(command)
        }
        this.undoStack.push(command)
        this.redoStack=[]
        this.notify()
    }
    undo(){
        const command=this.undoStack.pop()
        if(!command){
            return
        }
        this.replaying=true
        try{
            command.undo()
            this.redoStack.push(command)
        }finally{
            this.replaying=false
        }
        this.notify()
    }
    redo(){
        const command=this.redoStack.pop()
        if(!command){
            return
        }
        this.replaying=true
        try{
            command.redo()
            this.undoStack.push(command)
        }finally{
            this.replaying=false
        }
        this.notify()
    }
    get undoLabel(){
        return this.undoStack.at(-1)?.label??null
    }
    get redoLabel(){
        return this.redoStack.at(-1)?.label??null
    }
    notify(){
        dispatchEvent(new CustomEvent("historyChanged",{detail:{msg:{
            canUndo:this.undoStack.length>0,
            canRedo:this.redoStack.length>0,
            undoLabel:this.undoLabel,
            redoLabel:this.redoLabel
        }}}))
    }
}

class Node{
    constructor(title,inputs, outputs,origin,destinationFlow,position={x:10,y:10}){
        this.title=title
        this.inputs=inputs
        this.outputs=outputs
        this.origin=origin
        this.destination=destinationFlow
        this.destination.nodeSet.add(this)
        this.upToDate=true
        this.drawn=false
        this.events={broadcast:{
            nodeMove:new CustomEvent("nodeMove",{detail:{msg:"",emitter:this}}),
            startLinkDrawing(anchor){return new CustomEvent("startLinkDrawing",{detail:{msg:{starter:anchor},emitter:this}})},
            stopLinkDrawing(anchor){return new CustomEvent("stopLinkDrawing",{detail:{msg:{stopper:anchor},emitter:this}})},
            nodeSelected:new CustomEvent("nodeSelected",{detail:{msg:"I'm a node selected",emitter:this}}),
            nodeKilled:new CustomEvent("nodeKilled",{detail:{msg:"",emitter:this}}),
            nodeStatusChanged(status){return new CustomEvent("nodeStatusChanged",{detail:{msg:{status},emitter:this}})},
        },listen:{
            registered(e){
                this.registered(e)
            },
            nodeSelected(e){
                if (e.detail.emitter.events.registrationId===this.events.registrationId) {
                    if(document.activeElement===this.SVGg.select('rect').node()){
                        this.SVGg.select('rect').node().blur()
                    }else{
                        this.SVGg.select('rect').node().focus()
                    }
                }
            }
        }}
        this.parameters={
            heightPerItem:12,
            margin:2.5,
            width:150,
            position:position,
            rounding:5,
            outputs:{
                positions:new Array(this.outputs.length)
            },
            inputs:{
                positions:new Array(this.inputs.length)
            },
            anchorMap:new Map()
        }
        this.SVGg=d3.create("svg:g").attr('class','nodeContainer')
        this.SVGg.append("rect")
            .attr('x',0)
            .attr('y',0)
            .attr("width", this.parameters.width)
            .attr('height',this.nodeHeight)
            .attr("rx", this.parameters.rounding)
            .attr("ry", this.parameters.rounding)
            .attr("tabindex",0)
            .attr("class","node")
        for(let k in inputs){
            this.parameters.inputs.positions[k]={x:0,y:this.parameters.rounding+this.parameters.margin+(Number(k)+0.5)*this.parameters.heightPerItem}
            this.SVGg.append('svg:circle')
                .attr('cx',this.parameters.inputs.positions[k].x)
                .attr('cy',this.parameters.inputs.positions[k].y)
                .attr("r", 5)
                .attr('class','input anchor')
                .attr('id',k)
                .style("z-index", 1)
        }
        for(let k in outputs){
            this.parameters.outputs.positions[k]={x:this.parameters.width,y:this.parameters.rounding+this.parameters.margin+(Number(k)+0.5)*this.parameters.heightPerItem}
            this.SVGg.append('circle')
                .attr('cx',this.parameters.width)
                .attr('cy',this.parameters.outputs.positions[k].y)
                .attr("r", 5)
                .attr('class','output anchor')
                .attr('id',k)
                .style("z-index", 1)
        }
        this.SVGg.append("text")
            .attr("x",10)
            .attr("y",this.nodeHeight/2+2.5)
            .text(title)
            .attr('id','nodeTitle')
        this.SVGg.attr('transform', 'translate('+`${this.parameters.position.x},${this.parameters.position.y}`+')')
        this.DOMelt=this.SVGg.node()
        this.DOMelt.querySelector('rect').pilot=this
        this.DOMelt.querySelector('rect').handleClick=(e)=>globalThis.dispatchEvent(e.target.pilot.events.broadcast.nodeSelected)
        this.DOMelt.querySelector('rect').handleMouseDown=(e)=>e.target.pilot.drag(e)
        this.DOMelt.querySelector('rect').handleContextmenu=(e)=>{console.log(e)}
        this.DOMelt.querySelector('rect').handleKeyDown=(e)=>{
            if(e.key==="Delete"){
                e.target.pilot.suicide()
            }
        }
        for(let anchor of this.DOMelt.querySelectorAll('.anchor')){
            const k=anchor.id
            const anchortype=anchor.classList.contains("output")? "output" : "input"
            this.parameters.anchorMap.set(anchor,{
                type:anchortype,
                positions:this.parameters[anchortype+"s"].positions[k]
            })
            anchor.pilot=this
            anchor.handleMouseDown=(e)=>{
                dispatchEvent(e.target.pilot.events.broadcast.startLinkDrawing.call(e.target.pilot,e.target))
            }
            anchor.handleMouseUp=(e)=>{
                dispatchEvent(e.target.pilot.events.broadcast.stopLinkDrawing.call(e.target.pilot,e.target))
            }
        }
        this._status='floating'
        this.draw()
    }
    registered(e){
    }
    draw(){
        if(!this.drawn){
            this.drawn=true
            this.destination.container.querySelector('.field').append(this.DOMelt)
            this.fitWidthToTitle()
        }
    }
    fitWidthToTitle(){
        const titleElement=this.DOMelt.querySelector('#nodeTitle')
        const titleWidth=titleElement.getComputedTextLength()
        this.parameters.width=Math.max(150,titleWidth+20)
        this.DOMelt.querySelector('rect').setAttribute('width',this.parameters.width)
        for(const [anchor,anchorData] of this.parameters.anchorMap){
            if(anchorData.type==='output'){
                anchorData.positions.x=this.parameters.width
                anchor.setAttribute('cx',this.parameters.width)
            }
        }
    }
    get nodeHeight(){
        return 2*(this.parameters.rounding+this.parameters.margin)+Math.max(1,Math.max(this.outputs.length,this.inputs.length))*this.parameters.heightPerItem
    }
    drag(e){
        e.preventDefault();
        let dx=e.clientX;
        let dy=e.clientY;
        const pilot=e.target.pilot
        const before={...pilot.parameters.position}
        document.onmousemove=(e)=>{
            e.preventDefault();
            dx-=e.clientX;
            dy-=e.clientY;
            pilot.parameters.position.x-=dx
            pilot.parameters.position.y-=dy
            window.dispatchEvent(pilot.events.broadcast.nodeMove)
            pilot.SVGg.attr('transform', 'translate('+`${pilot.parameters.position.x},${pilot.parameters.position.y}`+')')
            dx=e.clientX;
            dy=e.clientY;
        }
        document.onmouseup=(e)=>{
            e.preventDefault();
            document.onmousemove=null;
            document.onmouseup=null;
            const after={...pilot.parameters.position}
            if(before.x!==after.x||before.y!==after.y){
                //the command resolves the live node at execution time: the pilot
                //may have been deleted then restored by an undo in between
                const resolveLive=()=>{
                    const flow=pilot.destination
                    if(flow.nodeSet.has(pilot)){
                        return pilot
                    }
                    const replacement=flow.replacements?.get(pilot)
                    return replacement&&flow.nodeSet.has(replacement)?replacement:null
                }
                pilot.origin.history.record(new Command({
                    label:`Move ${pilot.title}`,
                    undo:()=>resolveLive()?.setPosition(before),
                    redo:()=>resolveLive()?.setPosition(after)
                }))
            }
        }
    }
    setPosition(position){
        this.parameters.position={...position}
        this.SVGg.attr('transform',`translate(${position.x},${position.y})`)
        this.destination.updateLinks()
    }
    set status(value){
        const possible=['resolved','error','pending','floating']
        this.DOMelt.querySelector("rect").classList.remove(...possible)
        if(possible.includes(value)){
            this.DOMelt.querySelector("rect").classList.add(value)
        }else{
            value='floating'
        }
        this._status=value
    }
    get status(){
        return this._status
    }
    suicide({skipHistory=false}={}){
        const flow=this.destination
        const linkedDescriptors=flow.linkList
            .filter(link=>link.inputNode===this||link.outputNode===this)
            .map(link=>({
                inputNode:link.inputNode,
                inputIndex:Number(link.inputAnchor.id),
                outputNode:link.outputNode,
                outputIndex:Number(link.outputAnchor.id)
            }))
        const restoreData=nodeRestoreData(this)
        //forget stale replacements pointing at the node being killed
        for(const [deadOriginal,replacement] of flow.replacements){
            if(replacement===this){
                flow.replacements.delete(deadOriginal)
            }
        }
        dispatchEvent(this.events.broadcast.killed)
        for(const link of [...flow.linkList]){
            if(link.inputNode===this||link.outputNode===this){
                flow.deleteLink(link,{record:false})
            }
        }
        flow.nodeSet.delete(this)
        dispatchEvent(this.events.broadcast.nodeKilled)
        this.SVGg.node().remove()
        if(!skipHistory&&!this.origin.history.replaying){
            let restoredNode=null
            let restoredLinks=[]
            this.origin.history.record(new Command({
                label:`Delete node ${this.title}`,
                undo:()=>{
                    restoredNode=createNodeForHistory(this.origin,flow,restoreData)
                    restoredLinks=linkedDescriptors.map(link=>flow.createLink(
                        link.inputNode===this?restoredNode:link.inputNode,
                        link.inputIndex,
                        link.outputNode===this?restoredNode:link.outputNode,
                        link.outputIndex
                    )).filter(Boolean)
                    restoredNode.refreshFromLinks?.()
                    flow.replacements.set(this,restoredNode)
                },
                redo:()=>{
                    for(const link of [...restoredLinks]){
                        flow.deleteLink(link,{record:false})
                    }
                    restoredNode?.suicide({skipHistory:true})
                    restoredLinks=[]
                    flow.replacements.delete(this)
                }
            }))
        }
    }
    static anchorAbsPos(anchor){
        const anchorPos=anchor.pilot.parameters.anchorMap.get(anchor).positions
        const nodePos=anchor.pilot.parameters.position
        return {
            x:anchorPos.x+nodePos.x,
            y:anchorPos.y+nodePos.y
        }
    }
    async startResolve(){//default for testing
        if(this.status==='resolved') return
        this.status='pending'
        await new Promise(resolve=>{setTimeout(async ()=>{
            console.log(this.title)
            if(this.inputs.length){
                const protoOutput=await this.computeOutputs()
                for(let k in this.outputs){
                    this.outputs[k]=[...protoOutput]
                }
            }
            this.status='resolved'
            resolve()
            },
            1000)})
    }
    async computeOutputs(){
        let protoOutput=[]
        for(let input of this.inputs){
            console.log('pour cet input :',input)
            for(let entry of input.entries()){
                console.log('il y a cette entrée :',entry)
                for(let values of entry[1]){
                    console.log('qui contient ces valeurs :',values)
                    if(!Array.isArray(values)){
                        let convert=[]
                        for(let k in values){
                            values[k]=values[k]?values[k]:0
                            convert.push(values[k])
                        }
                        values=convert
                    }
                    for(let value of values){
                        console.log('et pour cette valeur ',value,' on incrémente et la valeur et le tableau')
                        protoOutput.push(value+1)
                    }
                }
            }
        }
        return protoOutput
    }
}

class Operation extends Node{
    constructor(title,origin,destinationFlow,position={x:180,y:10}){
        super(title,[[]],[[]],origin,destinationFlow,position)
    }
    operation(value){
        return Number(value)+1
    }
    async computeOutputs(){
        const output=[]
        for(const input of this.inputs){
            if(!(input instanceof Map)){
                continue
            }
            for(const values of input.values()){
                for(const waves of values){
                    if(!Array.isArray(waves)){
                        continue
                    }
                    for(const wave of waves){
                        if(!(wave instanceof Wave)){
                            continue
                        }
                        const transformed=wave.clone
                        //the wave core is copied by postMessage (no transfer:
                        //the input wave keeps its buffer), the kernel returns a
                        //fresh transferred buffer which becomes the new core
                        const {core}=await computePool.run("addScalar",{core:wave.core,params:{scalar:1}})
                        transformed.core=core
                        transformed.metadata={
                            ...wave.metadata,
                            transformedBy:[...(wave.metadata.transformedBy??[]),this.title]
                        }
                        output.push(transformed)
                    }
                }
            }
        }
        return output
    }
}

class NodeWithAccordion extends Node{
    registered(e){
        const {channel, registrationName, label, caster} = e.detail.msg
        if(caster !== this || this.accordion){
            return
        }
        this.accordion=new Accordion(
            label,
            this.origin,
            this.origin.main.querySelector(".vertical.left.content")
        )
        channel.register(`${registrationName}:accordion`,this.accordion,label)
    }
    suicide(options={}){
        this.accordion?.suicide()
        super.suicide(options)
    }
}

class DelimitedTextNode extends NodeWithAccordion{
    constructor(title,origin,destinationFlow,position={x:180,y:10}){
        super(title,[],[[]],origin,destinationFlow,position)
        this.parameters.source={
            lineSeparator:"\\r\\n|\\r|\\n",
            columnSeparator:"\\t|,|\\s",
            fileName:"",
            raw:"",
            pairs:[],
            labels:["x","y"]
        }
    }
    registered(e){
        if(e.detail.msg.caster !== this){
            return
        }
        super.registered(e)
        this.renderAccordion()
    }
    serializeState(){
        return {
            source:this.parameters.source,
            status:this.status
        }
    }
    restoreState(state){
        if(state?.source){
            this.parameters.source={labels:["x","y"],...state.source}
        }
        this.updateLabel(this.parameters.source.fileName)
        if(this.parameters.source.pairs?.length){
            this.outputs[0]=[Wave.fromPairs(this.parameters.source.pairs,{title:this.title,fileName:this.parameters.source.fileName},this.parameters.source.labels)]
        }else{
            this.outputs[0]=[]
        }
        this.status=state?.status??(this.parameters.source.pairs?.length?"resolved":"floating")
        this.renderAccordion()
    }
    async startResolve(){
        if(!this.parameters.source.pairs.length){
            this.outputs[0]=[]
            this.status="floating"
            return
        }
        this.outputs[0]=[Wave.fromPairs(this.parameters.source.pairs,{title:this.title,fileName:this.parameters.source.fileName},this.parameters.source.labels)]
        this.status="resolved"
    }
    setColumnLabels(labels){
        this.parameters.source.labels=Wave.normalizeLabels(labels)
        const wave=this.outputs[0]?.[0]
        if(wave instanceof Wave){
            wave.labels=[...this.parameters.source.labels]
        }
        this.status="floating"; // ou "pending"/"dirty" selon ta convention
        dispatchEvent(this.events.broadcast.nodeStatusChanged.call(this,this.status))
    }
    clear(){
        this.updateLabel("")
        this.parameters.source.fileName=""
        this.parameters.source.raw=""
        this.parameters.source.pairs=[]
        this.parameters.source.labels=["x","y"]
        this.outputs[0]=[]
        dispatchEvent(this.events.broadcast.nodeStatusChanged.call(this,"floating"))
        this.renderAccordion()
    }
    parseRaw(){
        const {raw,lineSeparator,columnSeparator}=this.parameters.source
        const pairs=[]
        for(const line of raw.split(RegExp(lineSeparator))){
            const values=line.split(RegExp(columnSeparator)).map(value=>Number.parseFloat(value))
            if(Number.isFinite(values[0])&&Number.isFinite(values[1])){
                pairs.push([values[0],values[1]])
            }
        }
        return pairs
    }
    updateLabel(fileName){
        const label=fileName||"Simple XY file"
        this.title=label
        this.events.label=label
        this.DOMelt.querySelector("#nodeTitle").textContent=label
        if(this.accordion){
            this.accordion.title=label
            this.accordion.DOMelt.handler.querySelector(".accordion.handler.label").textContent=label
        }
        this.fitWidthToTitle()
    }
    renderAccordion(){
        if(!this.accordion){
            return
        }
        this.accordion.DOMelt.content.replaceChildren()
        this.table?.dispose()
        this.table=null
        this.accordion.setSizingMode("content")
        if(this.status==="resolved"){
            this.accordion.setSizingMode("viewport",{height:360})
            const columnLabels=Wave.normalizeLabels(this.parameters.source.labels)
            this.parameters.source.labels=[...columnLabels]
            const resolvedContent=CE("div",{style:{
                display:"grid",
                "grid-template-rows":"minmax(0, 1fr) auto",
                "min-height":"0",
                height:"100%",
                overflow:"hidden"
            }},[])
            this.accordion.DOMelt.content.appendChild(resolvedContent)
            this.table=new Table(this.parameters.source.pairs,[...columnLabels],this.origin,resolvedContent,{mutable:{hRuler:true},onTitleChange:(labels)=>this.setColumnLabels(labels)})
            resolvedContent.appendChild(CE("button",{pilot:this,handleClick:e=>e.target.pilot.clear()},["Clear"]))
            return
        }
        const previewStyle={
            margin:"5px",
            borderRadius:"5px",
            border:"1px solid white",
            padding:"5px",
            minHeight:"0",
            overflow:"auto"
        }
        const rawPreview=CE("div",{style:previewStyle},["Raw preview"])
        const procPreview=CE("div",{style:previewStyle},["XY preview"])
        const updatePreview=()=>{
            rawPreview.textContent=this.parameters.source.raw.slice(0,500)
            procPreview.textContent=this.parameters.source.raw?JSON.stringify(this.parseRaw().slice(0,15)):"XY preview"
        }
        const readFile=file=>{
            if(!file){
                return
            }
            const reader=new FileReader()
            reader.onload=()=>{
                this.parameters.source.fileName=file.name
                this.updateLabel(file.name)
                this.parameters.source.raw=reader.result
                updatePreview()
            }
            reader.readAsText(file)
        }
        const dropzone=CE("div",{className:"dropzone"},["Drop a text file here"])
        dropzone.addEventListener("dragover",e=>{
            e.preventDefault()
            dropzone.classList.add("dragover")
        })
        dropzone.addEventListener("dragleave",()=>dropzone.classList.remove("dragover"))
        dropzone.addEventListener("drop",e=>{
            e.preventDefault()
            dropzone.classList.remove("dragover")
            readFile(e.dataTransfer.files[0])
        })
        const loader=CE("input",{type:"file",handleChange:e=>readFile(e.target.files[0])},["Select a text file"])
        const lineSeparator=CE("select",{value:this.parameters.source.lineSeparator,handleInput:e=>{
            this.parameters.source.lineSeparator=e.target.value
            updatePreview()
        }},[
            CE("option",{value:"\\r|\\n|\\r\\n"},["auto/guess"]),
            CE("option",{value:"\\r\\n"},["CRLF"]),
            CE("option",{value:"\\r"},["CR"]),
            CE("option",{value:"\\n"},["LF"])
        ])
        const columnSeparator=CE("select",{value:this.parameters.source.columnSeparator,handleInput:e=>{
            this.parameters.source.columnSeparator=e.target.value
            updatePreview()
        }},[
            CE("option",{value:"\\t|,|\\s"},["auto/guess"]),
            CE("option",{value:"\\t"},["tab"]),
            CE("option",{value:","},["comma"]),
            CE("option",{value:"\\s+"},["whitespace"])
        ])
        const validate=CE("button",{pilot:this,handleClick:async e=>{
            e.target.pilot.parameters.source.pairs=e.target.pilot.parseRaw()
            await e.target.pilot.startResolve()
            e.target.pilot.renderAccordion()
        }},["Load"])
        this.accordion.DOMelt.content.appendChild(CE("div",{style:{
            display:"grid",
            gap:"5px",
            minHeight:"0",
            height:"100%",
            overflow:"hidden",
            gridTemplateRows:"auto auto minmax(0, 1fr) auto auto"
        }},[
            dropzone,
            loader,
            CE("div",{style:{display:"grid",gridTemplateColumns:"1fr 1fr",minHeight:"0",overflow:"hidden"}},[rawPreview,procPreview]),
            CE("label",{},["Lines separator",lineSeparator]),
            CE("label",{},["Columns separator",columnSeparator]),
            validate
        ]))
        updatePreview()
    }
    suicide(options={}){
        this.table?.dispose()
        this.table=null
        super.suicide(options)
    }
}

/* classifier: a line through the origin, death = slope × birth. Superlevel
   pairs live strictly below the diagonal (death < birth), so the slope is
   clamped into [MIN, MAX], with MAX just below 1. */
const CLASSIFIER_MIN_SLOPE=1e-12
const CLASSIFIER_MAX_SLOPE=1-1e-6
function clampClassifierSlope(value){
    if(Number.isNaN(value)) return CLASSIFIER_MAX_SLOPE
    return Math.min(CLASSIFIER_MAX_SLOPE,Math.max(CLASSIFIER_MIN_SLOPE,value))
}
//6 significant digits: meaningful for slopes just below 1, unlike toFixed(3)
function formatSlope(value){
    return String(Number(Number(value).toPrecision(6)))
}
//slope of a line that keeps every pair with a positive birth (birth ≤ 0
//pairs can never sit under a line through the origin)
function keepAllSlope(pairs){
    let slope=CLASSIFIER_MIN_SLOPE
    for(const pair of pairs){
        if(!(pair.birth>0)) continue
        const ratio=pair.death/pair.birth
        if(Number.isFinite(ratio)&&ratio>slope) slope=ratio
    }
    return clampClassifierSlope(slope)
}
function keepAllSlopeFromFlat(births,deaths){
    let slope=CLASSIFIER_MIN_SLOPE
    for(let i=0;i<births.length;i++){
        if(!(births[i]>0)) continue
        const ratio=deaths[i]/births[i]
        if(Number.isFinite(ratio)&&ratio>slope) slope=ratio
    }
    return clampClassifierSlope(slope)
}
//Liang-Barsky: the segment of an infinite line inside the rect, or null
function clipSegmentToRect(x0,y0,x1,y1,width,height){
    let t0=0
    let t1=1
    const dx=x1-x0
    const dy=y1-y0
    const p=[-dx,dx,-dy,dy]
    const q=[x0,width-x0,y0,height-y0]
    for(let i=0;i<4;i++){
        if(p[i]===0){
            if(q[i]<0) return null
            continue
        }
        const r=q[i]/p[i]
        if(p[i]<0){
            if(r>t1) return null
            if(r>t0) t0=r
        }else{
            if(r<t0) return null
            if(r<t1) t1=r
        }
    }
    return [x0+t0*dx,y0+t0*dy,x0+t1*dx,y0+t1*dy]
}

class PersistentHomology0DNode extends NodeWithAccordion{
    constructor(title,origin,destinationFlow,position={x:180,y:10}){
        super(
            title,
            [[]],  // 1 input: 1D or 2D wave
            [[]],  // 1 output: filtered original points
            origin,
            destinationFlow,
            position
        )
        this.status="floating"
        //classifier: a line through the origin, death = slope × birth; null
        //until the first data (then fitted to keep every pair) or a click
        this.parameters.slope=null
        this.parameters.slopeAnchorBirth=null // where the marker sits on the line
        this.parameters.filtrationMode="superlevel" // "sublevel" or "superlevel"
        this.parameters.logLogAxes=false
        this.pairsData=null
        this.lastInputWave=null
        this.dragDebounceTimer=null
        this.graph=null

        // Tooltips on SVG anchors for clarity
        const inputAnchors=this.DOMelt.querySelectorAll('.input.anchor')
        if(inputAnchors[0]) inputAnchors[0].innerHTML='<title>Input: one Wave (XY or 1D)</title>'
        const outputAnchors=this.DOMelt.querySelectorAll('.output.anchor')
        if(outputAnchors[0]) outputAnchors[0].innerHTML='<title>Output: Filtered original points</title>'
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
            "grid-template-rows": "auto minmax(0, 1fr)",
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

        // 1. Controls bar
        const controls = CE("div", {
            style: {
                display: "grid",
                gridTemplateColumns: "auto 1fr auto auto auto",
                alignItems: "center",
                gap: "4px",
                fontSize: "0.85em",
                padding: "2px 4px",
                borderRadius: "4px",
                background: "rgba(255,255,255,0.05)"
            }
        }, [])

        const slopeLabel = CE("span", { style: { fontWeight: "bold" } }, ["Slope:"])
        this.slopeInput = CE("input", {
            type: "number",
            step: "any",
            value: Number.isFinite(this.parameters.slope) ? formatSlope(this.parameters.slope) : "",
            placeholder: "auto",
            title: "Classifier slope (< 1): pairs under death = slope × birth are kept",
            style: { width: "100%", padding: "2px" }
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
        guessBtn.addEventListener("click", () => {
            const slope = this.guessSlope()
            if(slope !== null){
                this.setSlope(slope, true)
            }
        })

        this.logLogBtn = CE("button", {
            type: "button",
            title: "Toggle logarithmic axes (log-log)",
            style: { cursor: "pointer", padding: "2px 6px" }
        }, [this.parameters.logLogAxes ? "Log–log" : "Linear"])
        this.logLogBtn.addEventListener("click", () => {
            this.parameters.logLogAxes = !this.parameters.logLogAxes
            const scale = this.parameters.logLogAxes ? "log" : "linear"
            this.graph.parameters.axis.bottom.scale = scale
            this.graph.parameters.axis.left.scale = scale
            this.graph.parameters.axis.bottom.autoDomain = true
            this.graph.parameters.axis.left.autoDomain = true
            this.logLogBtn.textContent = this.parameters.logLogAxes ? "Log" : "Linear"
            this.graph.drawGraph()
        })

        this.countLabel = CE("span", {
            style: { opacity: "0.8", whiteSpace: "nowrap", justifySelf: "end" }
        }, ["0 pairs"])

        controls.append(slopeLabel, this.slopeInput, guessBtn, this.logLogBtn, this.countLabel)

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

        content.append(controls, graphContainer)

        // 3. Plot2DWebGL instance
        this.graph = new Plot2DWebGL([], `${this.title} graph`, this.origin, graphContainer)
        this.graph.parameters.axis.bottom.label = "Birth"
        this.graph.parameters.axis.bottom.autoLabel = false
        this.graph.parameters.axis.left.label = "Death"
        this.graph.parameters.axis.left.autoLabel = false

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

    extractInputWave(){
        const input = this.inputs[0]
        if(!(input instanceof Map)) return null
        for(const values of input.values()){
            for(const waves of values){
                if(Array.isArray(waves)){
                    for(const wave of waves){
                        if(wave instanceof Wave) return wave
                    }
                }else if(waves instanceof Wave){
                    return waves
                }
            }
        }
        return null
    }

    //slope of the line through the origin and the centroid of the pairs —
    //a neutral split of the cloud (the old guess placed a threshold at mean(Y))
    guessSlope(){
        const births=this.persistenceBirths
        const deaths=this.persistenceDeaths
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
        return this.destination?.linkList?.filter(link=>link.inputNode===this)??[]
    }

    fail(message){
        this.status="error"
        this.outputs[0]=[]
        this.persistenceBirths=null
        this.persistenceDeaths=null
        this.persistencePointsX=null
        this.persistencePointsY=null
        console.error(`[PersistentHomology0DNode] ${message}`)
        this.graph?.setTraces([])
        this.graph?.drawGraph()
    }

    async startResolve(){
        const links=this.incomingLinks()
        if(links.length>1 || links.some(link=>link.inputAnchor.id!=="0")){
            this.fail("exactly one link on input 0 is required")
            return
        }
        const inputWave = this.extractInputWave()
        if(!inputWave){
            this.status = "floating"
            this.outputs[0] = []
            return
        }
        this.status = "pending"
        this.lastInputWave = inputWave

        const stride=inputWave.degree===2&&inputWave.dims[1]===2?2:1

        try{
            const analysis=await computePool.run("persistentHomology0D", {
                core: inputWave.core,
                params: { mode: this.parameters.filtrationMode ?? "sublevel", stride }
            })
            this.persistenceBirths=analysis.births
            this.persistenceDeaths=analysis.deaths
            this.persistencePointsX=analysis.pointsX
            this.persistencePointsY=analysis.pointsY
            this.persistenceBirthIndices=analysis.birthIndices
            this.pairsData={count:this.persistenceBirths.length}
            if(!Number.isFinite(this.parameters.slope) && Number.isFinite(analysis.slope)){
                this.parameters.slope=analysis.slope
            }
            this.status="resolved"
            await this.applySlopeFilter()
            this.updateControlsUI()
        }catch(err){
            console.error("[PersistentHomology0DNode] Error resolving:", err)
            this.status = "error"
        }
    }

    async applySlopeFilter(){
        if(!this.persistenceBirths) return
        const slope=Number.isFinite(this.parameters.slope)?this.parameters.slope:0
        const classification=await computePool.run("classifyPersistence0D",{
            births:this.persistenceBirths,
            deaths:this.persistenceDeaths,
            pointsX:this.persistencePointsX,
            pointsY:this.persistencePointsY,
            params:{slope}
        })
        const pairCount=this.persistenceBirths.length
        this.outputs[0]=classification.keptPointsX.length
            ?[Wave.fromCoordinates(classification.keptPointsX,classification.keptPointsY,{title:`${this.title} (Points)`,slope})]
            :[]

        if(this.graph){
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
        if(this.countLabel) this.countLabel.textContent=`${classification.keptCount}/${pairCount} pairs`
    }

    updateControlsUI(){
        if(this.slopeInput && Number.isFinite(this.parameters.slope)){
            this.slopeInput.value = formatSlope(this.parameters.slope)
        }
        if(this.countLabel && this.pairsData){
            const keptCount = this.outputs[0]?.[0]?.dims?.[0] ?? 0
            this.countLabel.textContent = `${keptCount}/${this.pairsData.count} pairs`
        }
    }

    //the classifier: a dashed line through the origin (death = slope × birth)
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
                .text("Classifier — click on the graph to place it: every pair under the line is kept")
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

        const slope = this.parameters.slope
        if(!Number.isFinite(slope)){
            group.style("display", "none")
            return
        }
        group.style("display", null)

        const zone = this.graph.graphzone
        const { xScale, yScale } = this.graph.plotScales()

        //the line death = slope × birth sampled across the whole visible
        //x-range, so the segment always spans the graph zone and the clip
        //only trims its ends (a birth 1→10 sample used to cut it at 10)
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
    //and the clicked point, so its slope is death/birth — clamped above 1
    //since every pair lives strictly above the diagonal death = birth
    handleClassifierClick(event){
        if(!this.graph) return
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

    async resolveChildren(){
        const flow = this.destination
        if(!flow) return
        const descendants = new Set()
        const collectDescendants = (n) => {
            const children = flow.childrenMap(n)
            for(const child of children.keys()){
                if(!descendants.has(child)){
                    descendants.add(child)
                    collectDescendants(child)
                }
            }
        }
        collectDescendants(this)
        if(descendants.size === 0) return

        for(const desc of descendants){
            flow.forwardStatus(desc, "floating")
        }

        const subLeaves = Array.from(descendants).filter(d => {
            const kids = Array.from(flow.childrenMap(d).keys())
            return kids.length === 0 || kids.every(k => !descendants.has(k))
        })

        const resolutions = new Map()
        resolutions.set(this, Promise.resolve())
        await Promise.all(subLeaves.map(leaf => flow.resolveNode(leaf, resolutions)))
    }

    serializeState(){
        return {
            slope: this.parameters.slope,
            slopeAnchorBirth: this.parameters.slopeAnchorBirth,
            filtrationMode: this.parameters.filtrationMode,
            status: this.status
        }
    }

    restoreState(state){
        if(!state) return
        if(Number.isFinite(state.slope)) this.parameters.slope = state.slope
        if(Number.isFinite(state.slopeAnchorBirth)) this.parameters.slopeAnchorBirth = state.slopeAnchorBirth
        if(state.filtrationMode !== undefined) this.parameters.filtrationMode = state.filtrationMode
        this.status = state.status ?? "floating"
        this.updateControlsUI()
    }

    suicide(options={}){
        this.graph?.dispose?.()
        this.accordion?.suicide()
        super.suicide(options)
    }
}

class NodeWithAccordionGraph extends Node{
    registered(e){
        const {channel, registrationName, label, caster} = e.detail.msg
        if(caster !== this || this.accordion){
            return
        }
        this.accordion=new Accordion(
            label,
            this.origin,
            this.origin.main.querySelector(".vertical.left.content")
        )
        channel.register(`${registrationName}:accordion`,this.accordion,label)
        this.graphDialog=new Dialog(`${label} graph`,this.origin,this.origin.midCentralContent)
        const dismisser=this.graphDialog.DOMelt.dismisser
        delete dismisser.handleClick
        dismisser.classList.add("disabled")
        dismisser.setAttribute("aria-disabled","true")
        stylize(this.graphDialog.DOMelt.window,{
            top:"0px",
            left:"0px",
            width:"100%",
            height:"100%"
        })
        channel.register(`${registrationName}:graph`,this.graphDialog,`${label} graph`)
        this.graph=new Plot2DWebGL([],
            `${label} graph`,
            this.origin,
            this.graphDialog.DOMelt.content
        )
    }
    serializeState(){
        if(!this.graph){
            return null
        }
        return {
            axes:DC(this.graph.parameters.axis),
            traces:this.graph.traces.map(trace=>({
                id:trace.id,
                title:trace.title,
                options:DC(trace.options)
            }))
        }
    }
    restoreState(state){
        if(!state||!this.graph){
            return
        }
        if(state.axes&&typeof state.axes==="object"){
            this.graph.parameters.axis=DC(state.axes)
            for(const axis of Object.values(this.graph.parameters.axis)){
                if(axis&&typeof axis==="object"){
                    //drawn is a runtime flag: the fresh Plot2D has to redraw its axes
                    axis.drawn=false
                }
            }
        }
        if(Array.isArray(state.traces)){
            this.traceOptions=state.traces
        }
    }
    restoreAfterImport(){
        this.graph?.drawGraph()
    }
    suicide(options={}){
        //the WebGL context and the GPU buffers are released with the dialog
        this.graph?.dispose?.()
        this.graphDialog?.suicide()
        this.accordion?.suicide()
        super.suicide(options)
    }
}

class NodeWithRightAccordionGraph extends Node{
    constructor(title,inputs,outputs,origin,destinationFlow,position={x:180,y:10}){
        super(title,inputs,outputs,origin,destinationFlow,position)
    }
    registered(e){
        const {channel, registrationName, label, caster} = e.detail.msg
        if(caster !== this || this.accordion){
            return
        }
        this.accordion=new Accordion(
            label,
            this.origin,
            this.origin.main.querySelector(".vertical.right.content")
        )
        channel.register(`${registrationName}:accordion`,this.accordion,label)
        this.graphDialog=new Dialog(`${label} graph`,this.origin,this.origin.midCentralContent)
        const dismisser=this.graphDialog.DOMelt.dismisser
        delete dismisser.handleClick
        dismisser.classList.add("disabled")
        dismisser.setAttribute("aria-disabled","true")
        stylize(this.graphDialog.DOMelt.window,{
            top:"0px",
            left:"0px",
            width:"100%",
            height:"100%"
        })
        channel.register(`${registrationName}:graph`,this.graphDialog,`${label} graph`)
        this.graph=new Plot2DWebGL([],`${label} graph`,this.origin,this.graphDialog.DOMelt.content)
    }
    serializeState(){
        if(!this.graph){
            return null
        }
        return {
            axes:DC(this.graph.parameters.axis),
            traces:this.graph.traces.map(trace=>({
                id:trace.id,
                title:trace.title,
                options:DC(trace.options)
            }))
        }
    }
    restoreState(state){
        if(!state||!this.graph){
            return
        }
        if(state.axes&&typeof state.axes==="object"){
            this.graph.parameters.axis=DC(state.axes)
            for(const axis of Object.values(this.graph.parameters.axis)){
                if(axis&&typeof axis==="object"){
                    //drawn is a runtime flag: the fresh Plot2D has to redraw its axes
                    axis.drawn=false
                }
            }
        }
        if(Array.isArray(state.traces)){
            this.traceOptions=state.traces
        }
    }
    restoreAfterImport(){
        this.graph?.drawGraph()
    }
    suicide(options={}){
        //the WebGL context and the GPU buffers are released with the dialog
        this.graph?.dispose?.()
        this.graphDialog?.suicide()
        this.accordion?.suicide()
        super.suicide(options)
    }
}

class SimpleXYPlotNode extends NodeWithRightAccordionGraph{
    constructor(title,inputs,outputs,origin,destinationFlow,position={x:180,y:10}){
        super(title,inputs,outputs,origin,destinationFlow,position)
    }
    registered(e){
        if(e.detail.msg.caster !== this || this.logScaleCheckbox){
            return
        }
        super.registered(e)
        this.logScaleCheckbox=true
        this.renderInspector()
    }
    setLogarithmicScale(enabled){
        const scale=enabled?"log":"linear"
        this.graph.parameters.axis.bottom.scale=scale
        this.graph.parameters.axis.left.scale=scale
        this.graph.drawGraph()
    }
    renderInspector(){
        if(!this.accordion) return
        const root=this.accordion.DOMelt.content
        root.style.display="block"
        root.style.minWidth="0"
        root.style.overflow="auto"
        this.graph.ensureAxes?.()
        //the sections are rebuilt on every refresh, so their collapsed state has to survive the wipe
        this.inspectorSections={}
        root.querySelectorAll(":scope > details").forEach(details=>{
            const title=details.querySelector(":scope > summary")?.textContent
            if(title) this.inspectorSections[title]=details.open
        })
        root.replaceChildren()
        const section=(title,open=true)=>{
            const details=document.createElement("details")
            details.open=this.inspectorSections?.[title]??open
            details.style.minWidth="0"
            const summary=document.createElement("summary")
            summary.textContent=title
            details.append(summary)
            root.append(details)
            return details
        }
        const tracesSection=section("Traces")
        const traceList=document.createElement("div")
        traceList.style.display="grid"
        traceList.style.gap="3px"
        tracesSection.append(traceList)
        const selectTrace=trace=>{
            this.selectedTraceId=(this.selectedTraceId===trace.id)?null:trace.id
            this.renderInspector()
        }
        for(const trace of this.graph.traces){
            if(!trace.options.marker||typeof trace.options.marker!=="object"){
                trace.options.marker={shape:"circle",size:4}
            }
            const traceGroup=document.createElement("div")
            traceGroup.className="trace-group"
            const item=document.createElement("div")
            item.className="trace-item"
            item.style.display="grid"
            item.style.gridTemplateColumns="auto minmax(0,1fr) auto"
            item.style.gap="4px"
            item.style.alignItems="center"
            item.draggable=true
            if(trace.id===this.selectedTraceId){
                item.classList.add("selected")
            }
            const swatchWrap=document.createElement("label")
            swatchWrap.title="Trace color"
            swatchWrap.style.width="1.2em"
            swatchWrap.style.height="1.2em"
            swatchWrap.style.borderRadius="4px"
            swatchWrap.style.cursor="pointer"
            swatchWrap.style.border=`2px solid ${trace.options.color}`
            swatchWrap.style.background=trace.options.color
            swatchWrap.style.opacity=trace.options.hidden?"0.35":"1"
            swatchWrap.style.overflow="hidden"
            const swatch=document.createElement("input")
            swatch.type="color"; swatch.value=trace.options.color
            swatch.title="Trace color"
            swatch.style.width="1px"; swatch.style.height="1px"
            swatch.style.opacity="0"; swatch.style.border="none"; swatch.style.padding="0"
            swatch.addEventListener("input",()=>{trace.options.color=swatch.value;this.graph.drawGraph();this.renderInspector()})
            swatchWrap.append(swatch)
            const nameBtn=document.createElement("button")
            nameBtn.type="button"
            nameBtn.title=`${trace.title} (${trace.pointCount} points)`
            nameBtn.style.display="flex"
            nameBtn.style.alignItems="center"
            nameBtn.style.gap="4px"
            //min-width:0 lets the 1fr grid track shrink instead of being widened
            //by a long trace name; the name is truncated with an ellipsis and the
            //full name stays available through the tooltip
            nameBtn.style.minWidth="0"
            nameBtn.style.overflow="hidden"
            nameBtn.style.textAlign="left"
            nameBtn.style.opacity=trace.options.hidden?"0.45":"1"
            const nameSpan=document.createElement("span")
            nameSpan.textContent=trace.title
            nameSpan.title=trace.title
            nameSpan.style.minWidth="0"
            nameSpan.style.overflow="hidden"
            nameSpan.style.textOverflow="ellipsis"
            nameSpan.style.whiteSpace="nowrap"
            const countSpan=document.createElement("span")
            countSpan.textContent=`(${trace.pointCount} points)`
            countSpan.style.flexShrink="0"
            countSpan.style.whiteSpace="nowrap"
            nameBtn.append(nameSpan,countSpan)
            nameBtn.addEventListener("click",()=>selectTrace(trace))
            const eye=document.createElement("button")
            eye.type="button"
            eye.title=trace.options.hidden?"Show trace":"Hide trace"
            eye.textContent=trace.options.hidden?"🚫":"👁"
            eye.style.width="1.8em"
            eye.addEventListener("click",(event)=>{
                event.stopPropagation()
                trace.options.hidden=!trace.options.hidden
                this.graph.drawGraph()
                this.renderInspector()
            })
            item.append(swatchWrap,nameBtn,eye)
            item.addEventListener("dragstart",event=>event.dataTransfer.setData("text/plain",trace.id))
            item.addEventListener("dragover",event=>event.preventDefault())
            item.addEventListener("drop",event=>{
                event.preventDefault()
                const from=this.graph.traces.findIndex(candidate=>candidate.id===event.dataTransfer.getData("text/plain"))
                const to=this.graph.traces.indexOf(trace)
                if(from>=0&&to>=0&&from!==to){
                    const [moved]=this.graph.traces.splice(from,1)
                    this.graph.traces.splice(to,0,moved)
                    this.graph.drawGraph()
                    this.renderInspector()
                }
            })
            traceGroup.append(item)
            traceList.append(traceGroup)
        }
        const trace=this.graph.traces.find(candidate=>candidate.id===this.selectedTraceId)
        if(trace){
            if(!trace.options.marker||typeof trace.options.marker!=="object"){
                trace.options.marker={shape:"circle",size:4}
            }
            const editor=document.createElement("div")
            editor.className="trace-editor"
            editor.style.display="grid"
            editor.style.gap="4px"
            editor.style.padding="4px"
            editor.style.border="1px solid rgba(255,255,255,0.35)"
            editor.style.borderRadius="5px"
            const control=(label,element)=>{
                const row=document.createElement("label")
                row.style.display="grid"
                row.style.gridTemplateColumns="1fr 1fr"
                row.style.gap="4px"
                row.style.alignItems="center"
                row.style.fontSize="0.85em"
                row.textContent=label
                row.append(element)
                editor.append(row)
            }
            const colorMini=document.createElement("input")
            colorMini.type="color"; colorMini.value=trace.options.color
            colorMini.style.width="1.2em"; colorMini.style.height="1.2em"
            colorMini.style.padding="0"; colorMini.style.border="none"
            colorMini.style.justifySelf="end"
            colorMini.addEventListener("input",()=>{trace.options.color=colorMini.value;this.graph.drawGraph();this.renderInspector()})
            control("Color",colorMini)
            const mode=document.createElement("select")
            for(const [value,text] of [["lines-between-points","Lines between points"],["lines-and-points","Lines + points"],["points","Points only"],["sticks-to-zero","Sticks to zero"]]){
                const option=new Option(text,value); option.selected=trace.options.mode===value; mode.add(option)
            }
            mode.addEventListener("change",()=>{trace.options.mode=mode.value;this.graph.drawGraph()})
            control("Mode",mode)
            const layer=document.createElement("select")
            for(const [value,text] of [["gl","Canvas (WebGL)"],["svg","SVG (D3)"]]){const option=new Option(text,value);option.selected=(trace.options.layer??"gl")===value;layer.add(option)}
            layer.title="Canvas: massive clouds, SVG: interactive traces"
            layer.addEventListener("change",()=>{trace.options.layer=layer.value;this.graph.drawGraph()})
            control("Layer",layer)
            const markerShape=document.createElement("select")
            for(const [value,text] of [["circle","Circle"],["square","Square"],["diamond","Diamond"],["triangle-up","Triangle up"],["triangle-down","Triangle down"],["cross","Cross"],["plus","Plus"]]){
                const option=new Option(text,value); option.selected=(trace.options.marker.shape??"circle")===value; markerShape.add(option)
            }
            markerShape.addEventListener("change",()=>{trace.options.marker.shape=markerShape.value;this.graph.drawGraph()})
            control("Marker",markerShape)
            const markerSize=document.createElement("input")
            markerSize.type="number"; markerSize.min="1"; markerSize.max="20"; markerSize.step="0.5"; markerSize.value=trace.options.marker.size??4
            markerSize.style.width="100%"
            markerSize.addEventListener("input",()=>{trace.options.marker.size=Number(markerSize.value);this.graph.drawGraph()})
            control("Marker size",markerSize)
            const size=document.createElement("input")
            size.type="number"; size.min="0"; size.step="0.5"; size.value=trace.options.line.size
            size.style.width="100%"
            size.addEventListener("input",()=>{trace.options.line.size=Number(size.value);this.graph.drawGraph()})
            control("Line size",size)
            const selectedGroup=traceList.querySelector(`.trace-group:has(.trace-item.selected)`)
            if(selectedGroup) selectedGroup.append(editor)
        }
        const axesSection=section("Axes",false)
        //one registry per render, so a re-rendered inspector never stacks
        //listeners and always refreshes the blocks it actually owns
        //detach FIRST: it clears axisBlocks, so creating the registry before
        //it would hand back a null Map and silently register nothing
        this.detachAxisSync?.()
        this.axisBlocks=new Map()
        this.onPlotViewChanged=()=>{
            //two guards: a re-entrancy one, and one so that rebuilding the
            //widgets can never fight with a slider the user is dragging
            if(this.syncingAxisBlocks||this.axisInteraction) return
            this.syncingAxisBlocks=true
            try{
                for(const [axisKey,block] of this.axisBlocks??[]){
                    const axis=this.graph.parameters.axis[axisKey]
                    if(!axis||axis.mirror) continue
                    this.refreshAxisBlock(block,axis)
                }
            }finally{
                this.syncingAxisBlocks=false
            }
        }
        this.detachAxisSync=()=>{
            this.graph.onViewChange=null
            this.axisBlocks=null
        }
        this.graph.onViewChange=this.onPlotViewChanged
        for(const [key,axis] of Object.entries(this.graph.parameters.axis)){
            const pretty=this.axisDisplayName(key)
            if(axis.mirror){
                this.renderMirrorAxisInspector(axesSection,key,pretty,axis)
            }else{
                this.renderAxisInspector(axesSection,key,pretty,axis)
            }
        }
    }
    axisDisplayName(key){
        const axisNames={bottom:"X (bottom)",left:"Y (left)",top:"X (top)",right:"Y (right)"}
        return axisNames[key]??key
    }
    axisShowToggle(axis,title,onChange){
        const toggle=document.createElement("input")
        toggle.type="checkbox"
        toggle.checked=axis.enabled??true
        toggle.title=title
        toggle.addEventListener("change",()=>{
            axis.enabled=toggle.checked
            this.graph.drawGraph()
            onChange?.()
        })
        return toggle
    }
    renderAxisInspector(section,key,pretty,axis){
        const block=document.createElement("div")
        block.dataset.axis=key
        section.append(block)
        this.axisBlocks?.set(key,block)
        const row=document.createElement("div")
        row.style.display="grid"; row.style.gridTemplateColumns="auto auto minmax(0,1fr)"; row.style.gap="4px"; row.style.alignItems="center"
        const name=document.createElement("strong"); name.textContent=`${pretty}:`
        name.style.opacity=(axis.enabled??true)?"1":"0.45"
        const label=document.createElement("input"); label.value=axis.label??""
        label.style.width="100%"
        label.addEventListener("input",()=>{axis.label=label.value;axis.autoLabel=false;this.graph.drawGraph()})
        row.append(this.axisShowToggle(axis,"Show this axis",()=>{name.style.opacity=(axis.enabled??true)?"1":"0.45"}),name,label); block.append(row)
        const scaleRow=document.createElement("div")
        scaleRow.style.display="grid"; scaleRow.style.gridTemplateColumns="auto minmax(0,1fr) auto"; scaleRow.style.gap="4px"; scaleRow.style.alignItems="center"
        const scaleLabel=document.createElement("span"); scaleLabel.textContent="Scale"; scaleLabel.style.fontSize="0.85em"
        const scale=document.createElement("select")
        for(const value of ["linear","log"]){const option=new Option(value,value);option.selected=axis.scale===value;scale.add(option)}
        scale.addEventListener("change",()=>{axis.scale=scale.value;axis.autoDomain=true;this.graph.drawGraph();this.refreshAxisBlock(block,axis)})
        const autoBtn=document.createElement("button")
        autoBtn.type="button"; autoBtn.textContent="Auto"; autoBtn.title="Automatic bounds"
        autoBtn.style.opacity=(axis.autoDomain??true)?"1":"0.45"
        autoBtn.addEventListener("click",()=>{axis.autoDomain=true;this.graph.drawGraph();this.refreshAxisBlock(block,axis)})
        scaleRow.append(scaleLabel,scale,autoBtn); block.append(scaleRow)
        this.buildDualSlider(block,axis,autoBtn)
    }
    renderMirrorAxisInspector(section,key,pretty,axis){
        const block=document.createElement("div")
        block.dataset.axis=key
        section.append(block)
        const row=document.createElement("div")
        row.style.display="grid"; row.style.gridTemplateColumns="auto auto minmax(0,1fr)"; row.style.gap="4px"; row.style.alignItems="center"
        const name=document.createElement("strong"); name.textContent=`${pretty}:`
        const body=document.createElement("div")
        const refreshBody=()=>{
            const enabled=axis.enabled??true
            name.style.opacity=enabled?"1":"0.45"
            body.replaceChildren()
            if(!enabled){
                const hidden=document.createElement("div")
                hidden.textContent="Hidden"
                hidden.style.fontSize="0.85em"; hidden.style.opacity="0.6"
                body.append(hidden)
                return
            }
            const source=this.graph.axisMirrorOf(key)
            const labelRow=document.createElement("div")
            labelRow.style.display="grid"; labelRow.style.gridTemplateColumns="auto minmax(0,1fr)"; labelRow.style.gap="4px"; labelRow.style.alignItems="center"; labelRow.style.minWidth="0"
            const labelName=document.createElement("span"); labelName.textContent="Label"; labelName.style.fontSize="0.85em"
            const label=document.createElement("input")
            label.value=axis.label??""
            label.placeholder=source?.label??""
            label.style.width="100%"
            label.addEventListener("input",()=>{axis.label=label.value;this.graph.drawGraph()})
            labelRow.append(labelName,label)
            const note=document.createElement("div")
            note.textContent=`Scale and range follow ${this.axisDisplayName(axis.mirror)}.`
            note.style.fontSize="0.8em"; note.style.opacity="0.7"
            body.append(labelRow,note)
        }
        row.append(this.axisShowToggle(axis,"Show this axis",refreshBody),name)
        block.append(row,body)
        refreshBody()
    }
    axisSliderRange(axis){
        const bounds=this.graph.dataBounds()
        const isX=(axis.orientation==="horizontal")
        const dataMin=isX?bounds?.xMin:bounds?.yMin
        const dataMax=isX?bounds?.xMax:bounds?.yMax
        const currentMin=axis.domain?.[0]
        const currentMax=axis.domain?.[1]
        //The track must always CONTAIN the current view, otherwise a window
        //zoomed past the data extents gets clamped back to it by the input
        //min/max and the thumbs silently lie about the plotted domain. The
        //data extent is the preferred reference, the live domain only widens
        //it (this is the "zoomed before any data" case: bounds are null, so
        //the view itself is the only reference available).
        const candidates=[dataMin,dataMax,currentMin,currentMax]
            .filter(value=>Number.isFinite(value))
        if(candidates.length<2) return {paddedMin:0,paddedMax:1,step:0.005,initMin:0,initMax:1}
        const refMin=Math.min(...candidates)
        const refMax=Math.max(...candidates)
        const span=(refMax-refMin)||1
        //the step keeps following the DATA extent, not the widened track: a
        //track grown by a large zoom-out would otherwise coarsen the slider
        //granularity for the rest of the session
        const dataSpan=(Number.isFinite(dataMin)&&Number.isFinite(dataMax)&&dataMax>dataMin)
            ?(dataMax-dataMin)
            :span
        return {
            paddedMin:refMin-0.1*span,
            paddedMax:refMax+0.1*span,
            step:(dataSpan||1)/200,
            initMin:Number.isFinite(currentMin)?currentMin:(refMin-0.1*span),
            initMax:Number.isFinite(currentMax)?currentMax:(refMax+0.1*span)
        }
    }
    buildDualSlider(block,axis,autoBtn){
        const {paddedMin,paddedMax,step,initMin,initMax}=this.axisSliderRange(axis)
        this.renderDualSlider(block,axis,autoBtn,paddedMin,paddedMax,step,initMin,initMax)
    }
    refreshAxisBlock(block,axis){
        const autoBtn=block.querySelector("button[title='Automatic bounds']")
        if(autoBtn) autoBtn.style.opacity=(axis.autoDomain??true)?"1":"0.45"
        block.querySelectorAll(":scope > div[data-range]").forEach(elt=>elt.remove())
        this.buildDualSlider(block,axis,autoBtn)
    }
    renderDualSlider(block,axis,autoBtn,paddedMin,paddedMax,step,initMin,initMax){
        const rangeRow=document.createElement("div")
        rangeRow.dataset.range="1"
        rangeRow.style.display="grid"; rangeRow.style.gridTemplateColumns="auto minmax(0,1fr)"; rangeRow.style.gap="4px"; rangeRow.style.alignItems="center"
        const rangeLabel=document.createElement("span"); rangeLabel.textContent="Range"; rangeLabel.style.fontSize="0.85em"
        const sliders=document.createElement("div")
        sliders.style.position="relative"; sliders.style.height="1.6em"; sliders.style.minWidth="0"; sliders.style.overflow="hidden"
        const track=document.createElement("div")
        track.style.position="absolute"; track.style.left="0"; track.style.right="0"; track.style.top="50%"
        track.style.height="4px"; track.style.transform="translateY(-50%)"
        track.style.borderRadius="2px"; track.style.background="rgba(255,255,255,0.25)"
        const fill=document.createElement("div")
        fill.style.position="absolute"; fill.style.top="50%"; fill.style.height="4px"; fill.style.transform="translateY(-50%)"
        fill.style.borderRadius="2px"; fill.style.background="#3498db"; fill.style.pointerEvents="none"
        const lo=document.createElement("input")
        lo.type="range"; lo.min=String(paddedMin); lo.max=String(paddedMax); lo.step=String(step); lo.value=String(initMin)
        const hi=document.createElement("input")
        hi.type="range"; hi.min=String(paddedMin); hi.max=String(paddedMax); hi.step=String(step); hi.value=String(initMax)
        lo.classList.add("dual"); hi.classList.add("dual")
        for(const thumb of [lo,hi]){
            thumb.style.position="absolute"; thumb.style.inset="0"; thumb.style.width="100%"
            thumb.style.background="transparent"; thumb.style.pointerEvents="none"
        }
        const paint=()=>{
            const a=Number(lo.value)
            const b=Number(hi.value)
            const loPct=((Math.min(a,b)-paddedMin)/(paddedMax-paddedMin))*100
            const hiPct=((Math.max(a,b)-paddedMin)/(paddedMax-paddedMin))*100
            fill.style.left=`${loPct}%`
            fill.style.width=`${Math.max(0,hiPct-loPct)}%`
            lo.style.zIndex=(a<=b)?"3":"2"
            hi.style.zIndex=(a<=b)?"2":"3"
        }
        const inputsRow=document.createElement("div")
        inputsRow.style.display="grid"; inputsRow.style.gridTemplateColumns="minmax(0,1fr) minmax(0,1fr)"; inputsRow.style.gap="4px"; inputsRow.style.minWidth="0"
        inputsRow.style.gridColumn="1 / -1"
        const loNum=document.createElement("input")
        loNum.type="number"; loNum.step="any"; loNum.value=String(initMin)
        loNum.style.width="100%"; loNum.title="Lower bound"
        const hiNum=document.createElement("input")
        hiNum.type="number"; hiNum.step="any"; hiNum.value=String(initMax)
        hiNum.style.width="100%"; hiNum.title="Upper bound"
        inputsRow.append(loNum,hiNum)
        const parseOk=(value)=>{
            //a number field holds intermediate states while typing ("", "-",
            //"1e"...) which must never be coerced into a bound
            return value!==""&&value!=="-"&&Number.isFinite(Number(value))
        }
        const apply=(a,b,from)=>{
            a=Number(a); b=Number(b)
            if(!Number.isFinite(a)||!Number.isFinite(b)) return
            if(a===b) return
            if(a>b) [a,b]=[b,a]
            if(axis.scale==="log"&&(a<=0||b<=0)) return
            //the rebuild triggered by the redraw must not fight this gesture
            this.axisInteraction=true
            try{
                const loBound=Number(lo.min)
                const hiBound=Number(lo.max)
                a=Math.min(Math.max(a,loBound),hiBound)
                b=Math.min(Math.max(b,loBound),hiBound)
                if(a===b) return
                axis.domain=[a,b]
                axis.autoDomain=false
                this.graph.drawGraph()
                lo.value=String(a); hi.value=String(b)
                if(from!=="numbers"){
                    //the number fields are only rewritten when the change comes from
                    //the sliders: rewriting them from their own typing would clobber
                    //an in-progress value (and made negative numbers impossible)
                    loNum.value=String(a); hiNum.value=String(b)
                }
                paint()
                autoBtn.style.opacity="0.45"
            }finally{
                //a single early return must never leave the guard stuck
                this.axisInteraction=false
            }
        }
        const commitNumbers=()=>{
            if(!parseOk(loNum.value)||!parseOk(hiNum.value)) return
            apply(loNum.value,hiNum.value,"numbers")
            //reflect the clamped domain back into the fields on commit
            loNum.value=String(axis.domain[0]); hiNum.value=String(axis.domain[1])
        }
        lo.addEventListener("input",()=>apply(lo.value,hi.value,"sliders"))
        hi.addEventListener("input",()=>apply(lo.value,hi.value,"sliders"))
        loNum.addEventListener("input",()=>{
            if(!parseOk(loNum.value)||!parseOk(hiNum.value)) return
            apply(loNum.value,hiNum.value,"numbers")
        })
        hiNum.addEventListener("input",()=>{
            if(!parseOk(loNum.value)||!parseOk(hiNum.value)) return
            apply(loNum.value,hiNum.value,"numbers")
        })
        loNum.addEventListener("change",commitNumbers)
        hiNum.addEventListener("change",commitNumbers)
        sliders.append(track,fill,lo,hi)
        rangeRow.append(rangeLabel,sliders,inputsRow); block.append(rangeRow)
        paint()
    }
    collectTraces(){
        const traces=[]
        const colors=["#e74c3c","#3498db","#2ecc71","#f39c12","#9b59b6","#1abc9c"]
        for(const input of this.inputs){
            for(const [parent,values] of input){
                for(const waves of values){
                    if(!Array.isArray(waves)) continue
                    for(const wave of waves){
                        if(wave instanceof Wave){
                            const traceIndex=traces.length
                            traces.push(new XYTrace({
                                id:`${parent.events?.registrationId??parent.title}:${traceIndex}`,
                                title:wave.metadata.title??parent.title,
                                wave,
                                options:{color:colors[traceIndex%colors.length]}
                            }))
                        }
                    }
                }
            }
        }
        return traces
    }
    applyTraceOptions(traces){
        const saved = this.traceOptions?.length
            ? this.traceOptions
            : this.graph?.traces?.map(trace => ({
                id: trace.id,
                title: trace.title,
                options: trace.options
            }))
        if(!Array.isArray(saved)||!saved.length){
            return traces
        }
        const entries=saved.filter(entry=>entry&&typeof entry==="object")
        const positions=entries.map(entry=>entry.id)
        const pending=entries.slice()
        for(const trace of traces){
            if(!trace.options||typeof trace.options!=="object"){
                continue
            }
            let match=pending.find(entry=>entry.id===trace.id)
            if(!match){
                match=pending.find(entry=>entry.title===trace.title)
            }
            if(!match||!match.options||typeof match.options!=="object"){
                continue
            }
            pending.splice(pending.indexOf(match),1)
            //the applied object is shared with its saved entry, so later user
            //edits stay in sync and survive the next re-resolve
            trace.options=Object.assign({},trace.options,match.options)
            match.options=trace.options
            if(!trace.options.marker||typeof trace.options.marker!=="object"){
                trace.options.marker={shape:"circle",size:4}
            }
            if(!trace.options.line||typeof trace.options.line!=="object"){
                trace.options.line={size:1,style:"solid",joinStyle:"round",miterLimit:10,capStyle:"flat"}
            }
        }
        //restore the saved drawing order (drag-reorder in the inspector)
        if(positions.length){
            traces.sort((a,b)=>{
                const ia=positions.indexOf(a.id)
                const ib=positions.indexOf(b.id)
                return (ia===-1?positions.length:ia)-(ib===-1?positions.length:ib)
            })
        }
        return traces
    }
    async startResolve(){
        this.status="pending"
        const traces=this.applyTraceOptions(this.collectTraces())
        this.graph.setTraces(traces)
        this.graph.syncAxisLabels()
        if(this.graph.parameters.axis.bottom.scale==="log"&&this.graph.points.some(([x,y])=>x<=0||y<=0)){
            this.setLogarithmicScale(false)
        }
        this.graph.drawGraph()
        this.renderInspector()
        this.status=traces.length?"resolved":"error"
    }
    restoreAfterImport(){
        this.status="floating"
        if(this.inputs.some(input=>input instanceof Map&&input.size)){
            //the session import already decoded the inputs: rebuild the traces
            //from them (saved axes and trace options are re-applied)
            this.startResolve()
        }else{
            this.graph?.drawGraph()
        }
    }
    refreshFromLinks(){
        //undo/redo path: the caller triggers this once the links exist again
        this.destination?.syncInputs(this).then(()=>{
            if(this.inputs.some(input=>input instanceof Map&&input.size)){
                //the live parents are already resolved: rebuild the traces from
                //them (saved axes and trace options are re-applied)
                this.startResolve()
            }else{
                this.status="floating"
                this.graph?.drawGraph()
            }
        })
    }
}

function nodeRestoreData(node){
    return {
        title:node.title,
        type:node.constructor.name,
        registrationName:node.events?.registrationName,
        //inputs keep their shape only: Maps are rebuilt from the live links by
        //syncInputs (and by resolveFlow), so parent nodes are never deep-cloned
        inputs:node.inputs.map(entry=>entry instanceof Map ? new Map() : DC(entry)),
        outputs:DC(node.outputs),
        position:{...node.parameters.position},
        status:node.status,
        source:node.parameters.source?DC(node.parameters.source):null,
        state:node.serializeState?.()??null
    }
}

function createNodeForHistory(origin,flow,data){
    const position={...data.position}
    let node
    switch(data.type){
        case "DelimitedTextNode":
            node=new DelimitedTextNode(data.title,origin,flow,position)
            break
        case "SimpleXYPlotNode":
            node=new SimpleXYPlotNode(data.title,DC(data.inputs),DC(data.outputs),origin,flow,position)
            break
        case "NodeWithAccordionGraph":
            node=new NodeWithAccordionGraph(data.title,DC(data.inputs),DC(data.outputs),origin,flow,position)
            break
        case "NodeWithRightAccordionGraph":
            node=new NodeWithRightAccordionGraph(data.title,DC(data.inputs),DC(data.outputs),origin,flow,position)
            break
        case "NodeWithAccordion":
            node=new NodeWithAccordion(data.title,DC(data.inputs),DC(data.outputs),origin,flow,position)
            break
        case "Operation":
            node=new Operation(data.title,origin,flow,position)
            break
        case "PersistentHomology0DNode":
            node=new PersistentHomology0DNode(data.title,origin,flow,position)
            break
        default:
            node=new Node(data.title,DC(data.inputs),DC(data.outputs),origin,flow,position)
            break
    }
    origin.channel.register(data.registrationName??"node",node,node.title)
    if(data.source){
        node.parameters.source=DC(data.source)
        node.updateLabel(node.parameters.source.fileName)
        node.startResolve().then(()=>node.renderAccordion?.())
        return node
    }
    if(data.state&&typeof node.restoreState==="function"){
        node.restoreState(data.state)
    }
    if(data.status){
        node.status=data.status
    }
    if(Array.isArray(data.outputs)&&data.outputs.length===node.outputs.length){
        node.outputs=DC(data.outputs)
    }
    node.graph?.drawGraph()
    return node
}

class Flow{
    constructor(title,origin,destination){
        this.title=title
        this.origin=origin
        this.destination=destination
        this.container=CE('div',{className:`flow container ${title}`},[])
        this.events={broadcast:{
            linkSelected(link){return new CustomEvent('linkSelected',{detail:{msg:link,emitter:this}})},
            linkDeleted(link){return new CustomEvent('linkDeleted',{detail:{msg:link,emitter:this}})}
        },listen:{
            nodeMove(e){this.updateLinks()},
            startLinkDrawing(e){this.startBuildingLink(e)},
            stopLinkDrawing(e){this.stopBuildingLink(e)},
            nodeKilled(e){this.updateLinks()},
            nodeStatusChanged(e){this.forwardStatus(e.detail.emitter,e.detail.msg.status)},
            linkSelected(e){},
            async resolveFlow(e){
                await this.resolveFlow()
            },
        }}
        this.nodeSet=new Set()
        this.linkList=[]
        //tracks the live instance that replaced a deleted node (undo of "Delete
        //node"), so older commands recorded against the dead instance stay effective
        this.replacements=new Map()
        this.parameters={
            field:{
                drawn:false,
                node:[],
                links:{stiffness:75}
            }
        }
        stylize(this.container,{
            position:"relative",
            width:"100%",
            height:"100%",
        })
        this.destination.appendChild(this.container)
        this.draw()
    }
    draw(){
        if(!this.parameters.field.drawn){
            this.parameters.field.drawn=true
            let container=d3.select(this.container)
            this.field=container.append("svg")
                .attr("width","100%")
                .attr("height","100%")
                .attr("class","flow field")
        }
    }
    startBuildingLink(e){
        const startingPos=Node.anchorAbsPos(e.detail.msg.starter)
        this.linkList.push(d3.create("svg:g").attr('class','link').append('path').style('pointer-events','none')
            .attr("d", `M ${startingPos.x} ${startingPos.y} L ${startingPos.x} ${startingPos.y}`)
            .attr("class", "link"))
        this.linkList.at(-1).startingAnchor=e.detail.msg.starter
        this.linkList.at(-1).startingNode=e.detail.emitter
        this.field.node().appendChild(this.linkList.at(-1).node())
        let bezierSide=e.detail.emitter.parameters.anchorMap.get(e.detail.msg.starter).type==="output"?+this.parameters.field.links.stiffness:-this.parameters.field.links.stiffness
        document.onmousemove=(e)=>{
            e.preventDefault()
            const rect = this.field.node().getBoundingClientRect()
            const x = e.clientX - rect.left
            const y = e.clientY - rect.top
            this.linkList.at(-1).attr("d", `M ${startingPos.x} ${startingPos.y}
                C ${startingPos.x+bezierSide} ${startingPos.y},
                ${x-bezierSide} ${y},
                ${x} ${y}`)
        }
        document.onmouseup=(e)=>{
            e.preventDefault();
            if(!this.linkList.at(-1).endingAnchor){
                this.linkList.at(-1).node().remove()
                this.linkList.pop()
            }else{
                const endingPos=Node.anchorAbsPos(this.linkList.at(-1).endingAnchor)
                let link=this.linkList.at(-1)
                link.attr("d", `M ${startingPos.x} ${startingPos.y}
                    C ${startingPos.x+bezierSide} ${startingPos.y},
                    ${endingPos.x-bezierSide} ${endingPos.y},
                    ${endingPos.x} ${endingPos.y}`)
                link.style('pointer-events','stroke')
                link.attr("id",this.linkList.length-1)
                link.attr("tabindex",0)
                link.lower()
                link.node().pilot=this
                link.node().handleClick=(e)=>{dispatchEvent(e.target.pilot.events.broadcast.linkSelected.call(e.target.pilot,e.target))}
                link.node().handleKeyDown=(e)=>{
                    if(e.key==="Delete"){
                        e.target.pilot.deleteLink(e.target)
                    }
                }
                if(!this.origin.history.replaying){
                    const descriptor={
                        inputNode:link.inputNode,
                        inputIndex:Number(link.inputAnchor.id),
                        outputNode:link.outputNode,
                        outputIndex:Number(link.outputAnchor.id)
                    }
                    this.origin.history.record(new Command({
                        label:`Create link ${descriptor.inputNode.title} -> ${descriptor.outputNode.title}`,
                        undo:()=>this.deleteLink(link,{record:false}),
                        redo:()=>{link=this.createLink(
                            descriptor.inputNode,
                            descriptor.inputIndex,
                            descriptor.outputNode,
                            descriptor.outputIndex
                        )}
                    }))
                }
            }
            document.onmousemove=null;
            document.onmouseup=null;
        }
    }
    createLink(inputNode,inputIndex,outputNode,outputIndex){
        const inputAnchor=inputNode.DOMelt.querySelectorAll('.output.anchor')[inputIndex]
        const outputAnchor=outputNode.DOMelt.querySelectorAll('.input.anchor')[outputIndex]
        if(!inputAnchor||!outputAnchor){
            return null
        }
        const startingPos=Node.anchorAbsPos(inputAnchor)
        const endingPos=Node.anchorAbsPos(outputAnchor)
        const link=d3.create("svg:g")
            .attr("class","link")
            .append("path")
            .attr("class","link")
            .style("pointer-events","stroke")
            .attr("d",`M ${startingPos.x} ${startingPos.y}
                C ${startingPos.x+this.parameters.field.links.stiffness} ${startingPos.y},
                ${endingPos.x-this.parameters.field.links.stiffness} ${endingPos.y},
                ${endingPos.x} ${endingPos.y}`)
        link.startingAnchor=inputAnchor
        link.endingAnchor=outputAnchor
        link.startingNode=inputNode
        link.endingNode=outputNode
        link.inputNode=inputNode
        link.outputNode=outputNode
        link.inputAnchor=inputAnchor
        link.outputAnchor=outputAnchor
        link.node().pilot=this
        link.node().handleClick=e=>{
            e.target.focus()
            dispatchEvent(e.target.pilot.events.broadcast.linkSelected.call(e.target.pilot,e.target))
        }
        link.node().handleKeyDown=e=>{
            if(e.key==="Delete"){
                e.target.pilot.deleteLink(e.target)
            }
        }
        this.field.node().appendChild(link.node())
        this.linkList.push(link)
        link.attr("id",this.linkList.length-1)
        link.attr("tabindex",0)
        link.lower()
        return link
    }
    deleteLink(k,{record=true}={}){
        if(typeof k !="number"){
            //accepts a numeric index, a DOM element, or a d3 selection
            const target=typeof k?.node==="function"?k.node():k
            k=this.linkList.findIndex((e)=>{return e.node()===target||e===k})
        }
        const link=this.linkList[k]
        if(!link){
            return
        }
        const descriptor={
            inputNode:link.inputNode,
            inputIndex:Number(link.inputAnchor.id),
            outputNode:link.outputNode,
            outputIndex:Number(link.outputAnchor.id)
        }
        dispatchEvent(this.events.broadcast.linkDeleted(link))
        this.forwardStatus(link.outputNode,'floating')
        link.node().remove()
        this.linkList.splice(k,1)
        if(record&&!this.origin.history.replaying){
            let restoredLink=null
            this.origin.history.record(new Command({
                label:`Delete link ${descriptor.inputNode.title} -> ${descriptor.outputNode.title}`,
                undo:()=>{restoredLink=this.createLink(
                    descriptor.inputNode,
                    descriptor.inputIndex,
                    descriptor.outputNode,
                    descriptor.outputIndex
                )},
                redo:()=>this.deleteLink(restoredLink,{record:false})
            }))
        }
    }
    stopBuildingLink(e){
        if(this.linkList.at(-1).startingNode.parameters.anchorMap.get(this.linkList.at(-1).startingAnchor).type!=
            e.detail.emitter.parameters.anchorMap.get(e.detail.msg.stopper).type){
            this.linkList.at(-1).endingAnchor=e.detail.msg.stopper
            this.linkList.at(-1).endingNode=e.detail.emitter
            if(this.linkList.at(-1).endingAnchor.classList.contains('input')){
                this.linkList.at(-1).inputNode=this.linkList.at(-1).startingNode
                this.linkList.at(-1).outputNode=this.linkList.at(-1).endingNode
                this.linkList.at(-1).inputAnchor=this.linkList.at(-1).startingAnchor
                this.linkList.at(-1).outputAnchor=this.linkList.at(-1).endingAnchor
            }else{
                this.linkList.at(-1).inputNode=this.linkList.at(-1).endingNode
                this.linkList.at(-1).outputNode=this.linkList.at(-1).startingNode
                this.linkList.at(-1).inputAnchor=this.linkList.at(-1).endingAnchor
                this.linkList.at(-1).outputAnchor=this.linkList.at(-1).startingAnchor
            }
            this.forwardStatus(this.linkList.at(-1).outputNode,'floating')
        }
    }
    updateLinks(){
        for(let k=0;k<this.linkList.length;k++){
            if(this.nodeSet.has(this.linkList[k].startingNode) && this.nodeSet.has(this.linkList[k].endingNode)){
                const startingPos=Node.anchorAbsPos(this.linkList[k].startingAnchor)
                const endingPos=Node.anchorAbsPos(this.linkList[k].endingAnchor)
                let bezierSide=this.linkList[k].startingNode.parameters.anchorMap.get(this.linkList[k].startingAnchor).type==="output"?+this.parameters.field.links.stiffness:-this.parameters.field.links.stiffness
                this.linkList[k].attr("d", `M ${startingPos.x} ${startingPos.y}
                C ${startingPos.x+bezierSide} ${startingPos.y},
                ${endingPos.x-bezierSide} ${endingPos.y},
                ${endingPos.x} ${endingPos.y}`)
            }else{
                //dangling links are removed silently: their deletion is already
                //covered by the command that removed their node, recording them
                //here would pollute the undo stack with orphan link commands
                this.deleteLink(k,{record:false})
                k--
            }
        }
    }
    get leaves(){
        let res=new Set
        this.nodeSet.forEach((node)=>{
            let isLeave=true//!!node.inputs.length
            for (const link of this.linkList){
                if(node==link.inputNode){
                    isLeave=false
                    break
                }
            }
            if(isLeave){
                res.add(node)
            }
        })
        return res
    }
    parentsMap(node){
        let parents=new Map()
        for(let link of this.linkList){
            if(link.outputNode==node){
                const parent=link.inputNode
                if(!parents.has(parent)){
                    parents.set(parent,[])
                }
                parents.get(parent).push({
                    inputIndex:link.inputAnchor.id,
                    outputIndex:link.outputAnchor.id
                })
            }
        }
        return parents
    }
    childrenMap(node){
        let children=new Map()
        for(let link of this.linkList){
            if(link.inputNode==node){
                const child=link.outputNode
                if(!children.has(child)){
                    children.set(child,[])
                }
                children.get(child).push({
                    inputIndex:link.inputAnchor.id,
                    outputIndex:link.outputAnchor.id
                })
            }
        }
        return children
    }
    async parentSynapse(node,parentsMap){//download outputs into inputs for each link extracted in parentMap
        for(let k in node.inputs){
            node.inputs[k]=new Map()
        }
        await new Promise(resolve=>{
            for(let parent of parentsMap){
                for(let pair of parent[1]){
                    if(!node.inputs[pair.outputIndex].has(parent[0])){
                        node.inputs[pair.outputIndex].set(parent[0],[])
                    }
                    node.inputs[pair.outputIndex].get(parent[0]).push(parent[0].outputs[pair.inputIndex])
                }
            }
            resolve()
        })
    }
    async syncInputs(node){
        //rebuilds the node inputs from the current links without resolving the
        //parents (their outputs are already available in memory)
        await this.parentSynapse(node,this.parentsMap(node))
    }
    async resolveNode(node,resolutions=new Map(),ancestors=new Set()){
        if(ancestors.has(node)){
            return
        }
        if(resolutions.has(node)){
            return resolutions.get(node)
        }
        const nextAncestors=new Set(ancestors)
        nextAncestors.add(node)
        const parentsMap=this.parentsMap(node)
        const resolution=(async()=>{
            await Promise.all(parentsMap.keys().toArray().map(parent=>
                this.resolveNode(parent,resolutions,nextAncestors)
            ))
            await this.parentSynapse(node,parentsMap)
            await node.startResolve()
        })()
        resolutions.set(node,resolution)
        return resolution
    }
    async resolveFlow(){
        const resolutions=new Map()
        await Promise.all([...this.leaves].map(leaf=>this.resolveNode(leaf,resolutions)))
    }
    forwardStatus(node, status){
        this.childrenMap(node).keys().toArray().map(child=>this.forwardStatus(child,status))
        node.status=status
    }
}

class Menu{
    constructor(configObject,title,origin,destination){
        //console.log(destination)
        this.title=title
        this.origin=origin
        this.destination=destination
        this.container=CE('nav',{className:"menu container"},[])
        this.events={broadcast:{},listen:{}}
        this.dfs(configObject,this.container,0)
        this.draw()
        //stored so dispose() can remove the listener (importing a session must
        //not leave the old menu listening on the global window)
        this.windowClickHandler=(e)=>{
            if(!e.target.closest('.menu .container')){
                this.container.querySelectorAll('.parent.open').forEach(elt=>elt.classList.remove('open'))
            }
        }
        window.addEventListener('click',this.windowClickHandler)
    }
    dispose(){
        if(this.windowClickHandler){
            window.removeEventListener('click',this.windowClickHandler)
            this.windowClickHandler=null
        }
        this.container.remove()
    }
    dfs(object,DOMelt,rank){
        if(!Object.keys(object).length){
            return
        }
        const category=(rank==0 ? "menu" :"child")
        DOMelt.appendChild(CE('div',{className:category},[]))//ul
        let protoDOMelt
        rank++
        for (let k of Object.keys(object)){
            if(k=='hr'){
                protoDOMelt=CE('hr',{},[])
            } else {
                const isAction=typeof object[k]=='function'
                const closeSelfAndChildren=(element)=>{
                    element.classList.remove('open')
                    for(const child of element.children){
                        closeSelfAndChildren(child)
                    }
                }
                protoDOMelt=
                CE('div',{className:"parent",tabIndex:0,
                    handleClick:(e)=>{
                        e.stopPropagation()
                        if(isAction){
                            object[k]()
                            this.container.querySelectorAll('.parent.open').forEach(elt=>elt.classList.remove('open'))
                        }else{
                            for(const sibling of e.target.parentNode.children){
                                if(sibling!=e.target){
                                    closeSelfAndChildren(sibling)
                                }
                            }
                            e.target.classList.toggle('open')
                        }
                    },
                }
            ,[k+(Object.keys(object[k]).length==0 || rank<2?"":"..."),])
            }
            DOMelt.lastChild.append(protoDOMelt)
            this.dfs(object[k],protoDOMelt,rank)
        }
    }
    draw(){
        if (!this.destination.querySelector('.menu.container')){
            this.destination.appendChild(this.container);
        }else{
            this.container.remove()
            this.destination.appendChild(this.container);
        }
    }
}

class MainMenu extends Menu{
    constructor(configObject,title,origin,destination){
        super(configObject,title,origin,destination)
        this.undoItem=null
        this.redoItem=null
        for(const elt of this.container.querySelectorAll(".parent")){
            const text=elt.firstChild?.textContent??""
            if(text==="Undo") this.undoItem=elt
            if(text==="Redo") this.redoItem=elt
        }
        //stored so dispose() can remove the listener (importing a session must
        //not leave the old menu updating a detached DOM)
        this.historyChangedHandler=(e)=>this.updateUndoRedo(e.detail.msg)
        globalThis.addEventListener("historyChanged",this.historyChangedHandler)
        this.updateUndoRedo({canUndo:false,canRedo:false,undoLabel:null,redoLabel:null})
        this.events={
            broadcast:{
                poppedUp:new CustomEvent("poppedUp",{detail:{msg:"I've just popped up",emitter:this}}),
                killed:new CustomEvent("killed",{detail:{msg:"I've just been killed !!!",emitter:this}}),
            },
            listen:{
            importDelimitedText(e){
                origin.loadDelimitedText(source=>{
                    dispatchEvent(new CustomEvent('createNode',{detail:{msg:{
                        title:source.fileName||'Simple XY file',
                        type:'delimitedText',
                        source
                    }}}))
                })
            },
            msConvert(e){origin.msConvert()},
            undo(e){origin.history.undo()},
            redo(e){origin.history.redo()},
            exportSession(e){
                const {format,target}=e.detail.msg
                if(format==="json" && target==="file"){
                    origin.saveSession({download:true})
                }
            },
            async importSession(e){
                const {format,source}=e.detail.msg
                if(format==="json" && source==="file"){
                    await origin.importSession({filePicker:true})
                }
            },
            about(e){origin.about()},
            newSession(e){
                //replaces the current app with a fresh empty one
                origin.dispose()
                globalThis.Attributor=new App()
            },
        }}
    }
    updateUndoRedo({canUndo,canRedo,undoLabel,redoLabel}={}){
        if(this.undoItem){
            this.undoItem.firstChild.textContent=canUndo&&undoLabel?`Undo: ${undoLabel}`:"Undo"
            this.undoItem.style.opacity=canUndo?"1":"0.4"
        }
        if(this.redoItem){
            this.redoItem.firstChild.textContent=canRedo&&redoLabel?`Redo: ${redoLabel}`:"Redo"
            this.redoItem.style.opacity=canRedo?"1":"0.4"
        }
    }
    dispose(){
        if(this.historyChangedHandler){
            globalThis.removeEventListener("historyChanged",this.historyChangedHandler)
            this.historyChangedHandler=null
        }
        super.dispose()
    }
}

class MainFlowMenu extends Menu{
    constructor(configObject,title,origin,destination){
        super(configObject,title,origin,destination)
        this.events={
            broadcast:{},
            listen:{
                createNode(e){
                    const {title,type,source} = e.detail.msg
                    let node
                    switch (type) {
                        case "delimitedText":
                            node = new DelimitedTextNode(
                                title,
                                origin,
                                origin.channel.get("mainFlow"),
                                {x:180,y:10}
                            )
                            break
                        case "random": {
                            const inputs = []
                            const outputs = []
                            for (let k = 0; k < Math.round(Math.random() * 5); k++) {
                                outputs.push([0])
                            }
                            for (let k = 0; k < Math.round(Math.random() * 5); k++) {
                                inputs.push([0])
                            }
                            node = new Node(
                                title,
                                inputs,
                                outputs,
                                origin,
                                origin.channel.get("mainFlow"),
                                {x: 180, y: 10}
                            )
                            break
                        }
                        case "randomAccordion": {
                            const inputs = []
                            const outputs = []
                            for (let k = 0; k < Math.round(Math.random() * 5); k++) {
                                outputs.push([0])
                            }
                            for (let k = 0; k < Math.round(Math.random() * 5); k++) {
                                inputs.push([0])
                            }
                            node = new NodeWithAccordion(
                                title,
                                inputs,
                                outputs,
                                origin,
                                origin.channel.get("mainFlow"),
                                {x: 180, y: 10}
                            )
                            break
                        }
                        case "randomAccordionGraph":
                            const inputs = []
                            const outputs = []
                            for (let k = 0; k < Math.round(Math.random() * 5); k++) {
                                outputs.push([0])
                            }
                            for (let k = 0; k < Math.round(Math.random() * 5); k++) {
                                inputs.push([0])
                            }
                            node = new NodeWithAccordionGraph(
                                title,
                                inputs,
                                outputs,
                                origin,
                                origin.channel.get("mainFlow"),
                                {x: 180, y: 10}
                            )
                            break
                        case "rightAccordionGraph":
                            node = new NodeWithRightAccordionGraph(
                                title,
                                [],
                                [],
                                origin,
                                origin.channel.get("mainFlow"),
                                {x:180,y:10}
                            )
                            break
                        case "simpleXYPlot":
                            node = new SimpleXYPlotNode(
                                title,
                                [[]],
                                [],
                                origin,
                                origin.channel.get("mainFlow"),
                                {x:180,y:10}
                            )
                            break
                        case "operation":
                            node = new Operation(
                                title,
                                origin,
                                origin.channel.get("mainFlow"),
                                {x:180,y:10}
                            )
                            break
                        case "persistentHomology0D":
                            node = new PersistentHomology0DNode(
                                title,
                                origin,
                                origin.channel.get("mainFlow"),
                                {x:180,y:10}
                            )
                            break
                        default:
                            node = new Node(
                                title,
                                [],
                                [],
                                origin,
                                origin.channel.get("mainFlow"),
                                {x: 180, y: 10}
                            )
                            break
                    }
                    origin.channel.register("node", node, node.title)
                    if(type === "delimitedText" && source){
                        node.parameters.source={labels:["x","y"],...node.parameters.source,...source}
                        node.setColumnLabels?.(node.parameters.source.labels)
                        node.updateLabel(node.parameters.source.fileName)
                        node.startResolve().then(()=>node.renderAccordion())
                    }
                    if(!origin.history.replaying){
                        const nodeData=nodeRestoreData(node)
                        origin.history.record(new Command({
                            label:`Create node ${node.title}`,
                            undo:()=>node.suicide({skipHistory:true}),
                            redo:()=>{
                                node=createNodeForHistory(origin,origin.channel.get("mainFlow"),nodeData)
                                node.refreshFromLinks?.()
                            }
                        }))
                    }
                }
            }
        }
    }
}

class Channel{
    constructor(origin){
        this.origin=origin
        this.eventTypes={}
        this.listeners={}
        this.casters=new Map()
        this.names=new Map()
        this.nextId=1
    }
    register(requestedName,caster,label=caster.label??caster.title??requestedName){
        let registrationName=requestedName
        let suffix=2
        while(this.names.has(registrationName)){
            registrationName=`${requestedName} (${suffix})`
            suffix++
        }
        const registrationId=`channel-${this.nextId++}`
        this.casters.set(registrationId,caster)
        this.names.set(registrationName,registrationId)
        if (!caster.events){
            caster.events={}
        }
        if (!caster.events.broadcast){
            caster.events.broadcast={}
        }
        const identity={channel:this,registrationName,registrationId,label,caster}
        caster.events.broadcast['poppedUp']=new CustomEvent("poppedUp",{detail:{msg:identity,emitter:caster}})
        caster.events.broadcast['killed']=new CustomEvent("killed",{detail:{msg:"default killed message",emitter:caster}})
        caster.events.broadcast['registered']=new CustomEvent("registered",{detail:{msg:identity,emitter:caster}})
        caster.events.registrationName=registrationName
        caster.events.registrationId=registrationId
        caster.events.label=label
        const broadcasts=caster.events.broadcast
        Object.values(broadcasts).forEach((e)=>{
            if (!this.eventTypes[e.type]){
                this.listeners[e.type]=this.defaultListener.bind(this)
                globalThis.addEventListener(e.type,this.listeners[e.type])
                this.eventTypes[e.type]=new Set()
            }
        })
        if(!caster.events.listen){
        } else {
            const listeners=caster.events.listen
            Object.keys(listeners).forEach((e)=>{
                if (!this.eventTypes[e]){
                    this.listeners[e]=this.defaultListener.bind(this)
                    globalThis.addEventListener(e,this.listeners[e])
                    this.eventTypes[e]=new Set()
                }
                this.eventTypes[e].add(registrationId)
        })
        }
        dispatchEvent(broadcasts.registered)
        dispatchEvent(broadcasts.poppedUp)
        return registrationId
    }
    get(nameOrId){
        const id=this.casters.has(nameOrId)?nameOrId:this.names.get(nameOrId)
        return id===undefined?undefined:this.casters.get(id)
    }
    setupOnAir(){
        for(let etype of Object.keys(this.eventTypes)){
            globalThis.addEventListener(etype,this.listeners[etype])
        }
    }
    shutDown(){
        for(let etype of Object.keys(this.eventTypes)){
            globalThis.removeEventListener(etype,this.listeners[etype])
        }
        this.eventTypes={}
        this.listeners={}
        this.casters.clear()
        this.names.clear()
    }
    degister(registrationId){
        const caster=this.casters.get(registrationId)
        if(!caster){
            return
        }
        this.casters.delete(registrationId)
        this.names.delete(caster.events.registrationName)
        Object.entries(this.eventTypes).forEach(([eventType,casters])=>{
            casters.delete(registrationId)
            if(!casters.size){
                globalThis.removeEventListener(eventType,this.listeners[eventType])
                delete this.eventTypes[eventType]
                delete this.listeners[eventType]
            }
        })
    }
    defaultListener(e){
        const et=e.type
        if(this.eventTypes[e.type]){
            this.eventTypes[e.type].forEach((registrationId)=>{
                const caster=this.casters.get(registrationId)
                caster?.events.listen?.[et]?.call(caster,e)
                })
        }
        if(et=="killed"){
            this.degister(e.detail.emitter.events.registrationId)
        }
    }
}

//mouse zoom: the domain expansion per wheel notch is exp(deltaY × this);
//0.002 ≈ ±20% for a classic 100px notch, smooth for trackpad deltas
const WHEEL_ZOOM_SENSITIVITY=0.002
//quiet period after the last wheel event before the gesture is committed
//to the history as a single undoable command
const ZOOM_GESTURE_DELAY=300
//left-drag must travel further than this (px) before it becomes a pan, so
//plain clicks and double-clicks never move the view
const PAN_DEAD_ZONE=4
//after an activated pan, the dblclick reset is ignored for this long (ms):
//the click completing a drag must not trigger it by accident
const PAN_DBLCLICK_GUARD=350

class Plot2D{
    constructor(data,title,origin,destination){
        this.title=title
        this.data=data
        this.traces=[]
        this.origin=origin
        this.destination=destination
        this.container=CE('div',{className:"2dplot container",pilot:this},[]);
        this.parameters={
            graphzone:{
                drawn:false,
                opacity:"0.5"
            },
            baseMargins:{
                top:12,
                bottom:52,
                left:40,
                right:15
            },
            margins:{
                top:12,
                bottom:52,
                left:40,
                right:15
            },
            axis:DC(this.defaultAxes)
        }
        this.updateMargins()
        stylize(this.container,{
            position:"relative",
            width:"100%",
            height:"100%",
        })
        this.destination.appendChild(this.container)
        this.drawGraph()
        this.container.handleResize=(e)=>e.target.pilot.drawGraph()
        //mouse zoom & pan: the wheel rescales the domains under the cursor,
        //left-drag translates them (clamped like the zoom), a double-click
        //gives the automatic (data fitted) view back
        this.zoomDrawFrame=null
        this.zoomGestureBefore=null
        this.zoomGestureTimer=null
        this.zoomedWhileEmpty=false
        this.lastPanEndAt=-Infinity
        this.container.addEventListener("wheel",(event)=>this.handleWheelZoom(event),{passive:false})
        this.container.addEventListener("dblclick",(event)=>this.handleZoomReset(event))
        this.container.addEventListener("mousedown",(event)=>this.handlePanStart(event))
    }
    get graphzone(){
        return {
            width:Math.max(0,this.container.clientWidth-this.parameters.margins.left-this.parameters.margins.right),
            height:Math.max(0,this.container.clientHeight-this.parameters.margins.top-this.parameters.margins.bottom)
        }
    }
    get defaultAxes(){
        return {
            bottom:{
                drawn:false,
                enabled:true,
                mirror:null,
                domain:[0,1],
                autoDomain:true,
                range:[0,1],
                position:{left:0,top:1},
                label:"Abscissa",
                autoLabel:true,
                orientation:"horizontal",
                scale:"linear",
                type:"bottom"
            },
            left:{
                drawn:false,
                enabled:true,
                mirror:null,
                domain:[0,1],
                autoDomain:true,
                range:[1,0],
                position:{left:0,top:0},
                label:"Ordinate",
                autoLabel:true,
                orientation:"vertical",
                scale:"linear",
                type:"left"
            },
            top:{
                drawn:false,
                enabled:false,
                mirror:"bottom",
                domain:[0,1],
                autoDomain:true,
                range:[0,1],
                position:{left:0,top:0},
                label:"",
                autoLabel:true,
                orientation:"horizontal",
                scale:"linear",
                type:"top"
            },
            right:{
                drawn:false,
                enabled:false,
                mirror:"left",
                domain:[0,1],
                autoDomain:true,
                range:[1,0],
                position:{left:1,top:0},
                label:"",
                autoLabel:true,
                orientation:"vertical",
                scale:"linear",
                type:"right"
            }
        }
    }
    ensureAxes(){
        for(const [key,fallback] of Object.entries(this.defaultAxes)){
            const axis=this.parameters.axis[key]
            if(!axis){
                this.parameters.axis[key]=DC(fallback)
                continue
            }
            for(const [field,value] of Object.entries(fallback)){
                if(axis[field]===undefined){
                    axis[field]=DC(value)
                }
            }
        }
    }
    updateMargins(){
        if(!this.parameters.baseMargins){
            this.parameters.baseMargins={...this.parameters.margins}
        }
        const margins={...this.parameters.baseMargins}
        if(this.axisShown("top")){
            margins.top=Math.max(margins.top,52)
        }
        if(this.axisShown("right")){
            margins.right=Math.max(margins.right,40)
        }
        this.parameters.margins=margins
        return margins
    }
    axisShown(key){
        const axis=this.parameters.axis[key]
        return Boolean(axis&&(axis.enabled??true))
    }
    axisMirrorOf(key){
        const mirror=this.parameters.axis[key]?.mirror
        return mirror?this.parameters.axis[mirror]??null:null
    }
    //the axis a drawn axis takes its scale and domain from (itself unless it is a mirrored axis)
    axisSource(key){
        return this.axisMirrorOf(key)??this.parameters.axis[key]
    }
    axisLabelText(key){
        const axis=this.parameters.axis[key]
        if(axis?.label) return axis.label
        return this.axisMirrorOf(key)?.label??""
    }
    //coordinates are expressed inside the anchor group, so they only need the graphzone and a free margin
    axisLabelPlacement(key){
        const type=this.parameters.axis[key]?.type??key
        switch(type){
            case "top":
                return {rotate:null,x:this.graphzone.width/2,y:-38}
            case "left":
                return {rotate:-90,x:-this.graphzone.height/2,y:-28}
            case "right":
                return {rotate:90,x:this.graphzone.height/2,y:-28}
            case "bottom":
            default:
                return {rotate:null,x:this.graphzone.width/2,y:38}
        }
    }
    setTraces(traces){
        this.traces=traces.filter(trace=>trace instanceof XYTrace)
        //the flat legacy holder only matters while no trace exists: rebuilding
        //it from the traces would allocate one array per point on every resolve
        this.data=this.traces.length?[]:this.data
    }
    syncAxisLabels(){
        const reference=this.traces[0]?.wave
        if(!reference) return
        if(this.parameters.axis.bottom.autoLabel){
            this.parameters.axis.bottom.label=reference.labels[0]??"X"
        }
        if(this.parameters.axis.left.autoLabel){
            this.parameters.axis.left.label=reference.labels[1]??"Y"
        }
    }
    get points(){
        if(this.traces.length){
            return this.traces.flatMap(trace=>trace.points)
        }
        return this.data
    }
    //allocation free equivalent of the historical
    //filter/slice walk: the same points are visited, but no per point array
    //is ever materialised (mandatory for datasets in the million range)
    dataBounds(){
        const logX=this.parameters?.axis?.bottom?.scale==="log"
        const logY=this.parameters?.axis?.left?.scale==="log"
        const validX=x=>Number.isFinite(x)&&(!logX||x>0)
        const validY=y=>Number.isFinite(y)&&(!logY||y>0)
        let xMin=Infinity
        let xMax=-Infinity
        let yMin=Infinity
        let yMax=-Infinity
        const sources=this.traces.length?this.traces:[{points:this.data}]
        for(const source of sources){
            const wave=source.wave
            if(wave?.core&&wave.degree===2&&wave.dims[1]===2){
                //Wave.core is canonical [x0..xN, y0..yN].
                const core=wave.core
                const count=wave.dims[0]
                for(let i=0;i<count;i++){
                    const x=core[i]
                    const y=core[count+i]
                    if(!validX(x)||!validY(y)) continue
                    if(x<xMin) xMin=x
                    if(x>xMax) xMax=x
                    if(y<yMin) yMin=y
                    if(y>yMax) yMax=y
                }
                continue
            }
            const points=source.points
            if(!points) continue
            if(points instanceof Float32Array||points instanceof Float64Array){
                for(let i=0;i+1<points.length;i+=2){
                    const x=points[i]
                    const y=points[i+1]
                    if(!validX(x)||!validY(y)) continue
                    if(x<xMin) xMin=x
                    if(x>xMax) xMax=x
                    if(y<yMin) yMin=y
                    if(y>yMax) yMax=y
                }
                continue
            }
            for(const pair of points){
                if(!Array.isArray(pair)) continue
                const x=pair[0]
                const y=pair[1]
                if(!validX(x)||!validY(y)) continue
                if(x<xMin) xMin=x
                if(x>xMax) xMax=x
                if(y<yMin) yMin=y
                if(y>yMax) yMax=y
            }
        }
        if(xMin===Infinity||yMin===Infinity) return null
        return {
            xMin,
            xMax,
            yMin,
            yMax
        }
    }
    ensureValidScales(bounds){
        const limits={bottom:[bounds?.xMin,bounds?.xMax],left:[bounds?.yMin,bounds?.yMax]}
        for(const [key,[dataMin,dataMax]] of Object.entries(limits)){
            const axis=this.parameters.axis[key]
            const domain=axis.domain??[]
            const invalidData=!(dataMin>0)||!(dataMax>0)
            const invalidManualDomain=!axis.autoDomain&&(!(domain[0]>0)||!(domain[1]>0))
            if(axis.scale==="log"&&(invalidData||invalidManualDomain)){
                axis.scale="linear"
                axis.autoDomain=true
            }
        }
    }
    //the domain a double-click reset lands on: also the outer bound the
    //wheel zoom-out never crosses (single source of truth for both)
    autoDomainFor(axis,bounds){
        if(!bounds) return null
        if(axis==="bottom"){
            if(this.parameters.axis.bottom.scale==="log"){
                return [bounds.xMin/1.05,bounds.xMax*1.05]
            }
            const xPadding=(bounds.xMax-bounds.xMin)||1
            return [bounds.xMin-0.05*xPadding,bounds.xMax+0.05*xPadding]
        }
        if(axis==="left"){
            if(this.parameters.axis.left.scale==="log"){
                return [bounds.yMin/1.05,bounds.yMax*1.05]
            }
            const yPadding=(bounds.yMax-bounds.yMin)||1
            return [bounds.yMin-0.05*yPadding,bounds.yMax+0.05*yPadding]
        }
        return null
    }
    //Y bounds restricted to the X window currently shown. Used by the
    //single-axis X zoom so points outside that window cannot keep Y too
    //compressed. Keeps the allocation-free typed/Wave traversal of dataBounds.
    dataBoundsInXDomain(){
        const xAxis=this.parameters?.axis?.bottom
        const yAxis=this.parameters?.axis?.left
        const xDomain=xAxis?.domain
        if(!Array.isArray(xDomain)||xDomain.length<2) return null
        if(!Number.isFinite(xDomain[0])||!Number.isFinite(xDomain[1])) return null
        const logX=xAxis.scale==="log"
        const logY=yAxis?.scale==="log"
        if((logX&&!(xDomain[0]>0))||(logY&&!(xDomain[1]>0))) return null
        const validX=x=>Number.isFinite(x)&&x>=xDomain[0]&&x<=xDomain[1]&&(!logX||x>0)
        const validY=y=>Number.isFinite(y)&&(!logY||y>0)
        let yMin=Infinity
        let yMax=-Infinity
        const visit=(x,y)=>{
            if(validX(x)&&validY(y)){
                if(y<yMin) yMin=y
                if(y>yMax) yMax=y
            }
        }
        const sources=this.traces.length?this.traces:[{points:this.data}]
        for(const source of sources){
            const wave=source.wave
            if(wave?.core&&wave.degree===2&&wave.dims[1]===2){
                const core=wave.core
                const count=wave.dims[0]
                for(let i=0;i<count;i++) visit(core[i],core[count+i])
                continue
            }
            const points=source.points
            if(!points) continue
            if(points instanceof Float32Array||points instanceof Float64Array){
                for(let i=0;i+1<points.length;i+=2) visit(points[i],points[i+1])
                continue
            }
            for(const pair of points){
                if(Array.isArray(pair)) visit(pair[0],pair[1])
            }
        }
        return yMin===Infinity?null:{yMin,yMax}
    }
    autoDomain(axis,bounds){
        const domain=this.autoDomainFor(axis,bounds)
        if(domain){
            this.parameters.axis[axis].domain=domain
        }
    }
    /* -----------------------------------------------------------------
       Mouse zoom — the wheel rescales both domains around the data point
       under the cursor, computed in the space of each axis scale (identity
       for a linear axis, log10 for a logarithmic one) so the anchored
       point never moves on screen. Zooming out stops at the auto-fit
       bounds a double-click restores. autoDomain is switched off: drawGraph
       then keeps the manual domains, the SVG overlay, the WebGL camera
       (refreshCamera reads these very scales) and the widgets drawn on top
       (the classifier line …) all follow through the regular redraw path.
      ----------------------------------------------------------------- */
    handleWheelZoom(event){
        //a plain horizontal scroll (deltaY 0) must not freeze autoDomain
        if(!event.deltaY) return
        //the plot owns the wheel gesture: no ancestor may scroll while zooming
        event.preventDefault()
        const zone=this.graphzone
        if(!(zone.width>0&&zone.height>0)) return
        //deltaMode: 0 pixels, 1 lines (×16), 2 pages (×plot height)
        const unit=event.deltaMode===1?16:event.deltaMode===2?zone.height:1
        const factor=Math.exp(event.deltaY*unit*WHEEL_ZOOM_SENSITIVITY)
        if(!Number.isFinite(factor)||factor<=0) return
        //cursor position inside the anchor group (the margins are excluded)
        const rect=this.container.getBoundingClientRect()
        const pixelX=Math.min(Math.max(event.clientX-rect.left-this.parameters.margins.left,0),zone.width)
        const pixelY=Math.min(Math.max(event.clientY-rect.top-this.parameters.margins.top,0),zone.height)
        const {xScale,yScale}=this.plotScales()
        //plain wheel: both axes, shift: Y only, ctrl: X only (alt kept as an alias of ctrl)
        const zoomX=!event.shiftKey
        const zoomY=!event.ctrlKey&&!event.altKey
        let changed=false
        if(zoomX){
            changed=this.zoomAxisDomain("bottom",xScale.invert(pixelX),factor)||changed
            //Ctrl/Alt is the X-only gesture. Refit Y to the points inside
            //the new X window so the vertical signal uses the available
            //height. Plain wheel keeps the existing linked two-axis zoom.
            if(changed&&!zoomY){
                const visibleBounds=this.dataBoundsInXDomain()
                const yFit=this.autoDomainFor("left",visibleBounds)
                if(yFit){
                    this.parameters.axis.left.domain=yFit
                    //This is a fit to the current X window, not the global
                    //data bounds drawGraph would restore in auto mode.
                    this.parameters.axis.left.autoDomain=false
                }
            }
        }
        if(zoomY){
            changed=this.zoomAxisDomain("left",yScale.invert(pixelY),factor)||changed
        }
        if(!changed) return
        //a wheel zoom made before any trace fits no data: remember it so
        //the first drawGraph carrying real bounds discards that manual view
        if(!this.lastDataBounds) this.zoomedWhileEmpty=true
        this.beginZoomGesture()
        this.scheduleZoomDraw()
    }
    //one axis domain scaled around the anchor value, computed in the scale
    //space so a log axis stays strictly positive by construction
    zoomAxisDomain(key,anchor,factor){
        const axis=this.parameters.axis[key]
        const domain=axis?.domain
        if(!Array.isArray(domain)||domain.length<2) return false
        if(!Number.isFinite(anchor)||!Number.isFinite(domain[0])||!Number.isFinite(domain[1])) return false
        const log=axis.scale==="log"
        if(log&&!(anchor>0)) return false
        const to=log?(value=>Math.log10(value)):(value=>value)
        const from=log?(value=>10**value):(value=>value)
        const start=to(domain[0])
        const end=to(domain[1])
        const at=to(anchor)
        let nextStart=at+(start-at)*factor
        let nextEnd=at+(end-at)*factor
        if(!Number.isFinite(nextStart)||!Number.isFinite(nextEnd)) return false
        //set when the clamp snaps a stale view back onto the fit bounds
        let snapped=false
        //zooming out never goes past the auto-fit bounds a double-click
        //restores (the same bounds drawGraph applies through autoDomain)
        if(factor>1){
            const fit=this.fitBoundsFor(key)
            if(fit){
                const low=to(fit[0])
                const high=to(fit[1])
                if(Number.isFinite(low)&&Number.isFinite(high)){
                    nextStart=Math.max(nextStart,low)
                    nextEnd=Math.min(nextEnd,high)
                    //the stale view sits entirely outside the fit bounds:
                    //wheel-out means "show everything", so snap to the fit
                    if(!(nextEnd>nextStart)){
                        nextStart=low
                        nextEnd=high
                        snapped=true
                    }
                }
            }
        }
        //refuse to collapse the domain into (or through) a single float
        const minSpan=Math.max(Math.abs(nextStart),Math.abs(nextEnd),1)*Number.EPSILON*4
        if(Math.abs(nextEnd-nextStart)<minSpan) return false
        const clamped=[from(nextStart),from(nextEnd)]
        //already sitting on the (possibly clamped) target: no state change,
        //so a wheel stuck against the bounds neither redraws nor records
        if(clamped[0]===domain[0]&&clamped[1]===domain[1]) return false
        axis.domain=clamped
        //landing on the fit bounds (snap) IS the auto view: back to auto
        //mode, otherwise the view is manual and drawGraph must keep it
        axis.autoDomain=snapped
        return true
    }
    //The plot view changed programmatically (wheel zoom, pan, reset). The
    //inspector registers a direct callback instead of a DOM event: the slider
    //blocks are rebuilt from axis.domain, which is the single source of truth.
    notifyViewChanged(){
        this.onViewChange?.()
    }

    //wheel bursts and mouse drags both move the domains immediately while
    //the redraw (axes, traces, camera, widgets) runs at most once per frame
    scheduleZoomDraw(){
        if(this.zoomDrawFrame!==null&&this.zoomDrawFrame!==undefined) return
        this.zoomDrawFrame=requestAnimationFrame(()=>{
            this.zoomDrawFrame=null
            this.drawGraph()
            //a pan rebuilds the inspector sliders on every frame otherwise
            if(!this.panInProgress) this.notifyViewChanged()
        })
    }
    //the domains are snapshotted once per gesture (debounced): a whole
    //wheel burst lands in the history as one single undoable command
    beginZoomGesture(){
        if(!this.zoomGestureBefore){
            this.zoomGestureBefore=this.captureZoomState()
        }
        clearTimeout(this.zoomGestureTimer)
        this.zoomGestureTimer=setTimeout(()=>this.commitZoomGesture(),ZOOM_GESTURE_DELAY)
    }
    captureZoomState(){
        return {
            bottom:this.captureAxisZoomState("bottom"),
            left:this.captureAxisZoomState("left")
        }
    }
    captureAxisZoomState(key){
        const axis=this.parameters.axis[key]
        return {
            domain:Array.isArray(axis?.domain)?[...axis.domain]:[0,1],
            autoDomain:Boolean(axis?.autoDomain)
        }
    }
    applyZoomState(state){
        for(const key of ["bottom","left"]){
            const axis=this.parameters.axis[key]
            const saved=state?.[key]
            if(!axis||!saved) continue
            axis.domain=[...saved.domain]
            axis.autoDomain=saved.autoDomain
        }
    }
    zoomStatesEqual(a,b){
        return ["bottom","left"].every(key=>
            a[key].autoDomain===b[key].autoDomain
            &&a[key].domain[0]===b[key].domain[0]
            &&a[key].domain[1]===b[key].domain[1]
        )
    }
    commitZoomGesture(){
        clearTimeout(this.zoomGestureTimer)
        this.zoomGestureTimer=null
        const before=this.zoomGestureBefore
        this.zoomGestureBefore=null
        if(!before) return
        const after=this.captureZoomState()
        if(this.zoomStatesEqual(before,after)) return
        //the command resolves the domains at execution time through the
        //captured snapshots, so a later redraw cannot desync undo/redo
        this.origin?.history?.record?.(new Command({
            label:`Zoom ${this.title??"plot"}`,
            undo:()=>{this.applyZoomState(before);this.drawGraph()},
            redo:()=>{this.applyZoomState(after);this.drawGraph()}
        }))
    }
    //double-click: give the automatic (data fitted) view back
    handleZoomReset(event){
        //the click completing a just-finished pan must not reset the view
        if(performance.now()-this.lastPanEndAt<PAN_DBLCLICK_GUARD) return
        event.preventDefault()
        const before=this.captureZoomState()
        this.parameters.axis.bottom.autoDomain=true
        this.parameters.axis.left.autoDomain=true
        clearTimeout(this.zoomGestureTimer)
        this.zoomGestureTimer=null
        this.zoomGestureBefore=null
        if(this.zoomDrawFrame!==null&&this.zoomDrawFrame!==undefined){
            cancelAnimationFrame(this.zoomDrawFrame)
            this.zoomDrawFrame=null
        }
        const after=this.captureZoomState()
        if(this.zoomStatesEqual(before,after)) return
        this.origin?.history?.record?.(new Command({
            label:`Reset zoom ${this.title??"plot"}`,
            undo:()=>{this.applyZoomState(before);this.drawGraph()},
            redo:()=>{this.applyZoomState(after);this.drawGraph()}
        }))
        this.drawGraph()
        this.notifyViewChanged()
    }
    //the outer bounds both the wheel zoom-out and the pan clamp against:
    //exactly what a double-click reset shows (see autoDomainFor); null
    //while no data has ever been drawn
    fitBoundsFor(key){
        const fit=this.autoDomainFor(key,this.lastDataBounds??this.dataBounds())
        if(!Array.isArray(fit)||!Number.isFinite(fit[0])||!Number.isFinite(fit[1])) return null
        return fit
    }
    //translates one axis domain by a pixel shift (the content follows the
    //cursor), through the very scale drawGraph renders with: a log axis
    //then translates in log space and stays strictly positive. The window
    //is clamped inside the fit bounds — it can slide within them but never
    //past them (a window wider than them snaps onto them, the same stale
    //view rule as the wheel zoom-out)
    panAxisDomain(key,scale,shift){
        const axis=this.parameters.axis[key]
        const domain=axis?.domain
        if(!Array.isArray(domain)||domain.length<2) return false
        if(!Number.isFinite(domain[0])||!Number.isFinite(domain[1])) return false
        if(!Number.isFinite(shift)||!shift) return false
        const log=axis.scale==="log"
        const to=log?(value=>Math.log10(value)):(value=>value)
        const from=log?(value=>10**value):(value=>value)
        //each endpoint lives at its own range pixel: translate it there
        const pixels=scale.range()
        const rangePixels=Math.abs(pixels[1]-pixels[0])
        if(!(rangePixels>0)) return false
        let start=to(scale.invert(pixels[0]-shift))
        let end=to(scale.invert(pixels[1]-shift))
        if(!Number.isFinite(start)||!Number.isFinite(end)) return false
        let snapped=false
        const fit=this.fitBoundsFor(key)
        if(fit){
            const low=to(fit[0])
            const high=to(fit[1])
            if(Number.isFinite(low)&&Number.isFinite(high)){
                if(high-low<=end-start){
                    //wider than (or parked on) the bounds: snap onto them
                    start=low
                    end=high
                    snapped=true
                }else{
                    //slide the window back inside, span preserved
                    if(start<low){
                        end+=low-start
                        start=low
                    }
                    if(end>high){
                        start-=end-high
                        end=high
                    }
                }
            }
        }
        //refuse to collapse the domain into (or through) a single float
        const minSpan=Math.max(Math.abs(start),Math.abs(end),1)*Number.EPSILON*4
        if(Math.abs(end-start)<minSpan) return false
        //sub-pixel drift (the clamp held the window against an edge) must
        //neither redraw nor pollute the history
        const movedPx=Math.abs(start-to(domain[0]))/(end-start)*rangePixels
        if(!(movedPx>0.01)) return false
        const clamped=[from(start),from(end)]
        if(!Number.isFinite(clamped[0])||!Number.isFinite(clamped[1])) return false
        if(log&&!(clamped[0]>0&&clamped[1]>0)) return false
        axis.domain=clamped
        //snapping onto the fit bounds IS the auto view; anything else is a
        //manual view drawGraph must keep (same rule as the wheel zoom)
        axis.autoDomain=snapped
        return true
    }
    //left-drag pans both domains (content follows the cursor); the window
    //is clamped inside the same fit bounds as the wheel zoom-out, redraws
    //go through the rAF-coalesced zoom pipeline, and one whole drag lands
    //in the history as a single undoable command
    handlePanStart(event){
        //only the left button pans: the right one keeps its menu
        if(event.button!==0) return
        const zone=this.graphzone
        if(!(zone.width>0&&zone.height>0)) return
        //the plot is dragged as a whole; text selection and native focus
        //moves are blocked for the whole gesture
        event.preventDefault()
        //flush a pending wheel burst so it cannot fold into the pan command
        this.commitZoomGesture()
        const startX=event.clientX
        const startY=event.clientY
        this.panInProgress=true
        let lastX=startX
        let lastY=startY
        let active=false
        let before=null
        const onMove=(moveEvent)=>{
            moveEvent.preventDefault()
            if(!active){
                //dead zone: plain clicks and double-clicks never pan
                if(Math.hypot(moveEvent.clientX-startX,moveEvent.clientY-startY)<PAN_DEAD_ZONE) return
                active=true
                before=this.captureZoomState()
                this.container.style.cursor="grabbing"
                //apply the whole travel from the grab point, not just this step
                lastX=startX
                lastY=startY
            }
            const dx=moveEvent.clientX-lastX
            const dy=moveEvent.clientY-lastY
            lastX=moveEvent.clientX
            lastY=moveEvent.clientY
            if(!dx&&!dy) return
            const {xScale,yScale}=this.plotScales()
            let changed=false
            if(dx) changed=this.panAxisDomain("bottom",xScale,dx)||changed
            if(dy) changed=this.panAxisDomain("left",yScale,dy)||changed
            if(!changed) return
            //same escape hatch as the wheel: a pan before any trace is
            //discarded when the first real bounds arrive
            if(!this.lastDataBounds) this.zoomedWhileEmpty=true
            this.scheduleZoomDraw()
        }
        const onUp=()=>{
            window.removeEventListener("mousemove",onMove)
            window.removeEventListener("mouseup",onUp)
            window.removeEventListener("blur",onUp)
            this.detachPanOnBlur=null
            this.container.style.cursor=""
            this.panInProgress=false
            this.notifyViewChanged()
            if(!active) return
            //the click completing this drag must not finish a double-click
            this.lastPanEndAt=performance.now()
            const after=this.captureZoomState()
            if(this.zoomStatesEqual(before,after)) return
            this.origin?.history?.record?.(new Command({
                label:`Pan ${this.title??"plot"}`,
                undo:()=>{this.applyZoomState(before);this.drawGraph()},
                redo:()=>{this.applyZoomState(after);this.drawGraph()}
            }))
        }
        window.addEventListener("mousemove",onMove)
        window.addEventListener("mouseup",onUp)
        //a drag released outside the window never delivers a mouseup: without
        //this the pan guard would stay stuck and silently kill every later
        //wheel-zoom resync (the inspector would freeze for the whole session)
        window.addEventListener("blur",onUp)
        this.detachPanOnBlur=()=>window.removeEventListener("blur",onUp)
    }
    markerPath(shape,size){
        const s=size??4
        switch(shape){
            case "square": return `M${-s},${-s}H${s}V${s}H${-s}Z`
            case "diamond": return `M0,${-s}L${s},0L0,${s}L${-s},0Z`
            case "triangle-up": return `M0,${-s}L${s},${s}L${-s},${s}Z`
            case "triangle-down": return `M0,${s}L${s},${-s}L${-s},${-s}Z`
            case "cross": return `M${-s},${-s}L${s},${s}M${s},${-s}L${-s},${s}`
            case "plus": return `M${-s},0H${s}M0,${-s}V${s}`
            case "circle":
            default: return null
        }
    }
    drawGraph(){
        this.ensureAxes()
        this.updateMargins()
        let range=[]
        let scale={}
        let translate=""
        this.axesSVG={}
        let target=""
        const bounds=this.dataBounds()
        //the back layer reuses this very pass as its float precision reference
        this.lastDataBounds=bounds
        this.ensureValidScales(bounds)
        if(bounds){
            //a wheel zoom performed while the plot was empty fits no data:
            //discard that manual view so the first real trace is fitted
            if(this.zoomedWhileEmpty){
                this.zoomedWhileEmpty=false
                this.parameters.axis.bottom.autoDomain=true
                this.parameters.axis.left.autoDomain=true
                //the first real bounds land here: the view jumps back to auto,
                //so the inspector has to be told its widgets are now stale
                this.notifyViewChanged()
            }
            if(this.parameters.axis.bottom.autoDomain??true){
                this.autoDomain("bottom",bounds)
            }
            if(this.parameters.axis.left.autoDomain??true){
                this.autoDomain("left",bounds)
            }
        }
        if(this.parameters.graphzone.drawn){
        } else {
            this.parameters.graphzone.drawn=true
            this.graphSVG=d3.select(this.container)
                .append("svg")
                    .attr("width",this.container.clientWidth)
                    .attr("height",this.container.clientHeight)
                    .attr("class","main")
            this.graphSVG.append("g")
                    .attr("transform",`translate(${this.parameters.margins.left},${this.parameters.margins.top})`)
                    .attr('class',"anchor")
        }
        this.graphSVG
            .attr("width",this.container.clientWidth)
            .attr("height",this.container.clientHeight)
        this.graphSVG
            .select(".anchor")
                .attr("transform",`translate(${this.parameters.margins.left},${this.parameters.margins.top})`)
        this.graphSVG.attr('opacity',this.parameters.graphzone.opacity)
        for(let axis of Object.keys(this.parameters.axis)){
            if(!this.axisShown(axis)){
                this.graphSVG.select(".anchor").select(`.${axis}`).remove()
                this.parameters.axis[axis].drawn=false
                continue
            }
            if(this.parameters.axis[axis].drawn){
                //MAJ
            }else{
                //INIT (before the traces, so that a re-shown axis does not end up on top of the points)
                this.graphSVG.select(".anchor").insert("g",".trace").attr("class",axis)
            }
            target=`.${axis}`
            translate=`translate(${this.parameters.axis[axis].position.left*this.graphzone.width},${this.parameters.axis[axis].position.top*this.graphzone.height})`
            if(this.parameters.axis[axis].orientation=="horizontal"){
                range=[this.parameters.axis[axis].range[0]*this.graphzone.width,this.parameters.axis[axis].range[1]*this.graphzone.width]
            } else if (this.parameters.axis[axis].orientation=="vertical"){
                range=[this.parameters.axis[axis].range[0]*this.graphzone.height,this.parameters.axis[axis].range[1]*this.graphzone.height]
            }
            const source=this.axisSource(axis)
            scale=(source.scale==="log"?d3.scaleLog():d3.scaleLinear())
                .domain(source.domain)
                .range(range)
            this.axesSVG[axis]=this.graphSVG.select(".anchor").select(target)
            this.axesSVG[axis].attr("transform",translate)
            this.axesSVG[axis].attr("class",`${axis} plot-axis`)
            switch (this.parameters.axis[axis].type){
                case "left":
                    this.axesSVG[axis].call(d3.axisLeft(scale))
                    break
                case "right":
                    this.axesSVG[axis].call(d3.axisRight(scale))
                    break
                case "top":
                    this.axesSVG[axis].call(d3.axisTop(scale))
                    break
                case "bottom":
                    this.axesSVG[axis].call(d3.axisBottom(scale))
                    break
                default:
            }
            const label=this.axisLabelText(axis)
            const placement=this.axisLabelPlacement(axis)
            const axisLabel=this.axesSVG[axis].selectAll("text.axis-label").data([label])
            axisLabel.enter()
                .append("text")
                .attr("class","axis-label")
                .merge(axisLabel)
                .attr("text-anchor","middle")
                .attr("transform",placement.rotate===null?null:`rotate(${placement.rotate})`)
                .attr("x",placement.x)
                .attr("y",placement.y)
                .text(label)
            axisLabel.exit().remove()
            this.parameters.axis[axis].drawn=true
        }
        const {xScale,yScale}=this.plotScales()
        this.drawTraces(xScale,yScale)
    }
    //the axes and the WebGL back layer share these very scales: deriving the
    //camera bounds from them guarantees a pixel perfect superposition
    plotScales(){
        const xScale=(this.parameters.axis.bottom.scale==="log"?d3.scaleLog():d3.scaleLinear())
            .domain(this.parameters.axis.bottom.domain)
            .range([0,this.graphzone.width])
        const yScale=(this.parameters.axis.left.scale==="log"?d3.scaleLog():d3.scaleLinear())
            .domain(this.parameters.axis.left.domain)
            .range([this.graphzone.height,0])
        return {xScale,yScale}
    }
    //the trace list rendered by both layers: hidden traces are dropped and the
    //legacy plain-array data is wrapped once as a synthetic trace
    resolveRenderTraces(){
        return this.traces.length
            ?this.traces.filter(trace=>!trace.options.hidden)
            :[{
                id:"legacy-data",
                points:this.data,
                options:{color:"tomato",mode:"points",line:{size:1}}
            }]
    }
    //Data-space value the "sticks to zero" segments drop to: 0 on a linear
    //axis, half the smallest positive datum on a log axis (which has no zero).
    stickBaseline(){
        if(this.parameters.axis.left.scale!=="log") return 0
        const bounds=this.lastDataBounds??this.dataBounds()
        const yMin=bounds?.yMin
        return Number.isFinite(yMin)&&yMin>0?yMin/2:NaN
    }

    //D3/SVG trace rendering (the front layer keeps the interactive traces).
    //`traces` is injectable so a subclass can route a subset to the WebGL batch.
    drawTraces(xScale,yScale,traces=this.resolveRenderTraces()){
        const traceGroups=this.graphSVG.select(".anchor")
            .selectAll("g.trace")
            .data(traces,trace=>trace.id)
        const mergedTraceGroups=traceGroups.enter()
            .append("g")
            .attr("class","trace")
            .merge(traceGroups)
        const line=d3.line()
            .x(pair=>xScale(pair[0]))
            .y(pair=>yScale(pair[1]))
        const owner=this
        const stickBaseY=owner.stickBaseline()
        mergedTraceGroups.each(function(trace){
            const group=d3.select(this)
            const tracePoints=trace.points.filter(pair=>Array.isArray(pair)&&Number.isFinite(pair[0])&&Number.isFinite(pair[1]))
            const color=trace.options.color
            const showLine=(trace.options.mode==="lines-between-points"||trace.options.mode==="lines-and-points"||trace.options.mode==="sticks-to-zero")
            const showMarkers=(trace.options.mode==="points"||trace.options.mode==="lines-and-points")
            const traceLine=group.selectAll("path.trace-line").data(showLine?[tracePoints]:[])
            traceLine.enter()
                .append("path")
                .attr("class","trace-line")
                .merge(traceLine)
                .attr("d",trace.options.mode==="sticks-to-zero"?tracePoints.flatMap(pair=>`M${xScale(pair[0])},${yScale(stickBaseY)}L${xScale(pair[0])},${yScale(pair[1])}`).join(""):line(tracePoints))
                .attr("fill","none")
                .attr("stroke",color)
                .attr("stroke-width",trace.options.line.size)
                .attr("stroke-linejoin",trace.options.line.joinStyle)
                .attr("stroke-linecap",trace.options.line.capStyle)
                .attr("stroke-miterlimit",trace.options.line.miterLimit)
            traceLine.exit().remove()
            if(!showMarkers){
                group.selectAll(".point").remove()
                return
            }
            const marker=trace.options.marker??{shape:"circle",size:4}
            const pathD=owner.markerPath(marker.shape,marker.size)
            const circles=group.selectAll("circle.point")
            const paths=group.selectAll("path.point")
            if(pathD){
                circles.remove()
                const markerSelection=paths.data(tracePoints)
                markerSelection.enter()
                    .append("path")
                    .attr("class","point")
                    .merge(markerSelection)
                    .attr("d",pathD)
                    .attr("transform",pair=>`translate(${xScale(pair[0])},${yScale(pair[1])})`)
                    .attr("fill",(marker.shape==="cross"||marker.shape==="plus")?"none":color)
                    .attr("stroke",(marker.shape==="cross"||marker.shape==="plus")?color:"rgb(110, 122, 138)")
                    .attr("stroke-width",Math.max(1,(trace.options.line?.size??1)))
                markerSelection.exit().remove()
            }else{
                paths.remove()
                const tracePointsSelection=circles
                    .data(tracePoints)
                tracePointsSelection.enter()
                    .append("circle")
                    .attr("class","point")
                    .merge(tracePointsSelection)
                    .attr("cx",pair=>xScale(pair[0]))
                    .attr("cy",pair=>yScale(pair[1]))
                    .attr("r",marker.size??4)
                    .attr("fill",color)
                    .attr("stroke","rgb(110, 122, 138)")
                tracePointsSelection.exit().remove()
            }
        })
        traceGroups.exit().remove()
    }
}

/* =====================================================================
    Plot2DWebGL — the "sandwich" plot
    ---------------------------------------------------------------------
    Same layout math, same D3/SVG axis pipeline, same ResizeObserver /
    MutationObserver lifecycle as Plot2D; only the trace rendering is
    swapped for the WebGL back layer (scripts/plot2d-gl.js).

        BACK  : persistent <canvas class="trace-layer"> + one Three.js
                renderer/scene/orthographic camera (gl.POINTS + gl.LINES)
        FRONT : the untouched D3/SVG overlay (axes, ticks, labels,
                interaction widgets) drawn on top of the canvas

    The data path is flat Float32Array only, filled in a single traversal
    and re-filled only when the data, the axis transform or the styling
    changed: a resize/pan is strictly a GPU matrix swap.
   ===================================================================== */

const GL_RENDER_DEFAULTS={
    enabled:true,
    opacity:0.7,
    pixelRatioCap:2,
    //subtract the data minimum from every vertex (float32 precision guard)
    referenceOrigin:true
}

//how many times the post-draw watch may refill the buffers on its own before
//giving up and asking the application for an explicit refresh()
const GL_UPLOAD_CHECK_ATTEMPTS=8

class Plot2DWebGL extends Plot2D{
    constructor(data,title,origin,destination){
        super(data,title,origin,destination)
        //the base constructor already ran a first drawGraph, whose lazy
        //bootstrap may have created the layer: never clobber it here (each
        //replacement would leak a WebGL context and an orphan canvas)
        this.glLayer=this.glLayer??null
        //instances owned by the class and never recreated in the draw loop
        this.glRenderer=this.glRenderer??null
        this.glScene=this.glScene??null
        this.glCamera=this.glCamera??null
        this.glPoints=this.glPoints??null
        this.glLines=this.glLines??null
        this.glSignature=this.glSignature??null
        this.glDataRevision=this.glDataRevision??0
        this.glRenderOptions=this.glRenderOptions??{...GL_RENDER_DEFAULTS}
        //precision reference of the uploaded vertices
        this.glReference=this.glReference??{x:0,y:0}
        //identity of the arrays currently on the GPU (stale upload detection)
        this.glUploadedSources=this.glUploadedSources??null
        this.glSourceScratch=this.glSourceScratch??[]
        this.glCheckFrame=this.glCheckFrame??null
        this.glCheckAttempts=this.glCheckAttempts??0
        this.lastDataBounds=this.lastDataBounds??null
        this.resizeFrame=this.resizeFrame??null
        //the back layer needs its own stacking context (see styles/main.css)
        this.container.classList.remove("2dplot")
        this.container.classList.add("plot2d")
        stylize(this.container,{position:"relative",zIndex:"0"})
        this.ensureTraceCanvas()
        //the recursive ResizeObserver pipeline now drives the GPU fast path
        this.container.handleResize=(e)=>this.handleResize(e)
        this.drawGraph()
    }

    /* -----------------------------------------------------------------
       Setup phase — bootstrap the Three.js subsystem ONCE
      ----------------------------------------------------------------- */
    ensureTraceCanvas(){
        const renderOptions=this.glRenderOptions??GL_RENDER_DEFAULTS
        if(!this.glLayer&&renderOptions.enabled){
            let canvas=null
            try{
                canvas=CE("canvas",{className:"trace-layer"},[])
                stylize(canvas,{
                    position:"absolute",
                    left:"0px",
                    top:"0px",
                    display:"block",
                    pointerEvents:"none",
                    zIndex:"-1"
                })
                this.traceCanvas=canvas
                this.glLayer=new GLTraceLayer(canvas,{
                    opacity:renderOptions.opacity,
                    pixelRatioCap:renderOptions.pixelRatioCap
                })
                this.glLayer.onContextRestored=()=>{
                    //context loss wipes the GPU side buffers: force a re-upload
                    this.glSignature=null
                    this.drawGraph()
                }
                this.glRenderer=this.glLayer.renderer
                this.glScene=this.glLayer.scene
                this.glCamera=this.glLayer.camera
                this.glPoints=this.glLayer.points
                this.glLines=this.glLayer.lines
            }catch(error){
                console.warn(`Plot2DWebGL: WebGL layer unavailable (${THREE_CDN}), falling back to the SVG renderer`,error)
                canvas?.remove?.()
                this.traceCanvas=null
                this.glLayer=null
                this.glRenderOptions={...GL_RENDER_DEFAULTS,enabled:false}
            }
        }
        //the canvas is the first child so that the SVG overlay stays on top
        if(this.traceCanvas&&this.container.firstChild!==this.traceCanvas){
            this.container.insertBefore(this.traceCanvas,this.container.firstChild)
        }
        //defensive: never leave orphan canvases behind (each one owns a context)
        for(const child of [...this.container.children]){
            if(child!==this.traceCanvas&&child.classList?.contains("trace-layer")){
                child.remove()
            }
        }
        return this.glLayer
    }

    /* -----------------------------------------------------------------
       CPU side of the data path: traces → one descriptor per trace.
       Nothing here is per point, so the cost does not depend on the
       number of samples.
      ----------------------------------------------------------------- */
    buildTraceDescriptors(traces){
        const descriptors=[]
        for(const trace of traces){
            const options=trace.options??{}
            const marker=options.marker??{}
            const line=options.line??{}
            const mode=options.mode??"points"
            const markerSize=Number(marker.size??4)
            const lineSize=Number(line.size??1)
            const wave=trace.wave
            let buffer=null
            let yBuffer=null
            let pairs=null
            let count=0
            if(wave?.core&&wave.degree===2&&wave.dims[1]===2){
                //Wave.core is canonical [x0..xN, y0..yN], not interleaved.
                count=wave.dims[0]
                buffer=wave.core.subarray(0,count)
                yBuffer=wave.core.subarray(count,count*2)
            }else{
                const points=trace.points??[]
                if(points instanceof Float32Array||points instanceof Float64Array){
                    buffer=points
                    count=Math.floor(points.length/2)
                }else{
                    pairs=points
                    count=points.length
                }
            }
            descriptors.push({
                buffer,
                yBuffer,
                pairs,
                count,
                //colour resolution is a cached dictionary lookup: no DOM, no layout
                color:parseCssColor(options.color??"#ff0000"),
                //sprite diameter: one unit of the sprite is marker.size (half extent)
                size:markerSize*2,
                shape:shapeId(marker.shape??"circle"),
                markers:(mode==="points"||mode==="lines-and-points")&&markerSize>0,
                lines:(mode==="lines-between-points"||mode==="lines-and-points")&&lineSize>0,
                sticks:mode==="sticks-to-zero"&&lineSize>0
            })
        }
        return descriptors
    }

    //cheap O(#traces) fingerprint: the GPU buffers are refilled only when the
    //data, the axis transforms or the trace styling actually changed
    traceSignature(traces){
        const parts=[
            this.glDataRevision??0,
            this.parameters.axis.bottom.scale,
            this.parameters.axis.left.scale,
            traces.length
        ]
        for(const trace of traces){
            const options=trace.options??{}
            const marker=options.marker??{}
            const line=options.line??{}
            const wave=trace.wave
            parts.push(
                trace.id??"",
                options.color??"",
                options.mode??"",
                marker.shape??"",
                marker.size??"",
                line.size??"",
                wave?wave.dims[0]:(trace.points?.length??0)
            )
        }
        return parts.join("|")
    }

    /* -----------------------------------------------------------------
       GPU buffer pre-allocation pipeline (scripts/plot2d-gl.js):
       filtering + filling happen in a single traversal, into persistent
       flat Float32Array buffers bound to one BufferGeometry.

       Guarantees, in this order (all inside drawGraph, hence AFTER
       dataBounds/autoDomain/plotScales have settled):
         • the axis transforms (log) and the reference origin are known;
         • the buffers are refilled as soon as the data, the styling, the
           scales OR the identity of the underlying array changed;
         • a one frame watch re-checks the sources so a producer that
           swaps wave.core right after the draw cannot leave a stale
           partial cloud on screen.
      ----------------------------------------------------------------- */
    uploadTracesToGPU(traces){
        if(!this.glLayer){
            return false
        }
        const renderOptions=this.glRenderOptions??GL_RENDER_DEFAULTS
        const sources=this.glSourceIdentity(traces,this.glSourceScratch)
        const signature=this.traceSignature(traces)
        if(signature===this.glSignature&&!this.sourcesChanged(sources)){
            //same data, same styling, same scales, same source arrays
            return false
        }
        this.glSignature=signature
        const logX=this.parameters.axis.bottom.scale==="log"
        const logY=this.parameters.axis.left.scale==="log"
        const reference=this.glReferenceOrigin(logX,logY)
        this.glReference=reference
        //Stick base, expressed in the SAME translated space as the vertices
        //(every Y has already had referenceY subtracted from it), so a plain 0
        //would place the sticks at the wrong height. A log axis has no zero:
        //the sticks stop halfway below the smallest positive datum instead,
        //which keeps them inside the log space.
        let stickBase
        const stickBounds=this.lastDataBounds??this.dataBounds()
        if(logY){
            const yMin=stickBounds?.yMin
            const floor=Number.isFinite(yMin)&&yMin>0?Math.log10(yMin/2):NaN
            stickBase=Number.isFinite(floor)?floor-reference.y:NaN
        }else{
            stickBase=-reference.y
        }
        this.glLayer.upload(this.buildTraceDescriptors(traces),{
            logX,
            logY,
            stickBase,
            referenceX:reference.x,
            referenceY:reference.y
        })
        //remember what was uploaded (identity of every source array)
        this.glUploadedSources=Array.prototype.slice.call(sources)
        this.glUploadedReference={...reference}
        this.scheduleUploadCheck()
        return true
    }

    //identity of the array behind each trace: a producer that replaces
    //wave.core (see Operation.computeOutputs) must not be able to leave the
    //GPU with the previous buffer. O(#traces), never O(#points).
    glSourceIdentity(traces,target=[]){
        let index=0
        for(const trace of traces){
            const wave=trace.wave
            target[index++]=wave?wave.core:(trace.points??null)
        }
        target.length=index
        return target
    }

    //the origin subtracted from the uploaded vertices: the smallest coordinate
    //of the dataset, in the space the GPU works in. Deriving it from the data
    //bounds (not from the axis domain) keeps it stable while the user pans or
    //zooms, so those gestures still need no re-upload at all.
    glReferenceOrigin(logX,logY){
        const renderOptions=this.glRenderOptions??GL_RENDER_DEFAULTS
        const bounds=this.lastDataBounds??this.dataBounds()
        if(!renderOptions.referenceOrigin||!bounds){
            return {x:0,y:0}
        }
        const xMin=logX?(bounds.xMin>0?bounds.xMin:1):bounds.xMin
        const yMin=logY?(bounds.yMin>0?bounds.yMin:1):bounds.yMin
        return {
            x:Number.isFinite(xMin)?(logX?Math.log10(xMin):xMin):0,
            y:Number.isFinite(yMin)?(logY?Math.log10(yMin):yMin):0
        }
    }

    //cheap O(#traces) fingerprint: the GPU buffers are refilled only when the
    //data, the axis transforms or the trace styling actually changed
    traceSignature(traces){
        const reference=this.glReferenceOrigin(
            this.parameters.axis.bottom.scale==="log",
            this.parameters.axis.left.scale==="log"
        )
        const parts=[
            this.glDataRevision??0,
            this.parameters.axis.bottom.scale,
            this.parameters.axis.left.scale,
            reference.x,
            reference.y,
            traces.length
        ]
        for(const trace of traces){
            const options=trace.options??{}
            const marker=options.marker??{}
            const line=options.line??{}
            const wave=trace.wave
            parts.push(
                trace.id??"",
                options.color??"",
                options.mode??"",
                options.layer??"gl",
                marker.shape??"",
                marker.size??"",
                line.size??"",
                wave?(wave.revision??0):0,
                wave?wave.dims[0]:(trace.points?.length??0)
            )
        }
        return parts.join("|")
    }

    //did a producer swap the array behind one of the traces since the upload?
    sourcesChanged(sources){
        const uploaded=this.glUploadedSources
        if(!uploaded||uploaded.length!==sources.length){
            return true
        }
        for(let index=0;index<sources.length;index++){
            if(uploaded[index]!==sources[index]){
                return true
            }
        }
        return false
    }

    /* -----------------------------------------------------------------
       Safety net for the asynchronous producers: Operation.computeOutputs
       (and any worker kernel) can replace wave.core right AFTER a draw
       has already been served. One frame later the sources are compared
       again and, if they moved, the buffers are refilled and repainted,
       so the first display can never stay partial.
      ----------------------------------------------------------------- */
    scheduleUploadCheck(){
        if(this.glCheckFrame!==null&&this.glCheckFrame!==undefined){
            return
        }
        this.glCheckFrame=requestAnimationFrame(()=>{
            this.glCheckFrame=null
            if(!this.glLayer){
                return
            }
            const traces=this.resolveRenderTraces()
            const sources=this.glSourceIdentity(traces,this.glSourceScratch)
            if(!this.sourcesChanged(sources)){
                return
            }
            if((this.glCheckAttempts??0)>=GL_UPLOAD_CHECK_ATTEMPTS){
                console.warn("Plot2DWebGL: the plotted data is still being rewritten; call plot.refresh() once it is final")
                return
            }
            this.glCheckAttempts=(this.glCheckAttempts??0)+1
            //the arrays changed after the draw: refill and repaint immediately
            this.glSignature=null
            this.uploadTracesToGPU(traces)
            this.glLayer?.render()
        })
    }

    //to be called by an asynchronous producer once its data is really final
    refresh(){
        this.invalidateTraces()
        this.drawGraph()
    }

    //the canvas covers exactly the graphzone: the margins stay owned by the SVG
    syncTraceViewport(){
        if(!this.glLayer&&!this.ensureTraceCanvas()){
            return false
        }
        const zone=this.graphzone
        const style=this.traceCanvas.style
        style.left=`${this.parameters.margins.left}px`
        style.top=`${this.parameters.margins.top}px`
        this.glLayer.setViewport(zone.width,zone.height)
        return true
    }

    /* -----------------------------------------------------------------
       Camera: the bounds are read back from the very scales the axes are
       drawn with, so the WebGL layer and the SVG overlay can never drift
       apart. On a log axis both the data and the bounds go through log10,
       which turns the log mapping into the linear mapping the GPU expects.
      ----------------------------------------------------------------- */
    refreshCamera(xScale,yScale){
        if(!this.glLayer) return false
        const logX=this.parameters.axis.bottom.scale==="log"
        const logY=this.parameters.axis.left.scale==="log"
        //the uploaded vertices live in the precision reference frame (see
        //glReferenceOrigin): the camera has to use that same frame
        const reference=this.glReference??{x:0,y:0}
        const leftSource=xScale.invert(0)
        const rightSource=xScale.invert(this.graphzone.width)
        const topSource=yScale.invert(0)
        const bottomSource=yScale.invert(this.graphzone.height)
        return this.glLayer.setBounds({
            left:(logX?Math.log10(leftSource):leftSource)-reference.x,
            right:(logX?Math.log10(rightSource):rightSource)-reference.x,
            top:(logY?Math.log10(topSource):topSource)-reference.y,
            bottom:(logY?Math.log10(bottomSource):bottomSource)-reference.y
        })
    }

    /* -----------------------------------------------------------------
       Render: replaces Plot2D.drawTraces. The D3/SVG implementation is
       kept as a graceful fallback when WebGL is unavailable.
      ----------------------------------------------------------------- */
    drawTraces(xScale,yScale){
        const renderOptions=this.glRenderOptions??GL_RENDER_DEFAULTS
        if(!renderOptions.enabled||(!this.glLayer&&!this.ensureTraceCanvas())){
            super.drawTraces(xScale,yScale)
            return
        }
        /* per trace routing: massive clouds go to the GPU, the traces that must
           stay interactive (DOM events, hit-testing, per point widgets) stay in
           the SVG layer — options.layer = "gl" (default) | "svg" */
        const all=this.resolveRenderTraces()
        const glTraces=[]
        const svgTraces=[]
        for(const trace of all){
            if(trace.options?.layer==="svg"){
                svgTraces.push(trace)
            }else{
                glTraces.push(trace)
            }
        }
        //called even with an empty list, so D3 removes the groups that were
        //just moved over to the canvas
        super.drawTraces(xScale,yScale,svgTraces)
        this.syncTraceViewport()
        this.uploadTracesToGPU(glTraces)
        if(this.refreshCamera(xScale,yScale)){
            this.glRenderer.render(this.glScene,this.glCamera)
        }
        //an explicit draw restarts the retry budget of the upload watch
        this.glCheckAttempts=0
    }

    /* -----------------------------------------------------------------
       Instantaneous resize, driven by the App ResizeObserver pipeline.
       No data loop, no reallocation: setSize, one projection matrix
       update, one render — the GPU does the rest.
      ----------------------------------------------------------------- */
    handleResize(){
        this.resizeTraceLayer()
        //the SVG overlay (axes, ticks, labels) catches up on the next frame,
        //coalesced so a drag-resize cannot redraw it twice within a frame
        if(this.resizeFrame===null){
            this.resizeFrame=requestAnimationFrame(()=>{
                this.resizeFrame=null
                this.drawGraph()
            })
        }
    }

    resizeTraceLayer(){
        if(!this.glLayer) return false
        const {xScale,yScale}=this.plotScales()
        if(!this.syncTraceViewport()) return false
        const ready=this.refreshCamera(xScale,yScale)
        if(ready) this.glRenderer.render(this.glScene,this.glCamera)
        return ready
    }

    setTraces(traces){
        super.setTraces(traces)
        //the data changed: the next draw has to refill the GPU buffers
        this.glDataRevision++
    }

    //for data mutated in place (e.g. a Wasm buffer written by a worker)
    invalidateTraces(){
        this.glDataRevision++
        this.glSignature=null
    }

    glLayerStats(){
        if(!this.glLayer) return null
        return {...this.glLayer.getStats(),uploaded:this.glSignature!==null}
    }

    dispose(){
        if(this.resizeFrame!==null){
            cancelAnimationFrame(this.resizeFrame)
            this.resizeFrame=null
        }
        //a disposed plot must not leave a pending zoom redraw or gesture behind
        if(this.zoomDrawFrame!==null&&this.zoomDrawFrame!==undefined){
            cancelAnimationFrame(this.zoomDrawFrame)
            this.zoomDrawFrame=null
        }
        if(this.zoomGestureTimer!==null&&this.zoomGestureTimer!==undefined){
            clearTimeout(this.zoomGestureTimer)
            this.zoomGestureTimer=null
        }
        this.zoomGestureBefore=null
        if(this.glCheckFrame!==null&&this.glCheckFrame!==undefined){
            cancelAnimationFrame(this.glCheckFrame)
            this.glCheckFrame=null
        }
        this.glLayer?.dispose()
        this.glLayer=null
        this.glRenderer=null
        this.glScene=null
        this.glCamera=null
        this.glPoints=null
        this.glLines=null
        this.glSignature=null
        this.traceCanvas?.remove()
        this.traceCanvas=null
        //a disposed plot keeps working, but through the SVG renderer
        this.glRenderOptions={...GL_RENDER_DEFAULTS,enabled:false}
    }
}

class Table{
    constructor(data,title=null,origin,destination,options={}){
        this.drawn=false
        this.origin=origin;
        this.destination=destination;
        this.onTitleChange=(typeof options?.onTitleChange==="function")?options.onTitleChange:null
        this.parameters={
            mutable:{
                hRuler:options?.mutable?.hRuler??options?.mutable===true??false,
            },
            virtualIndex:{top:0,left:0},
            styles:{
                tables:{
                    "border-spacing":'1px',
                    width:"max-content",
                    "border-collapse":"separate"
                },
                cells:{
                    "text-align": "center",
                    width:"50px",
                    height:"20px"
                },
                lines:{},
                hRuler:{
                    table:{
                        "table-layout":"fixed",
                        "border-spacing":'2px 0px',
                        width:"min-content",
                        "border-collapse":"separate"
                    },
                    cells:{
                        "font-size":"12px",
                        "font-weight":"normal",
                        "width":"50px",
                        "height":"20px",
                        cursor:"auto"
                    },
                    lines:{}
                },
                vRuler:{
                    table:{
                        "table-layout":"fixed",
                        "border-spacing":'1px',
                        width:"max-content",
                        "border-collapse":"separate",
                        cursor:"default"
                    },
                    cells:{
                        "font-size":"12px",
                        "font-weight":"normal",
                        "width":"30px",
                        "height":"20px"
                    },
                    lines:{
                    }
                },
                bTable:{
                    table:{
                        "table-layout":"fixed",
                        "border-spacing":'2px 1px',
                        width:"min-content",
                        "border-collapse":"separate",
                        cursor:"cell",
                        "margin-left":"0px"
                    },
                    cells:{
                        "width":"50px",
                        "height":"20px",
                        "text-align": "center"
                    },
                    lines:{
                    }
                }
            }
        }
        this.setData=data
        this.title=Array.isArray(title)?[...title]:title
        this.container=CE('div',{className:"table container",pilot:this},[]);
        stylize(this.container,{
            position:"relative",
            width:"100%",
            height:"100%",
            overflow:"auto",
            "overflow-anchor":"none",
            "scroll-behavior":"auto",
            "white-space":"nowrap",
        })
        this.destination.appendChild(this.container)
        this.drawVirtual()
        this.container.handleScroll=(e)=>e.target.pilot.onScroll(e);
        this.container.handleResize=(e)=>e.target.pilot.onResize()
        this.resizeObserver=new ResizeObserver(()=>this.scheduleVirtualDraw())
        this.resizeObserver.observe(this.container)
    }
    set setData(arg){
        this.data=arg
        this.parameters.dataDimension={rows:Table.rowNum(arg),cols:Table.colNum(arg)}
    }
    setColumnLabel(columnIndex,value){
        if(!Number.isInteger(columnIndex)||columnIndex<0){
            return
        }
        if(!Array.isArray(this.title)){
            this.title=[]
        }
        while(this.title.length<=columnIndex){
            this.title.push("")
        }
        this.title[columnIndex]=value
        if(typeof this.onTitleChange==="function"){
            this.onTitleChange([...this.title],columnIndex,value)
        }
    }
    columnLabel(columnIndex){
        if(!Array.isArray(this.title)){
            return ""
        }
        return this.title[columnIndex]??""
    }
    onScroll(e){
        this.parameters.virtualIndex.top=Math.floor(
            this.container.scrollTop/
                (parseInt(this.parameters.styles.vRuler.table["border-spacing"]) 
                    + parseInt(this.parameters.styles.vRuler.cells.height)))
        this.parameters.virtualIndex.left=Math.floor(
            (this.container.scrollLeft)/
                (parseInt(this.parameters.styles.hRuler.cells.width) 
                    + 0.5*parseInt(this.parameters.styles.hRuler.table["border-spacing"])))
        const hRulerHeight=this.hRuler.clientHeight
        for(let k=0;k<this.virtualNbCols;k++){this.hRuler.children[0].children[k].textContent=(this.columnLabel(this.parameters.virtualIndex.left+k))}
        if(this.hRuler.clientHeight!=hRulerHeight){console.log("SHIFT !!!");this.onHrulerHeightChange()}
        for(let k=0;k<this.virtualNbCols;k++){this.hRuler.children[1].children[k].textContent=`${this.parameters.virtualIndex.left+k}`}
        for(let j=0;j<this.virtualNbRows;j++){this.vRuler.children[j].children[0].textContent=`${this.parameters.virtualIndex.top+j}`}
        for(let j=0;j<this.virtualNbRows;j++){for(let k=0;k<this.virtualNbCols;k++){this.bTable.children[j].children[k].textContent=`${this.data[this.parameters.virtualIndex.top+j][this.parameters.virtualIndex.left+k]}`}}
        if(this.container.scrollLeft){
            this.vRuler.style.opacity=1
        }else{
            this.vRuler.style.opacity=0.5
        }
        if(this.container.scrollTop){
            this.hRuler.style.opacity=1
        }else{
            this.hRuler.style.opacity=0.5
        }
    }
    onHrulerHeightChange(){
        const h=this.hRuler.clientHeight
        this.vScroller.style.top=`${h}px`
        this.bTable.style.top=`${h}px`
        this.vRuler.style.top=`${h}px`
        this.vRuler=this.virtualvRuler()
        this.container.replaceChild(this.vRuler,this.container.children[3])
        this.bTable=this.virtualTable()
        this.container.replaceChild(this.bTable,this.container.children[4])
    }
    scheduleVirtualDraw(){
        if(this.virtualDrawScheduled){
            return
        }
        this.virtualDrawScheduled=true
        requestAnimationFrame(()=>{
            this.virtualDrawScheduled=false
            this.onResize()
        })
    }
    onResize(){
        if(!this.drawn||!this.container.isConnected){
            return
        }
        this.hRuler=this.virtualhRuler()
        this.container.replaceChild(this.hRuler,this.container.children[1])
        this.vRuler=this.virtualvRuler()
        this.container.replaceChild(this.vRuler,this.container.children[3])
        this.bTable=this.virtualTable()
        this.container.replaceChild(this.bTable,this.container.children[4])
    }
    drawVirtual(){
        if(!this.drawn){
            this.drawn=true
            this.hScroller=this.horizontalScrollWrapper()
            this.container.appendChild(this.hScroller)
            this.hRuler=this.virtualhRuler()
            this.container.appendChild(this.hRuler)
            this.vScroller=this.verticalScrollWrapper()
            this.container.appendChild(this.vScroller)
            this.vRuler=this.virtualvRuler()
            this.container.appendChild(this.vRuler)
            this.bTable=this.virtualTable()
            this.container.appendChild(this.bTable)
        }else{
            this.drawn=false
            while(this.container.children.length){
                console.log(this.container.lastChild)
                this.container.removeChild(this.container.lastChild)
            }
        }
    }
    horizontalScrollWrapper(){
        const width=parseInt(
            this.parameters.styles.vRuler.cells.width)//la largeur de la colonne d'indice verticaux
            + this.parameters.dataDimension.cols*parseInt(this.parameters.styles.cells.width)//le gros des cellules
            + (this.parameters.dataDimension.cols+2)*parseInt(this.parameters.styles.tables["border-spacing"]//leur empatement
            )
        let res=CE('div',{className:"scrollwrapper horizontal"},[""])
        stylize(res,{
            background:"none",
            position:"absolute",
            width:`${width}px`,
            height:"10px",
            top:"0px",
            left:"0px",
            "z-index":"0",
        })
        return res
    }
    verticalScrollWrapper(){
        const height=this.parameters.dataDimension.rows*parseInt(this.parameters.styles.cells.height) 
        + (this.parameters.dataDimension.rows+1)*parseInt(this.parameters.styles.tables["border-spacing"])
        let res=CE('div',{className:"scrollwrapper vertical"},[""])
        stylize(res,{
            background:"none",
            position:"absolute",
            width:"10px",
            height:`${height}px`,
            top:`${this.hRuler.clientHeight}px`,
            left:"0px",
            "z-index":"1"
        })
        return res
    }
    virtualTable(){
        const Dy=this.container.clientHeight-this.hRuler.clientHeight
        const Dx=this.container.clientWidth-this.vRuler.clientWidth
        const nbRows=this.virtualNbRows
        const nbCols=this.virtualNbCols
        let res=CE('table',{className:"table normal",style:this.parameters.styles.bTable.table},[]);
        let aRow=[]
        this.parameters.virtualIndex.top=Math.min(this.parameters.virtualIndex.top,this.parameters.dataDimension.rows-nbRows)
        this.parameters.virtualIndex.left=Math.min(this.parameters.virtualIndex.left,this.parameters.dataDimension.cols-nbCols)
        for(let k=0;k<nbRows;k++){
            aRow=[]
            for(let j=0;j<nbCols;j++){
                aRow.push(CE('td',{className:"normal cell",style:this.parameters.styles.bTable.cells},
                    [(this.data[this.parameters.virtualIndex.top+k][this.parameters.virtualIndex.left+j]).toString()]))
            }
            res.appendChild(CE('tr',{className:"normal line",style:this.parameters.styles.bTable.lines},[...aRow]));
        }
        stylize(res,{
            position:"sticky",
            display:"inline-table",
            left:`${this.vRuler.clientWidth}px`,
            top:`${this.hRuler.clientHeight}px`,
            overflow:"hidden",
            "z-index":"2",
        })
        return res
    }
    virtualvRuler(){
        const Dy=this.container.clientHeight-this.hRuler.clientHeight
        this.virtualNbRows=Math.min(Math.ceil(Dy/(parseInt(this.parameters.styles.vRuler.table["border-spacing"]) + parseInt(this.parameters.styles.vRuler.cells.height))),this.parameters.dataDimension.rows)
        let res=[];
        this.parameters.virtualIndex.top=Math.min(this.parameters.virtualIndex.top,this.parameters.dataDimension.rows-this.virtualNbRows)
        for(let k=0;k<this.virtualNbRows;k++){res.push(CE('tr',{className:"vertical ruler line",style:this.parameters.styles.vRuler.lines},[CE('th',{className:"vertical ruler cell",style:this.parameters.styles.vRuler.cells},[(this.parameters.virtualIndex.top+k).toString()])]))}
        res=CE('table',{className:"table ruler vertical",style:this.parameters.styles.vRuler.table},res)
        stylize(res,{
            "z-index":"3",
            float:"left",
            position:"sticky",
            left:"0px",
            top:`${this.hRuler.clientHeight}px`,
            "display":"inline-block",
        })
        return res
    }
    columnResizer(e){
        e.preventDefault();
        let dx=e.clientX;
        const pilot=e.target.pilot
        document.onmousemove=(e)=>{
            e.preventDefault();
            dx-=e.clientX
            pilot.parameters.styles.cells.width=`${Math.max(5,parseInt(pilot.parameters.styles.cells.width))-dx}px`
            pilot.parameters.styles.hRuler.cells.width=`${Math.max(5,parseInt(pilot.parameters.styles.cells.width))-dx}px`
            pilot.parameters.styles.bTable.cells.width=`${Math.max(5,parseInt(pilot.parameters.styles.cells.width))-dx}px`
            pilot.hScroller=pilot.horizontalScrollWrapper()
            pilot.container.replaceChild(pilot.hScroller,pilot.container.children[0])
            pilot.onResize()
            dx=e.clientX
        }
        document.onmouseup=(e)=>{
            e.preventDefault();
            document.onmouseup=null;
            document.onmousemove=null;
        }
    }
    virtualhRuler(){
        const Dx=this.container.clientWidth-parseInt(this.parameters.styles.vRuler.cells.width)-2*parseInt(this.parameters.styles.tables["border-spacing"])
        this.virtualNbCols=Math.min(Math.ceil(Dx/(parseInt(this.parameters.styles.hRuler.cells.width)+parseInt(this.parameters.styles.hRuler.table["border-spacing"]))),this.parameters.dataDimension.cols)
        this.parameters.virtualIndex.left=Math.min(this.parameters.virtualIndex.left,this.parameters.dataDimension.cols-this.virtualNbCols)
        let titleLine=[]//[CE('th',{className:"horizontal title cell",style:this.parameters.styles.vRuler.cells},[""])];
        let rulerLine=[]//[CE('th',{className:"horizontal ruler cell",style:this.parameters.styles.vRuler.cells},[""])];
        const leftGap=parseInt(this.parameters.styles.vRuler.cells.width)+2*parseInt(this.parameters.styles.vRuler.table['border-spacing'])
        for(let k=0;k<this.virtualNbCols;k++){
            rulerLine.push(CE('th',{className:"horizontal ruler cell",pilot:this,handleMouseDown:(e)=>{e.target.pilot.columnResizer(e)},style:this.parameters.styles.hRuler.cells},[(this.parameters.virtualIndex.left+k).toString()]));
            titleLine.push(CE('th',{className:"horizontal title cell",style:this.parameters.styles.hRuler.cells},[this.columnLabel(this.parameters.virtualIndex.left+k)]));
            rulerLine[k].style["cursor"]="col-resize"
            if(this.parameters.mutable.hRuler){
                titleLine[k].style["cursor"]="auto"
                titleLine[k].setAttribute("contenteditable","true")
                titleLine[k].pilot=this
                titleLine[k].handleInput=(e)=>{
                    const columnIndex=e.target.cellIndex+Number(e.target.pilot.parameters.virtualIndex.left||0)
                    e.target.pilot.setColumnLabel(columnIndex,e.target.textContent)
                }
                titleLine[k].handleKeyDown=(e)=>{
                    if(e.key=="Enter"){
                        e.target.blur()
                    }
                }
            }
        }
        let res=CE('table',{className:"table ruler horizontal",style:this.parameters.styles.hRuler.table},[
            CE('tr',{className:"horizontal title line",style:this.parameters.styles.hRuler.lines},titleLine),
            CE('tr',{className:"horizontal ruler line",style:this.parameters.styles.hRuler.lines},rulerLine)
        ])
        stylize(res,{
            position:"sticky",
            top:"0px",
            left:`${leftGap}px`,
            "z-index":"4",
        })
        res.children[1].style["cursor"]="col-resize"
        return res
    }
    static bareTable(data){
        self=this
        let res=CE('table',{className:"table normal"},[]);
        let line=[];
        for(let k of data){
            line=[];
            k.forEach((v)=>{line.push(CE('td',{className:"normal cell"},[v.toString()]))})
            res.appendChild(CE('tr',{className:"normal line"},[...line]));
        }
        return res
    }
    horizontalRuler(n,title){
        let titleLine=[CE('th',{className:"horizontal title cell",style:{width:this.parameters.cellWidth}},[""])];
        let rulerLine=[CE('th',{className:"horizontal ruler cell",style:{width:this.parameters.cellWidth}},[""])];
        for(let k=0;k<n;k++){
            rulerLine.push(CE('th',{className:"horizontal ruler cell",style:{width:this.parameters.cellWidth}},[k.toString()]));
            titleLine.push(CE('th',{className:"horizontal title cell",style:{width:this.parameters.cellWidth}},[title[k]===undefined ? "" : title[k]]));
        }
        return CE('table',{className:"table ruler horizontal"},[CE('tr',{className:"horizontal title line"},titleLine),CE('tr',{className:"horizontal ruler line"},rulerLine)])
    }
    verticalRuler(n){
        let res=[];
        for(let k=0;k<n;k++){res.push(CE('tr',{className:"vertical ruler line"},[CE('th',{className:"vertical ruler cell",style:{width:this.parameters.cellWidth}},[k.toString()])]))}
        return CE('table',{className:"table ruler vertical"},res)
    }
    fillNormalColumns(vec){
        let res=[];
        if(!vec){return res}
        for(let k of vec){
            res.push(CE('td',{className:"normal cell"},[k.toString()]))
        }
        return res
    }
    dispose(){
        this.resizeObserver?.disconnect()
        this.container.remove()
    }
    static colNum(data){
        let res=0
        data.forEach((v)=>{res=Math.max(res,v.length)})
        return res
    }
    static rowNum(data){
        return data.length
    }
}

class Dialog{
    static zIndex=1
    constructor(title,origin,destination){
        this.title=title
        this.events={
            broadcast:{
                selected:new CustomEvent("selected",{detail:{msg:"I've just been selected !!!",emitter:this}}),
                killed:new CustomEvent("killed",{detail:{msg:"",emitter:this}}),
            },
            listen:{
                selected(e){
                    console.log(e.detail.emitter.title+" a reçu le focus")
                },
                killed(e){console.log("quelqu'un s'est fait tué !\n","il s'appelait ",e.detail.emitter.events.registrationId)},
                importDelimitedText(e){console.log(e)}
            }
        }
        this.origin=origin;
        this.destination=destination;
        this.DOMelt={};
        this.DOMelt.dismisser=CE('div',{className:"dismisser",pilot:this},[]);
        this.DOMelt.dismisser.handleClick=(e)=>e.target.pilot.suicide();
        this.DOMelt.folder=CE('div',{className:"accordion handler folder",pilot:this,handleClick:(e)=>e.target.pilot.toggleFolded()},[]);
        this.DOMelt.folder.setAttribute("role","button");
        this.DOMelt.folder.setAttribute("aria-expanded","true");
        this.DOMelt.folder.setAttribute("aria-label","Replier la fenêtre");
        this.DOMelt.label=CE('div',{className:"label",pilot:this,handleDblClick:(e)=>e.target.pilot.toggleMaximized(e)},[title.toString()]);
        this.DOMelt.label.handleMouseDown=(e)=>e.target.pilot.drag(e);
        this.DOMelt.label.handleClick=(e)=>this.focus(e)
        this.DOMelt.handler=CE('div',{},[this.DOMelt.label,this.DOMelt.folder,this.DOMelt.dismisser]);
        this.DOMelt.content=CE('div',{className:"popup content"},[]);
        this.DOMelt.window=CE('div',{className:"popup container",pilot:this},[
            this.DOMelt.handler,
            this.DOMelt.content
        ]);
        stylize(this.DOMelt.window,{
            position:"absolute",
            "z-index":"1",
            tabIndex:0,
            top:"35%",
            left:"35%",
            width:"30%",
            height:"30%",
            display:"grid",
            "grid-template-rows":"auto 1fr",
            padding:"0.2em",
            overflow:"hidden",
            resize:"both",
            "min-height":"2.2em",
            "min-width":"2.2em"
        });
        stylize(this.DOMelt.handler,{
            display:"grid",
            "grid-template-columns":"1fr 1em 1em",
            "border-radius":"10px",
            padding:"0em"
        })
        stylize(this.DOMelt.content,{
            position:"relative",
            width:"100%",
            height:"100%",
            "border-radius":"10px",
            padding:"0em",
            overflow:"hidden"
        })
        stylize(this.DOMelt.label,{
            cursor:"move",
            //padding:"0em",
            "white-space":"nowrap",
            overflow:"hidden"
        })
        stylize(this.DOMelt.dismisser,{
            height:"1em",
            width:"1em",
            "align-self":"center"
        })
        stylize(this.DOMelt.folder,{
            height:"1em",
            width:"1em",
            "align-self":"center"
        })
        this.DOMelt.window.handleResize=(e)=>e.target.pilot.resize(e)
        this.DOMelt.window.handleMouseDown=(e)=>this.focus(e)
        destination.appendChild(this.DOMelt.window)
        this.DOMelt.window.setAttribute("tabindex","0")
        this.DOMelt.window.setAttribute("role","dialog")
        this.DOMelt.window.setAttribute("aria-label",title.toString())
        this.DOMelt.window.handleFocus=(e)=>this.focus(e)
        this.focus()
    }
    focus(event){
        if(Dialog.focused!==this){
            Dialog.focused?.DOMelt.window.classList.remove("selected")
            Dialog.focused=this
        }
        this.DOMelt.window.classList.add("selected")
        this.DOMelt.window.style.zIndex=String(++Dialog.zIndex)
        if(event||!this.DOMelt.window.contains(document.activeElement)){
            dispatchEvent(this.events.broadcast.selected)
        }
    }
    blur(){
        if(Dialog.focused!==this) return
        this.DOMelt.window.classList.remove("selected")
        Dialog.focused=null
    }
    setFolderFoldedState(folded){
        this.DOMelt.folder.style.backgroundColor=folded?"transparent":"rgba(172,255,47,0.18)"
        this.DOMelt.folder.setAttribute("aria-expanded",folded?"false":"true")
        this.DOMelt.folder.setAttribute("aria-label",folded?"Déplier la fenêtre":"Replier la fenêtre")
    }
    fold(){
        if(this.folded) return
        this.folded=true
        const windowStyle=this.DOMelt.window.style
        this.unfoldedSize={
            height:windowStyle.height,
            minHeight:windowStyle.minHeight,
            resize:windowStyle.resize,
            bottom:windowStyle.bottom
        }
        this.DOMelt.content.hidden=true
        this.DOMelt.window.classList.add("folded")
        windowStyle.height="auto"
        windowStyle.minHeight="0"
        //A dragged dialog has both top and bottom. Keeping bottom would
        //stretch the folded dialog back to its full previous height.
        windowStyle.bottom="auto"
        windowStyle.resize="none"
        this.setFolderFoldedState(true)
    }
    unfold(){
        if(!this.folded) return
        this.folded=false
        const windowStyle=this.DOMelt.window.style
        this.DOMelt.content.hidden=false
        this.DOMelt.window.classList.remove("folded")
        windowStyle.height=this.unfoldedSize.height
        windowStyle.minHeight=this.unfoldedSize.minHeight
        windowStyle.bottom=this.unfoldedSize.bottom
        windowStyle.resize=this.unfoldedSize.resize
        this.setFolderFoldedState(false)
    }
    toggleFolded(){
        if(this.folded){
            this.unfold()
        }else{
            this.fold()
        }
    }
    toggleMaximized(event){
        event.preventDefault()
        event.stopPropagation()
        const windowStyle=this.DOMelt.window.style
        if(!this.maximized){
            this.preMaximizeState={
                folded:Boolean(this.folded),
                styles:{
                    top:windowStyle.top,
                    right:windowStyle.right,
                    bottom:windowStyle.bottom,
                    left:windowStyle.left,
                    width:windowStyle.width,
                    height:windowStyle.height,
                    minWidth:windowStyle.minWidth,
                    minHeight:windowStyle.minHeight,
                    resize:windowStyle.resize
                }
            }
            if(this.folded) this.unfold()
            this.maximized=true
            this.DOMelt.window.classList.add("maximized")
            windowStyle.top="0px"
            windowStyle.left="0px"
            windowStyle.width="100%"
            windowStyle.height="100%"
            windowStyle.right="auto"
            windowStyle.bottom="auto"
            windowStyle.minWidth="0"
            windowStyle.minHeight="0"
            windowStyle.resize="none"
            this.DOMelt.folder.setAttribute("aria-label","Restaurer la fenêtre")
        }else{
            this.maximized=false
            this.DOMelt.window.classList.remove("maximized")
            const saved=this.preMaximizeState
            for(const [property,value] of Object.entries(saved.styles)){
                windowStyle[property]=value
            }
            if(saved.folded){
                this.DOMelt.content.hidden=true
                this.DOMelt.window.classList.add("folded")
                this.folded=true
                this.setFolderFoldedState(true)
            }else{
                this.folded=false
                this.setFolderFoldedState(false)
            }
        }
    }
    suicide(){
        this.DOMelt.window.remove()
        dispatchEvent(this.events.broadcast.killed)
    }
    drag(e){
        const boundary={
            width:this.destination.offsetWidth,
            height:this.destination.offsetHeight
        }
        e.preventDefault();
        let dx=e.clientX;
        let dy=e.clientY;
        const pilot=e.target.pilot
        document.onmousemove=(e)=>{
            e.preventDefault();
            dx-=e.clientX;
            dy-=e.clientY;
            let gap={
                left:pilot.DOMelt.window.offsetLeft-dx,
                right:boundary.width-(pilot.DOMelt.window.offsetLeft-dx+pilot.DOMelt.window.offsetWidth),
                top:pilot.DOMelt.window.offsetTop-dy,
                bottom:boundary.height-(pilot.DOMelt.window.offsetTop-dy+pilot.DOMelt.window.offsetHeight)
            }
            if(gap.left>=0 && gap.right>=0){
                pilot.DOMelt.window.style.left=`${100*gap.left/boundary.width}%`;
                pilot.DOMelt.window.style.right=`${100*gap.right/boundary.width}%`;
            }
            if(gap.top>=0 && gap.bottom>=0){
                pilot.DOMelt.window.style.top=`${100*gap.top/boundary.height}%`;
                if(!pilot.folded){
                    pilot.DOMelt.window.style.bottom=`${100*gap.bottom/boundary.height}%`;
                }
            }
            dx=e.clientX;
            dy=e.clientY;
        }
        document.onmouseup=(e)=>{
            e.preventDefault();
            document.onmousemove=null;
            document.onmouseup=null;
        }
    }
    resize(e){
        if(this.folded) return
        //console.log(e.target)
        let gap={
            left:e.target.offsetLeft,
            right:e.target.pilot.destination.offsetWidth-(e.target.offsetLeft+e.target.offsetWidth),
            top:e.target.offsetTop,
            bottom:e.target.pilot.destination.offsetHeight-(e.target.offsetTop+e.target.offsetHeight)
        }
        e.target.style.left=`${100*(Math.max(gap.left,0)/e.target.pilot.destination.offsetWidth)}%`;
        e.target.style.right=`${100*(Math.max(gap.right,0)/e.target.pilot.destination.offsetWidth)}%`;
        e.target.style.top=`${100*(Math.max(gap.top,0)/e.target.pilot.destination.offsetHeight)}%`;
        e.target.style.bottom=`${100*(Math.max(gap.bottom,0)/e.target.pilot.destination.offsetHeight)}%`;
        if(gap.bottom<1 || gap.right){
            e.target.style.height="";
            e.target.style.width="";
        }
    }
}

class Accordion{
    constructor(title,origin,destination){
        this.title=title
        this.origin=origin
        this.destination=destination
        this.parameters={
            container:{
                folded:false,
                style:{
                    display:"grid",
                    width:"100%",
                    border:"0px solid black",
                    padding:"1px",
                    "grid-template-rows":"auto minmax(0, 1fr)",
                    transition:"300ms"
                }
            },
            handler:{
                text:title,
                style:{
                    display:"grid",
                    width:"100%",
                    border:"1px solid black",
                    "border-radius":"5px",
                    padding:"0px",
                    "grid-template-columns":"1em 1fr 1em",
                    "margin-bottom":"1px",
                    transition:"none"
                }
            },
            content:{
                style:{
                    width:"100%",
                    border:"1px solid black",
                    padding:"0px",
                    transition:"30ms",
                    overflow:"hidden",
                    transition:"300ms"
                }
            }
        };
        this.DOMelt={
            folder:CE('div',{className:"accordion handler folder",pilot:this,handleClick:(e)=>e.target.pilot.toggle()},[]),
            handler:CE('div',{className:"accordion handler"},[
                CE('div',{className:"accordion handler menu"},[]),
                CE('div',{className:"accordion handler label"},[title]),
            ]),
            content:CE('div',{className:"accordion content"},[]),
        }
        this.DOMelt.handler.appendChild(this.DOMelt.folder)
        this.DOMelt.container=CE('div',{className:"accordion container"},[this.DOMelt.handler,this.DOMelt.content]);
        stylize(this.DOMelt.container,this.parameters.container.style);
        stylize(this.DOMelt.handler,this.parameters.handler.style);
        stylize(this.DOMelt.content,this.parameters.content.style);
        this.destination.appendChild(this.DOMelt.container)
        this.setSizingMode("content")
    }
    setSizingMode(mode,{height=null}={}){
        if(!["content","viewport"].includes(mode)){
            throw new Error(`Unknown accordion sizing mode: ${mode}`)
        }
        this.parameters.sizing=mode
        this.parameters.viewportHeight=height
        this.DOMelt.container.classList.toggle("sizing-content",mode==="content")
        this.DOMelt.container.classList.toggle("sizing-viewport",mode==="viewport")
        this.DOMelt.content.classList.toggle("sizing-content",mode==="content")
        this.DOMelt.content.classList.toggle("sizing-viewport",mode==="viewport")
        this.DOMelt.container.style.height=mode==="viewport"&&Number.isFinite(height)?`${height}px`:""
        this.DOMelt.content.style.display=mode==="viewport"?"grid":"block"
        this.DOMelt.content.style.height=mode==="viewport"?"100%":"auto"
        this.DOMelt.content.style.overflow=mode==="viewport"?"hidden":"visible"
        if(this.parameters.folded){
            this.DOMelt.container.style.height=""
            //display:none, not visibility:hidden: a collapsed accordion must
            //occupy NO row at all. visibility kept the box in the flow, and the
            //grid child (graph wrapper, min-height:180px) kept pushing the
            //collapsed row open, leaving a visible gap between accordions.
            //The plot gets a single transient resize on unfold, not a loop.
            this.DOMelt.content.style.display="none"
        }
    }
    fold(){
        this.parameters.folded=true
        this.DOMelt.container.style.height=""
        this.DOMelt.container.style["grid-template-rows"]="auto 0fr"
        //out of the flow entirely: a collapsed accordion takes no room and
        //cannot leak its absolutely positioned layers (WebGL canvas z-index:-1)
        this.DOMelt.content.style.display="none"
        this.DOMelt.content.style.border="0px solid black"
        this.DOMelt.handler.style["margin-bottom"]="0px"
        this.DOMelt.folder.style["background-color"]="transparent"
    }
    unfold(){
        this.parameters.folded=false
        this.DOMelt.container.style["grid-template-rows"]="auto 1fr"
        this.DOMelt.container.style.height=this.parameters.sizing==="viewport"&&Number.isFinite(this.parameters.viewportHeight)?`${this.parameters.viewportHeight}px`:""
        this.DOMelt.content.style.height=this.parameters.sizing==="viewport"?"100%":"auto"
        this.DOMelt.content.style.overflow=this.parameters.sizing==="viewport"?"hidden":"visible"
        this.DOMelt.content.style.display=this.parameters.sizing==="viewport"?"grid":"block"
        this.DOMelt.content.style.border="1px solid black"
        this.DOMelt.handler.style["margin-bottom"]="1px"
        this.DOMelt.folder.style["background-color"]="rgba(172,255,47,0.18)"
    }
    toggle(){
        if(this.parameters.folded){
            this.unfold();
        }else{
            this.fold();
        }
    }
    suicide(){
        this.DOMelt.container.remove()
        if(this.events?.broadcast?.killed){
            dispatchEvent(this.events.broadcast.killed)
        }
    }
}

class App{
    constructor(){
        this.channel=new Channel(this)
        this.history=new History()
        this.parameters={
            topContent:{
                folded: false,
                height:125,
            },
            botContent:{
                folded: false,
                height:100,
                
            },
            leftContent:{
                folded:false,
                width:250,
            },
            rightContent:{
                folded:false,
                width:250,
            }
        }
        this.topContent=[
            CE('div',{id:"topContent", className:"horizontal content"},[
                "",
                CE('div',{height:"200px",width:"100px",border:"1px solid black",color:'red'},[""])/*,
                CE('button',{pilot:this,handleClick:(e)=>{
                    e.target.pilot.channel.register("choco",new Dialog("choco",e.target.pilot,e.target.pilot.main))
                    e.target.pilot.tata=new Table(fakeData(10),["ttl","an other","a third","anotheronetocheckeverythingis ok","and a last one that is super long !"],e.target.pilot,e.target.pilot.channel.get("choco").DOMelt.content)
                }},[" Please click here for a table test"]),
                CE('button',{pilot:this,handleClick:(e)=>{
                    e.target.pilot.channel.register("lata",new Dialog("lata",e.target.pilot,e.target.pilot.midCentralContent))
                    e.target.pilot.yoyo=new Plot2D([],"yoyo",e.target.pilot,e.target.pilot.channel.get("lata").DOMelt.content)
                }},[" Please click here for a graph test"])*/
            ])
        ]
        this.flowWorkspace=CE('div',{className:"flow workspace"},[])
        this.topContent[0].appendChild(this.flowWorkspace)
        this.midCentralContent=CE('div',{className:"vertical center content"},[
            ""
        ])
        this.midContent=[
            CE('div',{id:"left",className:"vertical left panel"},[
                CE('div',{className:"vertical left content"},[""])
            ]),
            CE('div',{id:"leftSeptum", className:"left septum vertical"},[
                CE('div',{className:"vertical resizer",pilot:this,handleMouseDown:(e)=>e.target.pilot.resizerHookLeft(e)},[]),
                CE('div',{className:"vertical wrapper",pilot:this,handleClick:(e)=>{e.target.pilot.foldLeft(!e.target.pilot.parameters.leftContent.folded)}},[]),
                CE('div',{className:"vertical resizer",pilot:this,handleMouseDown:(e)=>e.target.pilot.resizerHookLeft(e)},[])
            ]),
            CE('div',{id:"center",className:"vertical center panel"},[
                this.midCentralContent
            ]),
            CE('div',{id:"rightSeptum", className:"right septum vertical"},[
                CE('div',{className:"vertical resizer",pilot:this,handleMouseDown:(e)=>e.target.pilot.resizerHookRight(e)},[]),
                CE('div',{className:"vertical wrapper",pilot:this,handleClick:(e)=>{e.target.pilot.foldRight(!e.target.pilot.parameters.rightContent.folded)}},[]),
                CE('div',{className:"vertical resizer",pilot:this,handleMouseDown:(e)=>e.target.pilot.resizerHookRight(e)},[])
            ]),
            CE('div',{id:"right",className:"vertical right panel"},[
                CE('div',{className:"vertical right content"},[""])
            ])
        ]
        this.botContent=[
            CE('div',{id:"botContent", className:"horizontal content"},[
                ""
            ])
        ]
        this.menu=CE('div',{id:"mainMenu",className:"menu"},[])
        this.top=CE('div',{id:"top",className:"horizontal top panel"},this.topContent)
        this.topSeptum=CE('div',{id:"topSeptum",className:"top horizontal septum"},[
            CE('div',{className:"horizontal resizer",pilot:this,handleMouseDown:(e)=>e.target.pilot.resizerHookTop(e)},[]),
            CE('div',{className:"horizontal wrapper",pilot:this,handleClick:(e)=>{e.target.pilot.foldTop(!e.target.pilot.parameters.topContent.folded)}},[]),
            CE('div',{className:"horizontal resizer",pilot:this,handleMouseDown:(e)=>e.target.pilot.resizerHookTop(e)},[])
        ])
        this.mid=CE('div',{id:"mid",className:"horizontal mid panel"},this.midContent)
        this.botSeptum=CE('div',{id:"botSeptum",className:"bot horizontal septum"},[
            CE('div',{className:"horizontal resizer",pilot:this,handleMouseDown:(e)=>e.target.pilot.resizerHookBot(e)},[]),
            CE('div',{className:"horizontal wrapper",pilot:this,handleClick:(e)=>{e.target.pilot.foldBot(!e.target.pilot.parameters.botContent.folded)}},[]),
            CE('div',{className:"horizontal resizer",pilot:this,handleMouseDown:(e)=>e.target.pilot.resizerHookBot(e)},[])
        ])
        this.bot=CE('div',{id:"bot",className:"horizontal bot panel"},this.botContent)
        this.mainInterface=CE('div',{id:"mainInterface", className:"container"},[
            this.top,
            this.topSeptum,
            this.mid,
            this.botSeptum,
            this.bot
        ])
        this.main=CE('div',{id:"main",className:"app"},[
            this.menu,
            this.mainInterface
        ])

        this.setupOnWindow()
        /*
        this.channel.register("Data manager",new Accordion("Data manager",this,$(".vertical.left.content")))
        this.channel.get('Data manager').toggle()
        this.channel.get('Data manager').DOMelt.content.appendChild(
            CE('div',{},["test",CE('div',{id:"Gloubidi",style:{height:"300px"}},[])])
        )
        */
        this.channel.register("mainMenu",new MainMenu(defaultMenu.mainMenu,"mainMenu",this,this.menu))
        this.channel.register("mainFlowMenu",new MainFlowMenu(defaultMenu.mainFlowMenu,"mainFlowMenu",this,this.flowWorkspace))
        this.channel.register("mainFlow",new Flow("mainFlow",this,this.flowWorkspace))
        /*
        this.channel.register('node',new Node('Node with no inputs',[],[[0],[0],[0]],this,this.channel.get('mainFlow')), 'Node with no inputs')
        this.channel.register('node', new NodeWithAccordion('Filter node',[{}],[{}],this,this.channel.get('mainFlow'),{x:200,y:10}), 'Filter node')
        this.channel.register('node', new Node('Display node',[{}],[],this,this.channel.get('mainFlow'),{x:400,y:10}), 'Display node')
        */
    }
    foldTop(v){
        if(v){
            this.parameters.topContent.folded=true;
            this.mainInterface.style["grid-template-rows"]=`0px 5px 1fr 5px ${this.parameters.botContent.height*(!this.parameters.botContent.folded)}px`
        }else{
            this.parameters.topContent.folded=false;
            this.mainInterface.style["grid-template-rows"]=`${this.parameters.topContent.height}px 5px 1fr 5px ${this.parameters.botContent.height*(!this.parameters.botContent.folded)}px`
        }
    }
    resizeHeightTop(v){
        this.parameters.topContent.height=v
        this.mainInterface.style["grid-template-rows"]=`${v}px 5px 1fr 5px ${this.parameters.botContent.height*(!this.parameters.botContent.folded)}px`
    }
    resizerHookTop(e){
        e.preventDefault();
        let dy=e.clientY;
        const pilot=e.target.pilot
        document.onmousemove=(e)=>{
            pilot.mainInterface.style.transition="0ms";
            pilot.resizeHeightTop(pilot.parameters.topContent.height-dy+e.clientY);
            dy=e.clientY;
        }
        document.onmouseup=(e)=>{
            document.onmousemove=null;
            document.onmouseup=null;
            pilot.mainInterface.style.transition="300ms";
        }
    }
    foldBot(v){
        if(v){
            this.parameters.botContent.folded=true;
            this.mainInterface.style["grid-template-rows"]=`${this.parameters.topContent.height*(!this.parameters.topContent.folded)}px 5px 1fr 5px 0px`
        }else{
            this.parameters.botContent.folded=false;
            this.mainInterface.style["grid-template-rows"]=`${this.parameters.topContent.height*(!this.parameters.topContent.folded)}px 5px 1fr 5px ${this.parameters.botContent.height}px`
        }
    }
    resizeHeightBot(v){
        this.parameters.botContent.height=v;
        this.mainInterface.style["grid-template-rows"]=`${this.parameters.topContent.height*(!this.parameters.topContent.folded)}px 5px 1fr 5px ${v}px`
    }
    resizerHookBot(e){
        e.preventDefault();
        let dy=e.clientY;
        const pilot=e.target.pilot
        document.onmousemove=(e)=>{
            pilot.mainInterface.style.transition="0ms";
            pilot.resizeHeightBot(pilot.parameters.botContent.height+dy-e.clientY)
            dy=e.clientY;
        }
        document.onmouseup=(e)=>{
            document.onmousemove=null;
            document.onmouseup=null;
            pilot.mainInterface.style.transition="300ms";
        }
    }
    foldLeft(v){
        if(v){
            this.parameters.leftContent.folded=true;
            this.mid.style["grid-template-columns"]=`0px 5px 1fr 5px ${this.parameters.rightContent.width*(!this.parameters.rightContent.folded)}px`
        }else{
            this.parameters.leftContent.folded=false;
            this.mid.style["grid-template-columns"]=`${this.parameters.leftContent.width}px 5px 1fr 5px ${this.parameters.rightContent.width*(!this.parameters.rightContent.folded)}px`
        }
    }
    resizeWidthLeft(v){
        this.parameters.leftContent.width=v;
        this.mid.style["grid-template-columns"]=`${v}px 5px 1fr 5px ${this.parameters.rightContent.width*(!this.parameters.rightContent.folded)}px`
    }
    resizerHookLeft(e){
        e.preventDefault();
        let dx=e.clientX;
        const pilot=e.target.pilot
        document.onmousemove=(e)=>{
            pilot.mid.style.transition="0ms";
            pilot.resizeWidthLeft(pilot.parameters.leftContent.width-dx+e.clientX);
            dx=e.clientX;
        }
        document.onmouseup=(e)=>{
            document.onmousemove=null;
            document.onmouseup=null;
            pilot.mid.style.transition="300ms";
        }
    }
    foldRight(v){
        if(v){
            this.parameters.rightContent.folded=true;
            this.mid.style["grid-template-columns"]=`${this.parameters.leftContent.width*(!this.parameters.leftContent.folded)}px 5px 1fr 5px 0px`
        }else{
            this.parameters.rightContent.folded=false;
            this.mid.style["grid-template-columns"]=`${this.parameters.leftContent.width*(!this.parameters.leftContent.folded)}px 5px 1fr 5px ${this.parameters.rightContent.width}px`
        }
    }
    resizeWidthRight(v){
        this.parameters.rightContent.width=v;
        this.mid.style["grid-template-columns"]=`${this.parameters.leftContent.width*(!this.parameters.leftContent.folded)}px 5px 1fr 5px ${v}px`
    }
    resizerHookRight(e){
        e.preventDefault();
        let dx=e.clientX;
        const pilot=e.target.pilot
        document.onmousemove=(e)=>{
            pilot.mid.style.transition="0ms";
            pilot.resizeWidthRight(pilot.parameters.rightContent.width+dx-e.clientX)
            dx=e.clientX;
        }
        document.onmouseup=(e)=>{
            document.onmousemove=null;
            document.onmouseup=null;
            pilot.mid.style.transition="300ms";
        }
    }
    applyPanelParameters(){
        const p=this.parameters
        if(!p?.topContent||!p?.botContent||!p?.leftContent||!p?.rightContent){
            return
        }
        //apply the saved layout (fold states and sizes) without animation
        this.mainInterface.style.transition="0ms"
        this.mid.style.transition="0ms"
        this.foldTop(Boolean(p.topContent.folded))
        if(!p.topContent.folded&&typeof p.topContent.height==="number"){
            this.resizeHeightTop(p.topContent.height)
        }
        this.foldBot(Boolean(p.botContent.folded))
        if(!p.botContent.folded&&typeof p.botContent.height==="number"){
            this.resizeHeightBot(p.botContent.height)
        }
        this.foldLeft(Boolean(p.leftContent.folded))
        if(!p.leftContent.folded&&typeof p.leftContent.width==="number"){
            this.resizeWidthLeft(p.leftContent.width)
        }
        this.foldRight(Boolean(p.rightContent.folded))
        if(!p.rightContent.folded&&typeof p.rightContent.width==="number"){
            this.resizeWidthRight(p.rightContent.width)
        }
        this.mainInterface.style.transition="300ms"
        this.mid.style.transition="300ms"
    }
    setupOnWindow(destination='body'){
        this.destination=destination;
        $(this.destination).appendChild(this.main);
        this.main.addEventListener('click',(e)=>{
            //console.log(e.target)
            if(e.target.handleClick){e.target.handleClick(e)}
        })
        this.main.addEventListener('dblclick',(e)=>{
            if(e.target.handleDblClick){e.target.handleDblClick(e)}
        })
        this.main.addEventListener('mousedown',(e)=>{
            const dialog=e.target.closest?.(".popup.container")
            if(!dialog){
                Dialog.focused?.blur()
            }
            let target=e.target
            while(target&&target!==this.main&&!target.handleMouseDown){
                target=target.parentElement
            }
            if(target?.handleMouseDown){target.handleMouseDown(e)}
        })
        this.main.addEventListener('mouseup',function(e){
            if(e.target.handleMouseUp){e.target.handleMouseUp(e)}
        })
        this.main.addEventListener('keydown',(e)=>{
            if((e.ctrlKey||e.metaKey)&&e.key.toLowerCase()==="z"){
                e.preventDefault()
                if(e.shiftKey){
                    this.history.redo()
                }else{
                    this.history.undo()
                }
                return
            }
            if((e.ctrlKey||e.metaKey)&&e.key.toLowerCase()==="y"){
                e.preventDefault()
                this.history.redo()
                return
            }
            if(e.target.handleKeyDown){e.target.handleKeyDown(e)}
        })
        this.main.addEventListener('blur',(e)=>{
            if(e.target.handleBlur){e.target.handleBlur(e)}
        },true)
        this.main.addEventListener('focusin',(e)=>{
            let target=e.target
            while(target&&target!==this.main&&!target.handleFocus){
                target=target.parentElement
            }
            if(target?.handleFocus){target.handleFocus(e)}
        })
        this.main.addEventListener('input',(e)=>{
            if(e.target.handleInput){e.target.handleInput(e)}
        })
        this.main.addEventListener('scroll',(e)=>{
            if(e.target.handleScroll){e.target.handleScroll(e)}
        },true)
        this.main.addEventListener('change',(e)=>{
            if(e.target.handleChange){e.target.handleChange(e)}
        })
        this.main.addEventListener('contextmenu',(e)=>{
            if(e.target.handleContextmenu){e.target.handleContextmenu(e)}
        })
        const observeResizeHandlers=(elt,obs)=>{
            if(elt.handleResize){
                obs.observe(elt)
            }
            for(let child of elt.children){
                observeResizeHandlers(child,obs)
            }
        }
        this.resizeObserver=new ResizeObserver((entries)=>{
            for(const entry of entries){
                entry.target.handleResize?.(entry)
            }
        })
        this.mutObserver=new MutationObserver((mutationsList)=>{
            for(const mutation of mutationsList){
                for(const node of mutation.addedNodes){
                    if(node.nodeType===1){
                        observeResizeHandlers(node,this.resizeObserver)
                    }
                }
            }
        })
        observeResizeHandlers(this.main,this.resizeObserver)
        this.mutObserver.observe(this.main,{childList:true,subtree:true})
    }
    msConvert(){
        let message="Server is ready"
        const sendToServer=(fileList)=>{
            let fileNumber=0
            for(let file of fileList){
                fileNumber++
                requestPOST('https://attributor.fr/uploads',file,(data)=>{
                    for(let item of senderContainer.children[2].children){
                        if(item.textContent==file.name){
                            let textFileName=file.name.replace('.raw','.txt')
                            item.lastChild.remove()
                            item.appendChild(
                                CE('button',{style:{"margin-left":"10px"},
                                handleClick:(e)=>{
                                    window.location.href=`https://attributor.fr/uploads/outputs/${textFileName}`
                                }
                                },["Download "+textFileName])
                            )
                            fileNumber--
                            if(fileNumber==0){
                                senderContainer.lastChild.textContent="Files ready to download"
                            }
                        }
                    }
                })
            }
        }
        let sendList=CE('div',{style:{height:"100%"}},["Files to be sent to server:"])
        let selectedFiles=[]
        const addFileSendList=(files)=>{
            selectedFiles=files
            sendList.replaceChildren()
            sendCommand.firstChild.disabled=false
            for(let file of files){
                sendList.appendChild(CE('div',{style:{"margin-bottom":"1px"}},[file.name]))
            }
        }
        let msConvertDialog=new Dialog("Send .raw to a server for conversion",this,this.main)
        const dropzone=CE('div',{className:"dropzone"},["Drop .raw files here"])
        dropzone.addEventListener("dragover",(e)=>{
            e.preventDefault()
            dropzone.classList.add("dragover")
        })
        dropzone.addEventListener("dragleave",()=>{
            dropzone.classList.remove("dragover")
        })
        dropzone.addEventListener("drop",(e)=>{
            e.preventDefault()
            dropzone.classList.remove("dragover")
            addFileSendList(e.dataTransfer.files)
        })
        let loaderElement=CE('input',{type:"file",multiple:true,accept:".raw",handleChange:(e)=>{addFileSendList(e.target.files)}},["Select a raw file"])
        let sendCommand=CE('div',{},[
            CE('button',{handleClick:(e)=>{
                sendToServer(selectedFiles)
                e.target.disabled=true
                for(let item of senderContainer.children[2].children){
                    item.appendChild(new OrbiSpinner())
                }
                senderContainer.lastChild.textContent="Files sent to server, waiting for conversion..."
            }},["Send to Server"])
        ])
        let senderContainer=CE('div',{
            style:{
                width:"100%",
                height:"100%",
                display:"grid",
                "grid-template-rows":"auto auto minmax(0,1fr) auto auto"},
                "justify-items": "stretch",
                "align-items": "stretch"
            },[dropzone,
                loaderElement,
                sendList,
                sendCommand,
                CE('div',{style:{"text-align":"center"}},[message])
            ])
        msConvertDialog.DOMelt.content.appendChild(senderContainer)
    }
    loadDelimitedText(onValidate){
        let DelimitedTextLoader=new Dialog("Load delimited text file",this,this.main)
        let prevLength=500
        let dataVessel={
            dims:[0,0],
            raw:"",
            processed:[],
            labels:["x","y"],
            processRaw(){
                if(this.reader){
                    this.raw=this.reader.result
                    delete this.reader
                }
                let lines=this.raw.split(RegExp(lineSeparator.value))
                this.dims[0]=lines.length
                for(let k in lines){
                    lines[k]=lines[k].split(RegExp(colSeparator.value))
                    this.dims[1]=Math.max(this.dims[1],lines[k].length)
                    lines[k].forEach((e,i,a)=>{a[i]=parseFloat(e)})
                }
                this.processed=lines
            }
        }
        const validate=()=>{
            dataVessel.processRaw()
            const source={
                lineSeparator:lineSeparator.value,
                columnSeparator:colSeparator.value,
                fileName:dataVessel.fileName||"",
                raw:dataVessel.raw,
                labels:[...(dataVessel.labels??["x","y"])],
                pairs:dataVessel.processed
                    .filter(line=>Number.isFinite(line[0])&&Number.isFinite(line[1]))
                    .map(line=>[line[0],line[1]])
            }
            if(onValidate){
                onValidate(source)
            }
            DelimitedTextLoader.DOMelt.dismisser.click()
        }
        const readFile=(file,data)=>{
            if (!file) {
                return
            }
            data.reader = new FileReader()
            data.reader.onload = ()=>{
                data.fileName=file.name
                updatePreviews(data)
            }
            data.reader.readAsText(file)
        }
        const readSingleFile=(e,data)=>{
            readFile(e.target.files[0],data)
        }
        const updatePreviews=(vessel)=>{
            vessel.processRaw()
            rawPreview.textContent=vessel.raw.slice(0,prevLength)
            procPreview.innerHTML=""
            let cropData=vessel.processed.slice(0,15)
            cropData.pop()
            let ellipsisRow=[]
            for(let k in cropData[0]){ellipsisRow.push("...")}
            cropData.push(ellipsisRow)
            if(!Array.isArray(vessel.labels)){
                vessel.labels=["x","y"]
            }
            new Table(cropData,[...vessel.labels],this,procPreview,{mutable:{hRuler:true},onTitleChange:(labels)=>{vessel.labels=[...labels]}})
        }
        const dropzone=CE('div',{className:"dropzone"},["Drop a text file here"])
        dropzone.addEventListener("dragover",(e)=>{
            e.preventDefault()
            dropzone.classList.add("dragover")
        })
        dropzone.addEventListener("dragleave",()=>{
            dropzone.classList.remove("dragover")
        })
        dropzone.addEventListener("drop",(e)=>{
            e.preventDefault()
            dropzone.classList.remove("dragover")
            readFile(e.dataTransfer.files[0],dataVessel)
        })
        const loaderElement=CE('input',{type:"file",handleChange:(e)=>{readSingleFile(e,dataVessel)}},["Select a text file"])
        let rawPreview=CE('div',{style:{margin:"5px","border-radius":"5px",border:"1px solid white",padding:"5px"}},["Here is the preview of the raw data"])
        rawPreview.setAttribute("contenteditable","true")
        rawPreview.handleInput=(e)=>{
            dataVessel.raw=e.target.textContent+dataVessel.raw.slice(prevLength)
            updatePreviews(dataVessel)
        }
        let procPreview=CE('div',{style:{margin:"5px","border-radius":"5px",border:"1px solid white",padding:"5px"}},["Here is the preview of the processed data"])
        const lineSeparator=CE('select',{handleInput:(e)=>{updatePreviews(dataVessel)}},[
            CE('option',{value:"\\r\\n|\\r|\\n"},["auto/guess"]),
            CE('option',{value:"\r\n"},["CRLF"]),
            CE('option',{value:"\r"},["CR"]),
            CE('option',{value:"\n"},["LF"]),
        ])
        const colSeparator=CE('select',{handleInput:(e)=>{updatePreviews(dataVessel)}},[
            CE('option',{value:"\\t|,|\\s+"},["auto/guess"]),
            CE('option',{value:"\t"},["tab"]),
            CE('option',{value:","},["comma"]),
            CE('option',{value:"\\s+"},["whitespace"]),
        ])
        const validator=CE('button',{handleClick:(e)=>{validate()}},["Load"])
        const command=CE('div',{width:"100%"},[
            CE('label',{for:"loaderCommands"},["Lines separator"]),
            lineSeparator,
            CE('br',{},[]),
            CE('label',{for:"loaderCommands"},["Columns separator"]),
            colSeparator,
            CE('br',{},[]),
            CE('div',{style:{"text-align":"right"}},[validator])
        ])
        const loaderContainer=CE('div',{
            style:{
                width:"100%",
                height:"100%",
                display:"grid",
                "grid-template-rows":"auto auto minmax(0, 1fr) auto"},
                "justify-items": "stretch",
                "align-items": "stretch"
        },[
            dropzone,
            loaderElement,
            CE('div',{style:{
                overflow:"auto",
                "min-height":"0",
                display:"grid",
                "grid-template-columns":"1fr 1fr"
            }},[
                rawPreview,
                procPreview
            ]),
            command
        ])
        DelimitedTextLoader.DOMelt.content.appendChild(loaderContainer)
    }
    saveSession(options={}){
        if(typeof options === "boolean"){
            options={download:options}
        }
        const json=saveSession(this)
        if(options.download){
            SingleJsonFile(json)
        }
        if(options.localStorage){
            localStorage.setItem("attributor-session",json)
        }
        return json
    }
    dispose(){
        //idempotent teardown of the whole app (used before replacing it with an
        //imported session): stops the observers, the menus and the channel
        if(this.disposed){
            return
        }
        this.disposed=true
        this.resizeObserver?.disconnect()
        this.mutObserver?.disconnect()
        this.channel.get("mainMenu")?.dispose?.()
        this.channel.get("mainFlowMenu")?.dispose?.()
        this.channel.shutDown()
        this.main?.remove()
    }
    async importSession(options={}){
        if(typeof options === "string"){
            options={json:options}
        }
        let json=options.json
        if(options.localStorage){
            json=localStorage.getItem("attributor-session")
        }
        if(options.file){
            json=await options.file.text()
        }
        if(options.filePicker){
            const input=CE('input',{type:"file",accept:"application/json"},[])
            json=await new Promise((resolve,reject)=>{
                input.addEventListener("change",async()=>{
                    const file=input.files?.[0]
                    if(!file){
                        reject(new Error("No session file selected"))
                        return
                    }
                    try{
                        resolve(await file.text())
                    }catch(error){
                        reject(error)
                    }
                },{once:true})
                input.click()
            })
        }
        if(typeof json !== "string"){
            throw new TypeError("importSession expects json, file, localStorage, or filePicker")
        }
        //tear the current app down BEFORE creating the imported one: the new app
        //attaches itself to the DOM and broadcasts events in its constructor, so
        //the old channel listeners must be gone already (no cross-talk, no leaks)
        this.dispose()
        const importedApp=await importSessionData(json,{
            createApp:()=>new App(),
            createNode:({data,app,flow})=>{
                const constructors={
                    Node,
                    NodeWithAccordion,
                    NodeWithAccordionGraph,
                    NodeWithRightAccordionGraph,
                    SimpleXYPlotNode,
                    DelimitedTextNode,
                    Operation,
                    PersistentHomology0DNode
                }
                const NodeType=constructors[data.type]??Node
                if(NodeType===DelimitedTextNode||NodeType===Operation||NodeType===PersistentHomology0DNode){
                    return new NodeType(data.title,app,flow,data.position)
                }
                return new NodeType(
                    data.title,
                    data.inputs,
                    data.outputs,
                    app,
                    flow,
                    data.position
                )
            },
            createLink:({flow,inputNode,inputIndex,outputNode,outputIndex})=>{
                return flow.createLink(inputNode,inputIndex,outputNode,outputIndex)
            },
            //mainFlow already exists (built by the App constructor); any other
            //flow stored in the session file is created here on the fly
            createFlow:(flowData,app)=>{
                return new Flow(flowData.label??"flow",app,app.flowWorkspace)
            }
        })
        globalThis.Attributor=importedApp
        //restore the saved panel layout (fold states and sizes)
        importedApp.applyPanelParameters()
        return importedApp
    }
    about(){
        let aboutDialog=new Dialog("About Attributor",this,this.main)
        stylize(aboutDialog.DOMelt.window,{
            width:"20%",
            height:"20%",
            top:"40%",
            left:"40%"
        })
        aboutDialog.DOMelt.content.appendChild(CE('div',{style:{
            width:"100%",
            height:"100%",
            display:"grid",
            "grid-template-rows":"auto auto auto",
            "place-items":"center",
            "text-align":"center"
        }},[
            new OrbiSpinner(50,50),
            CE("div",{},[
                CE("div",{},["Attributor Alpha version 0.1.0"]),
                CE("div",{},["This software is under development and may contain bugs."]),
                CE("div",{},["Please report any issues to the developers."])
            ]),
            CE("div",{},[new CycloSpinner(15)]),
            CE("div",{},[new CycloSpinner(15),new CycloSpinner(15)])
        ]))
    }
}

class OrbiSpinner{
    constructor(width=30,height=15){
        let t=10000*Math.random()
        const r=Math.min(width,height)/5
        let container=CE('div',{style:{
            "background-color":"rgba(164, 173, 185, 0.3)",
            margin:"0px",
            display:"inline-block",
            border:"1px solid lightblue",
            "border-radius":`5px`,
            width:`${width}px`,
            height:`${height}px`,
            position:"relative"}},[])
        let svg=d3.select(container).append("svg")
            .attr("width","100%")
            .attr("height","100%")
        let c1=svg.append("circle")
            .attr("cx",10)
            .attr("cy",10)
            .attr("r",r)
            .attr('fill','tomato')
            .attr('stroke','rgb(110, 122, 138)')
        let c2=svg.append("circle")
            .attr("cx",10)
            .attr("cy",10)
            .attr("r",r)
            .attr('fill','#aef22e')
            .attr('stroke','DarkCyan')
        let c3=svg.append("circle")
            .attr("cx",10)
            .attr("cy",10)
            .attr("r",r)
            .attr('fill','purple')
            .attr('stroke','rgb(110, 122, 138)')
        const animLoop=()=>{
            c1
            .attr("cx",0.5*width+0.5*(width-r)*Math.cos(t/200))
            .attr("cy",0.5*height+(height/2-1.5*r)*Math.sin(t/10))
            .attr("r",1+r*Math.abs(Math.sin(t/20)))
            c2
            .attr("cx",0.5*width+0.5*(width-r)*Math.cos((t-10)/30))
            .attr("cy",0.5*height+(height/2-1.5*r)*Math.sin((t-10)/10))
            .attr("r",1+r*Math.abs(Math.sin(t/20)))
            c3
            .attr("cx",0.5*width+0.5*(width-r)*Math.cos((t-30)/60))
            .attr("cy",0.5*height+(height/2-1.5*r)*Math.sin((t-30)/10))
            .attr("r",1+r*Math.abs(Math.sin(t/20)))
            t++
            requestAnimationFrame(animLoop)
        }
        animLoop()
        return container
    }
}

class CycloSpinner{
    constructor(size=20){
        let width=size
        let height=size
        let t=10000*Math.random()
        const r=Math.min(size/5,4)
        let c=0
        let container=CE('div',{style:{
            background:"radial-gradient(circle, rgba(164, 173, 185, 0.28) 0%, rgba(164, 173, 185, 0.12) 58%, transparent 100%)",
            margin:"0px",
            display:"inline-block",
            border:"none",
            "border-radius":"50%",
            width:`${width}px`,
            height:`${height}px`,
            position:"relative",
            overflow:"hidden"}},[])
        let svg=d3.select(container).append("svg")
            .attr("width","100%")
            .attr("height","100%")
        let c0=svg.append("circle")
            .attr("cx",width/2)
            .attr("cy",height/2)
            .attr("r",width/2-1)
            .attr('fill','rgba(164, 173, 185, 0.3)')
            .attr('stroke','lightblue')
        let c1=svg.append("circle")
            .attr("cx",10)
            .attr("cy",10)
            .attr("r",r)
            .attr('fill','tomato')
            .attr('stroke','rgb(110, 122, 138)')
        let c2=svg.append("circle")
            .attr("cx",10)
            .attr("cy",10)
            .attr("r",r)
            .attr('fill','#aef22e')
            .attr('stroke','DarkCyan')
        let c3=svg.append("circle")
            .attr("cx",10)
            .attr("cy",10)
            .attr("r",r)
            .attr('fill','purple')
            .attr('stroke','rgb(110, 122, 138)')
        const animLoop=()=>{
            const c=(phi)=>0.9*Math.abs(Math.sin((t+phi)/200))**1.5
            c1
            .attr("cx",0.5*width+0.5*c(-50)*(width-r)*Math.cos(t/20))
            .attr("cy",0.5*height+0.5*c(-50)*(height-r)*Math.sin(t/20))
            //.attr("r",1+r*Math.abs(Math.sin(t/100)))
            c2
            .attr("cx",0.5*width+0.5*c(-100)*(width-r)*Math.cos((1.5*t)/20))
            .attr("cy",0.5*height+0.5*c(-100)*(height-r)*Math.sin((1.5*t)/20))
            //.attr("r",1+r*Math.abs(Math.sin(t/100)))
            c3
            .attr("cx",0.5*width+0.5*c(-150)*(width-r)*Math.cos((1.25*t)/20))
            .attr("cy",0.5*height+0.5*c(-150)*(height-r)*Math.sin((1.25*t)/20))
            //.attr("r",1+r*Math.abs(Math.sin(t/100)))
            t++
            requestAnimationFrame(animLoop)
        }
        animLoop()
        return container
    }
}

class PetitGazParfait {
    constructor(width = 300, height = 200, N = 25, r = 7) {
        this.width = width;
        this.height = height;
        this.N = N;
        this.r = r;

        let container = document.createElement('div');
        Object.assign(container.style, {
            backgroundColor: "rgba(64, 73, 85, 0)",
            margin: "0px",
            display: "inline-block",
            border: "1px solid lightblue",
            borderRadius: `5px`,
            width: `${width}px`,
            height: `${height}px`,
            position: "relative"
        });

        let svg = d3.select(container).append("svg")
            .attr("width", "100%")
            .attr("height", "100%");

        const balls = d3.range(N).map(() => ({
            x: Math.random() * (width - 2 * r) + r,
            y: Math.random() * (height - 2 * r) + r,
            vx: (Math.random() - 0.5) * 1,
            vy: (Math.random() - 0.5) * 1
        }));

        const circles = svg.selectAll("circle")
            .data(balls)
            .enter()
            .append("circle")
            .attr("r", r)
            .attr("fill", "skyblue")
            .attr("stroke", "#88f");

        function collide(a, b) {
            const dx = b.x - a.x;
            const dy = b.y - a.y;
            const dist = Math.sqrt(dx * dx + dy * dy);

            if (dist < 2 * r) {
                const nx = dx / dist;
                const ny = dy / dist;

                const dvx = b.vx - a.vx;
                const dvy = b.vy - a.vy;
                const impact = dvx * nx + dvy * ny;

                if (impact < 0) { // éviter de "recoller" les particules déjà en fuite
                    const impulse = 2 * impact / 2; // masses égales
                    a.vx += impulse * nx;
                    a.vy += impulse * ny;
                    b.vx -= impulse * nx;
                    b.vy -= impulse * ny;
                }
            }
        }

        const animate = () => {
            // Mise à jour des positions
            for (let b of balls) {
                b.x += b.vx;
                b.y += b.vy;

                // Rebonds sur les murs
                if (b.x <= r || b.x >= width - r) b.vx *= -1;
                if (b.y <= r || b.y >= height - r) b.vy *= -1;
            }

            // Collisions entre particules
            for (let i = 0; i < N; i++) {
                for (let j = i + 1; j < N; j++) {
                    collide(balls[i], balls[j]);
                }
            }

            // Mise à jour de l'affichage
            circles
                .attr("cx", d => d.x)
                .attr("cy", d => d.y);

            requestAnimationFrame(animate);
        };
        animate();

        return container;
    }
}

class PetitGazFusion {
    constructor(width = 300, height = 200, N = 250, r = 5) {
        this.width = width;
        this.height = height;
        this.N = N;
        this.r = r;

        let container = document.createElement('div');
        Object.assign(container.style, {
            backgroundColor: "rgba(64, 73, 85, 0)",
            margin: "0px",
            display: "inline-block",
            border: "1px solid lightblue",
            borderRadius: `5px`,
            width: `${width}px`,
            height: `${height}px`,
            position: "relative"
        });

        let svg = d3.select(container).append("svg")
            .attr("width", "100%")
            .attr("height", "100%");

        let balls = d3.range(N).map(() => ({
            x: Math.random() * (width - 2 * r) + r,
            y: Math.random() * (height - 2 * r) + r,
            vx: (Math.random() - 0.5) * 1,
            vy: (Math.random() - 0.5) * 1,
            mass: 1,
            r: r
        }));

        const update = () => {
            // Mise à jour des positions
            for (let b of balls) {
                b.x += b.vx;
                b.y += b.vy;

                // Rebonds murs
                if (b.x <= b.r || b.x >= width - b.r) b.vx *= -1;
                if (b.y <= b.r || b.y >= height - b.r) b.vy *= -1;
            }

            // Collisions/fusion
            let survivors = [];
            let merged = new Set();

            for (let i = 0; i < balls.length; i++) {
                if (merged.has(i)) continue;

                let a = balls[i];
                for (let j = i + 1; j < balls.length; j++) {
                    if (merged.has(j)) continue;

                    let b = balls[j];
                    let dx = b.x - a.x;
                    let dy = b.y - a.y;
                    let dist = Math.sqrt(dx * dx + dy * dy);

                    if (dist < a.r + b.r) {
                        // Fusion !

                        let totalMass = a.mass + b.mass;
                        let newVx = (a.vx * a.mass + b.vx * b.mass) / totalMass;
                        let newVy = (a.vy * a.mass + b.vy * b.mass) / totalMass;

                        let newX = (a.x * a.mass + b.x * b.mass) / totalMass;
                        let newY = (a.y * a.mass + b.y * b.mass) / totalMass;

                        survivors.push({
                            x: newX,
                            y: newY,
                            vx: newVx,
                            vy: newVy,
                            mass: totalMass,
                            r: this.r * Math.sqrt(totalMass) // rayon ∝ √masse
                        });

                        merged.add(i);
                        merged.add(j);
                        break;
                    }
                }

                if (!merged.has(i)) {
                    survivors.push(a);
                }
            }

            balls = survivors;

            // Mise à jour SVG
            let sel = svg.selectAll("circle").data(balls);

            sel.enter()
                .append("circle")
                .merge(sel)
                .attr("cx", d => d.x)
                .attr("cy", d => d.y)
                .attr("r", d => d.r)
                .attr("fill", "orange")
                .attr("stroke", "firebrick");

            sel.exit().remove();

            requestAnimationFrame(update);
        };

        update();

        return container;
    }
}



export {App, Plot2D, Plot2DWebGL, PersistentHomology0DNode}
