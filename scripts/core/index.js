import {$,CE,stylize,fakeData,DC,requestPOST,SingleJsonFile} from "../util.js"
import {Accordion} from "../ui/Accordion.js"
import {save as saveSession, import as importSessionData} from "../sessions.js"
import * as d3 from "https://cdn.jsdelivr.net/npm/d3@7/+esm"
import {defaultMenu} from "../../resources/config.js"
import { Data , Vector, Wave, XYTrace} from "../formats.js"
import {computePool} from "../workerPool.js"
import {GLTraceLayer,shapeId,parseCssColor,THREE_CDN} from "../plot2d-gl.js"
import {Formula,Stoichiometry,FormulaCollection,loadTable} from "../chemistry.js"
import {buildPlan,attributeSpectrum,SortedPoints,saneBound,saneRatio,planForKernel,stateToFormula,propagateForest} from "../attribution.js"
import {forestStandards,forestComponents,componentLine,growForest,suggestWeightCut,forestGraph,forestRoot,layoutForests,DEFAULT_LINK_TOLERANCE} from "../forest.js"
import {LAYOUT_DEFAULTS,autoLinkPlan,buildGraph,layoutFlow} from "../layout.js"
import {
    clearLocalSession,
    debounce,
    exportSkeleton,
    importOptions,
    parseSkeleton,
    purgeAll,
    readLocalSession,
    readPreferences,
    reparseRestoredSource,
    saveLocalSession,
    savePreferences,
    writeSession
} from "../sessionStore.js"

window.raie=new Wave(10,2)
window.eiar=new Wave(7)

export const LAYOUT_REVEAL_MARGIN=24
export const LAYOUT_MIN_LINK_HANDLE=20

export class Command{
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

export class History{
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

export class Node{
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
                    const rect=this.SVGg.select('rect').node()
                    if(document.activeElement!==rect){
                        rect.focus()
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
        this.DOMelt.querySelector('rect').handleClick=(e)=>{
            const pilot=e.target.pilot
            const flow=pilot.destination
            if(flow){
                const additive=e.ctrlKey||e.metaKey
                flow.select(pilot,{additive})
            }
            globalThis.dispatchEvent(pilot.events.broadcast.nodeSelected)
            if(flow?.isSelected(pilot)){
                pilot.reveal()
            }
        }
        this.DOMelt.querySelector('rect').handleMouseDown=(e)=>e.target.pilot.drag(e)
        this.DOMelt.querySelector('rect').handleContextmenu=(e)=>{console.log(e)}
        this.DOMelt.querySelector('rect').handleKeyDown=(e)=>{
            if(e.key==="Delete"||e.key==="Backspace"){
                e.preventDefault()
                const flow=e.target.pilot.destination
                flow?.deleteSelection()
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
    reveal(){
        const panels=[this.accordion,this.accordionRight].filter(Boolean)
        for(const accordion of panels){
            if(accordion.parameters?.folded){
                accordion.unfold()
            }
            this.scrollPanelTo(accordion)
        }
    }
    scrollPanelTo(accordion){
        const container=accordion.DOMelt?.container
        if(!container||!container.isConnected){
            return
        }
        const panel=container.parentElement
        if(!panel){
            return
        }
        const containerTop=container.getBoundingClientRect().top
        const panelTop=panel.getBoundingClientRect().top
        const delta=containerTop-panelTop
        if(Math.abs(delta)<1){
            return
        }
        panel.scrollTop+=delta
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
        const flow=pilot.destination
        const group=[...flow.selectedNodes]
        const isGroup=group.length>1&&group.includes(pilot)
        const moved=isGroup?group:[pilot]
        const before=flow.selectionPositions()
        const singleBefore={...pilot.parameters.position}
        for(const node of moved){
            node.DOMelt.classList.add("dragging")
        }
        document.onmousemove=(e)=>{
            e.preventDefault();
            dx-=e.clientX;
            dy-=e.clientY;
            if(isGroup){
                flow.moveSelectionBy(-dx,-dy)
            }else{
                pilot.parameters.position.x-=dx
                pilot.parameters.position.y-=dy
                window.dispatchEvent(pilot.events.broadcast.nodeMove)
                pilot.SVGg.attr('transform', 'translate('+`${pilot.parameters.position.x},${pilot.parameters.position.y}`+')')
            }
            dx=e.clientX;
            dy=e.clientY;
        }
        document.onmouseup=(e)=>{
            e.preventDefault();
            document.onmousemove=null;
            document.onmouseup=null;
            for(const node of moved){
                node.DOMelt.classList.remove("dragging")
            }
            const after=flow.selectionPositions()
            let changed=false
            for(const [node,position] of before){
                const now=after.get(node)
                if(now&&(now.x!==position.x||now.y!==position.y)){
                    changed=true
                }
            }
            if(!changed){
                return
            }
            for(const node of moved){
                node.parameters.pinned=true
            }
            if(isGroup){
                const restore=(snapshot)=>{
                    for(const [node,position] of snapshot){
                        if(flow.nodeSet.has(node)){
                            node.parameters.pinned=position.pinned
                            node.applyPosition(position)
                        }
                    }
                    flow.updateLinks()
                }
                flow.origin.history.record(new Command({
                    label:`Move ${moved.length} nodes`,
                    undo:()=>restore(before),
                    redo:()=>restore(after)
                }))
                return
            }
            const singleAfter={...pilot.parameters.position}
            const resolveLive=()=>{
                if(flow.nodeSet.has(pilot)){
                    return pilot
                }
                const replacement=flow.replacements?.get(pilot)
                return replacement&&flow.nodeSet.has(replacement)?replacement:null
            }
            flow.origin.history.record(new Command({
                label:`Move ${pilot.title}`,
                undo:()=>resolveLive()?.setPosition(singleBefore),
                redo:()=>resolveLive()?.setPosition(singleAfter)
            }))
        }
    }
    applyPosition(position){
        this.parameters.position={...position}
        this.SVGg.attr('transform',`translate(${position.x},${position.y})`)
    }
    setPosition(position){
        this.applyPosition(position)
        this.destination.updateLinks()
    }
    resolveChildren(){
        return this.destination?.resolveDescendantsOf(this)??Promise.resolve()
    }
    set status(value){
        const possible=['resolved','error','pending','floating']
        const rect=this.DOMelt.querySelector("rect")
        rect.classList.remove(...possible)
        if(possible.includes(value)){
            rect.classList.add(value)
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
        const linkedDescriptors=flow.linkDescriptorsFor(this)
        const restoreData=nodeRestoreData(this)
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
        flow.selection.delete(this)
        if(flow.lastSelected===this){
            flow.lastSelected=[...flow.selectedNodes].pop()??null
        }
        dispatchEvent(this.events.broadcast.nodeKilled)
        this.SVGg.node().remove()
        if(!skipHistory&&!this.origin.history.replaying){
            let restoredNode=null
            let restoredLinks=[]
            this.origin.history.record(new Command({
                label:`Delete node ${this.title}`,
                undo:()=>{
                    restoredNode=createNodeForHistory(this.origin,flow,restoreData)
                    flow.replacements.set(this,restoredNode)
                    restoredLinks=flow.rebuildLinks(linkedDescriptors)
                    restoredNode.refreshFromLinks?.()
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
    restoreAfterImport(){
        if(this.restoredFolded){
            this.accordion?.fold()
        }
        const ranks=this.restoredPanelOrder??{}
        if(Number.isInteger(ranks.left)){
            this.accordion?.restoredPanelOrder(ranks.left)
        }
        if(Number.isInteger(ranks.right)){
            this.accordionRight?.restoredPanelOrder(ranks.right)
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
    async startResolve(){
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
                console.log('il y a cette entrÃ©e :',entry)
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
                        console.log('et pour cette valeur ',value,' on incrÃ©mente et la valeur et le tableau')
                        protoOutput.push(value+1)
                    }
                }
            }
        }
        return protoOutput
    }
}

export class Operation extends Node{
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

export class NodeWithAccordion extends Node{
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

export function nodeRestoreData(node){
    return {
        title:node.title,
        type:node.constructor.name,
        registrationName:node.events?.registrationName,
        inputs:node.inputs.map(entry=>entry instanceof Map ? new Map() : DC(entry)),
        outputs:DC(node.outputs),
        position:{...node.parameters.position},
        pinned:!!node.parameters.pinned,
        status:node.status,
        source:node.parameters.source?DC(node.parameters.source):null,
        state:node.serializeState?.()??null
    }
}

export function createNodeForHistory(origin,flow,data){
    const position={...data.position}
    const node=buildNode(
        {
            ...data,
            inputs:data.inputs===undefined?undefined:DC(data.inputs),
            outputs:data.outputs===undefined?undefined:DC(data.outputs)
        },
        origin,
        flow
    )
    origin.channel.register(data.registrationName??"node",node,node.title)
    node.parameters.pinned=!!data.pinned
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