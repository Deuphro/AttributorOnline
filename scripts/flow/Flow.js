import * as d3 from "https://cdn.jsdelivr.net/npm/d3@7/+esm"
import {CE} from "../util.js"
import {layoutFlow,LAYOUT_DEFAULTS,buildGraph,autoLinkPlan} from "../layout.js"
import {DEFAULT_LINK_TOLERANCE,growForest,suggestWeightCut,forestComponents,componentLine,forestGraph,forestRoot,layoutForests,forestStandards} from "../forest.js"
import {Node} from "../core/index.js"
import {Command,History,nodeRestoreData,createNodeForHistory} from "../core/index.js"
import {buildNode} from "../utils/index.js"

export class Flow{
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
            nodeKilled(e){this.autoLayout()},
            nodeStatusChanged(e){this.forwardStatus(e.detail.emitter,e.detail.msg.status)},
            linkSelected(e){},
            async resolveFlow(e){
                await this.resolveFlow()
            },
        }}
        this.nodeSet=new Set()
        this.linkList=[]
        this.selection=new Set()
        this.lastSelected=null
        this.container.addEventListener("click",(event)=>{
            if(event.target.closest(".node, .link, .anchor")){
                return
            }
            this.clearSelection()
        })
        this.replacements=new Map()
        this.parameters={
            field:{
                drawn:false,
                node:[],
                links:{stiffness:75}
            },
            layout:{...LAYOUT_DEFAULTS}
        }
        this.container.style.cssText="position:relative;width:100%;height:100%;overflow:auto"
        this.container.handleResize=()=>this.fitField()
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
    layoutOptions(){
        return {...LAYOUT_DEFAULTS,...this.parameters.layout}
    }
    graphSnapshot(){
        return {
            nodes:[...this.nodeSet].map(node=>({
                id:node,
                width:node.parameters.width,
                height:node.nodeHeight,
                inputCount:node.inputs.length,
                outputCount:node.outputs.length,
                x:node.parameters.position.x,
                y:node.parameters.position.y,
                pinned:!!node.parameters.pinned
            })),
            links:this.linkList
                .filter(link=>link.inputNode&&link.outputNode)
                .map(link=>({
                    source:link.inputNode,
                    target:link.outputNode,
                    sourcePort:Number(link.inputAnchor?.id??0),
                    targetPort:Number(link.outputAnchor?.id??0)
                }))
        }
    }
    positionsSnapshot(){
        return new Map([...this.nodeSet].map(node=>[node,{
            x:node.parameters.position.x,
            y:node.parameters.position.y,
            pinned:!!node.parameters.pinned
        }]))
    }
    restorePositions(snapshot){
        for(const [node,position] of snapshot){
            if(!this.nodeSet.has(node)){
                continue
            }
            node.parameters.pinned=position.pinned
            node.applyPosition(position)
        }
        this.updateLinks()
        this.fitField()
    }
    autoLayout(){
        if(!this.nodeSet.size||!this.field){
            return null
        }
        const {positions,bounds}=layoutFlow({
            ...this.graphSnapshot(),
            options:this.layoutOptions()
        })
        for(const node of this.nodeSet){
            const target=positions.get(node)
            if(target){
                node.applyPosition(target)
            }
        }
        this.updateLinks()
        this.fitField(bounds)
        return bounds
    }
    arrangeNodes(){
        const before=this.positionsSnapshot()
        this.autoLayout()
        const after=this.positionsSnapshot()
        if(this.origin.history.replaying){
            return
        }
        let moved=false
        for(const [node,position] of before){
            const now=after.get(node)
            if(now&&(now.x!==position.x||now.y!==position.y||now.pinned!==position.pinned)){
                moved=true
                break
            }
        }
        if(!moved){
            return
        }
        this.origin.history.record(new Command({
            label:"Arrange nodes",
            undo:()=>this.restorePositions(before),
            redo:()=>this.restorePositions(after)
        }))
    }
    canLink({source,sourceIndex=0,target,targetIndex=0}={}){
        if(!source||!target||source===target){
            return false
        }
        if(!this.nodeSet.has(source)||!this.nodeSet.has(target)){
            return false
        }
        if(!(sourceIndex>=0&&sourceIndex<source.outputs.length)){
            return false
        }
        if(!(targetIndex>=0&&targetIndex<target.inputs.length)){
            return false
        }
        const alreadyThere=this.linkList.some(link=>
            link.inputNode===source
            &&link.outputNode===target
            &&Number(link.inputAnchor?.id)===sourceIndex
            &&Number(link.outputAnchor?.id)===targetIndex
        )
        if(alreadyThere){
            return false
        }
        return !this.reaches(target,source)
    }
    reaches(from,to){
        if(from===to){
            return true
        }
        const seen=new Set([from])
        const stack=[from]
        while(stack.length){
            for(const child of this.childrenMap(stack.pop()).keys()){
                if(child===to){
                    return true
                }
                if(!seen.has(child)){
                    seen.add(child)
                    stack.push(child)
                }
            }
        }
        return false
    }
    linkNodes({source,sourceIndex=0,target,targetIndex=0,record=true,relayout=true}={}){
        if(!this.canLink({source,sourceIndex,target,targetIndex})){
            console.warn("[Flow] link refused: not a valid cable for this flow")
            return null
        }
        const link=this.createLink(source,sourceIndex,target,targetIndex)
        if(!link){
            return null
        }
        this.forwardStatus(target,'floating')
        if(record&&!this.origin.history.replaying){
            this.origin.history.record(new Command({
                label:`Create link ${source.title} -> ${target.title}`,
                undo:()=>{
                    this.deleteLink(link,{record:false})
                    this.autoLayout()
                },
                redo:()=>{
                    link=this.createLink(source,sourceIndex,target,targetIndex)
                    this.autoLayout()
                }
            }))
        }
        if(relayout){
            this.autoLayout()
        }
        return link
    }
    linkNewNode(node){
        const plan=autoLinkPlan(buildGraph(this.graphSnapshot()),node)
        const wired=[]
        for(const proposal of plan){
            const link=this.linkNodes({...proposal,record:false,relayout:false})
            if(link){
                wired.push(proposal)
            }
        }
        return wired
    }
    fitField(bounds){
        if(!this.field){
            return
        }
        const box=this.container.getBoundingClientRect()
        const content=bounds??this.contentBounds()
        this.field
            .attr("width",Math.max(Math.round(box.width),Math.ceil(content.width)))
            .attr("height",Math.max(Math.round(box.height),Math.ceil(content.height)))
    }
    contentBounds(){
        let maxX=0
        let maxY=0
        for(const node of this.nodeSet){
            const {x,y}=node.parameters.position
            maxX=Math.max(maxX,x+node.parameters.width)
            maxY=Math.max(maxY,y+node.nodeHeight)
        }
        const margin=this.layoutOptions().margin
        return {width:maxX+margin,height:maxY+margin}
    }
    get selectedNodes(){
        for(const node of [...this.selection]){
            if(!this.nodeSet.has(node)){
                this.selection.delete(node)
            }
        }
        return this.selection
    }
    isSelected(node){
        return this.selection.has(node)
    }
    select(node,{additive=false}={}){
        if(!this.nodeSet.has(node)){
            return
        }
        if(!additive){
            this.selection.clear()
            this.selection.add(node)
            this.lastSelected=node
        }else if(this.selection.has(node)){
            this.selection.delete(node)
            if(this.lastSelected===node){
                this.lastSelected=[...this.selection].pop()??null
            }
        }else{
            this.selection.add(node)
            this.lastSelected=node
        }
        this.paintSelection()
    }
    toggleSelection(node){
        this.select(node,{additive:true})
    }
    linkDescriptorsFor(nodes){
        const set=new Set(Array.isArray(nodes)?nodes:[nodes])
        return this.linkList
            .filter(link=>set.has(link.inputNode)||set.has(link.outputNode))
            .map(link=>({
                inputNode:link.inputNode,
                inputIndex:Number(link.inputAnchor.id),
                outputNode:link.outputNode,
                outputIndex:Number(link.outputAnchor.id)
            }))
    }
    rebuildLinks(descriptors){
        const live=node=>this.replacements.get(node)??node
        return descriptors
            .map(link=>this.createLink(
                live(link.inputNode),
                link.inputIndex,
                live(link.outputNode),
                link.outputIndex))
            .filter(Boolean)
    }
    deleteSelection(){
        const nodes=[...this.selectedNodes]
        if(nodes.length===0){
            return
        }
        const flow=this
        const snapshot=nodes.map(node=>({origin:node.origin,data:nodeRestoreData(node)}))
        const linkedDescriptors=flow.linkDescriptorsFor(nodes)
        if(!this.origin.history.replaying){
            let restored=[]
            this.origin.history.record(new Command({
                label:nodes.length===1
                    ?`Delete node ${nodes[0].title}`
                    :`Delete ${nodes.length} nodes`,
                undo:()=>{
                    restored=snapshot.map(entry=>createNodeForHistory(entry.origin,flow,entry.data))
                    for(const [dead,fresh] of nodes.map((dead,index)=>[dead,restored[index]])){
                        flow.replacements.set(dead,fresh)
                    }
                    flow.rebuildLinks(linkedDescriptors)
                    for(const node of restored){
                        node.refreshFromLinks?.()
                    }
                    flow.selectOnly(restored[restored.length-1]??null)
                },
                redo:()=>{
                    for(const node of restored){
                        node.suicide({skipHistory:true})
                    }
                    restored=[]
                    flow.clearSelection()
                }
            }))
        }
        for(const node of nodes){
            node.suicide({skipHistory:true})
        }
        this.clearSelection()
    }
    selectOnly(node){
        this.selection.clear()
        this.lastSelected=null
        if(node&&this.nodeSet.has(node)){
            this.selection.add(node)
            this.lastSelected=node
        }
        this.paintSelection()
    }
    clearSelection(){
        this.selection.clear()
        this.lastSelected=null
        this.paintSelection()
    }
    selectAll(){
        this.selection=new Set(this.nodeSet)
        this.lastSelected=null
        this.paintSelection()
    }
    paintSelection(){
        for(const node of this.nodeSet){
            const rect=node.DOMelt?.querySelector("rect")
            if(!rect){
                continue
            }
            rect.classList.toggle("selected",this.selection.has(node))
        }
    }
    selectionPositions(){
        const snapshot=new Map()
        for(const node of this.selectedNodes){
            snapshot.set(node,{...node.parameters.position,pinned:!!node.parameters.pinned})
        }
        return snapshot
    }
    moveSelectionBy(dx,dy){
        for(const node of this.selectedNodes){
            node.parameters.position.x+=dx
            node.parameters.position.y+=dy
            node.SVGg.attr('transform',`translate(${node.parameters.position.x},${node.parameters.position.y})`)
        }
        this.updateLinks()
    }
    patternFromSelection(name="pattern"){
        const nodes=[...this.selectedNodes]
        if(nodes.length===0){
            return null
        }
        const inside=new Set(nodes)
        let minX=Infinity,minY=Infinity
        for(const node of nodes){
            minX=Math.min(minX,node.parameters.position.x)
            minY=Math.min(minY,node.parameters.position.y)
        }
        const links=[]
        for(const link of this.linkList){
            if(!inside.has(link.inputNode)||!inside.has(link.outputNode)){
                continue
            }
            links.push({
                from:nodes.indexOf(link.inputNode),
                fromIndex:Number(link.inputAnchor.id),
                to:nodes.indexOf(link.outputNode),
                toIndex:Number(link.outputAnchor.id)
            })
        }
        return {
            name:String(name),
            nodes:nodes.map(node=>({
                ...nodeRestoreData(node),
                position:{
                    x:node.parameters.position.x-minX,
                    y:node.parameters.position.y-minY
                }
            })),
            links,
            version:1
        }
    }
    instantiatePattern(pattern,at={x:20,y:20}){
        if(!pattern?.nodes?.length){
            return []
        }
        const created=pattern.nodes.map(data=>{
            const node=buildNode(
                {
                    ...data,
                    position:{
                        x:at.x+(data.position?.x??0),
                        y:at.y+(data.position?.y??0)
                    }
                },
                this.origin,
                this
            )
            this.origin.channel.register(data.registrationName??"node",node,node.title)
            node.parameters.pinned=false
            if(data.state&&typeof node.restoreState==="function"){
                node.restoreState(data.state)
            }
            if(data.status){
                node.status=data.status
            }
            return node
        })
        for(const link of pattern.links??[]){
            const from=created[link.from]
            const to=created[link.to]
            if(from&&to){
                this.linkNodes({
                    source:from,sourceIndex:link.fromIndex,
                    target:to,targetIndex:link.toIndex,
                    record:true,relayout:false
                })
            }
        }
        this.autoLayout()
        return created
    }
    revealNode(node){
        if(!this.container||!node){
            return
        }
        const box=this.container.getBoundingClientRect()
        const {x,y}=node.parameters.position
        const width=node.parameters.width
        const height=node.nodeHeight
        if(x<this.container.scrollLeft){
            this.container.scrollLeft=x-24
        }else if(x+width>this.container.scrollLeft+box.width){
            this.container.scrollLeft=x+width-box.width+24
        }
        if(y<this.container.scrollTop){
            this.container.scrollTop=y-24
        }else if(y+height>this.container.scrollTop+box.height){
            this.container.scrollTop=y+height-box.height+24
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
            const draft=this.linkList.at(-1)
            if(draft?.endingAnchor){
                const source=draft.inputNode
                const target=draft.outputNode
                const sourceIndex=Number(draft.inputAnchor.id)
                const targetIndex=Number(draft.outputAnchor.id)
                draft.node().remove()
                this.linkList.pop()
                this.linkNodes({source,sourceIndex,target,targetIndex})
            }else{
                draft?.node().remove()
                this.linkList.pop()
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
                e.target.pilot.autoLayout()
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
        }
    }
    updateLinks(){
        for(let k=0;k<this.linkList.length;k++){
            const link=this.linkList[k]
            if(!link.startingNode||!link.endingNode){
                continue
            }
            if(this.nodeSet.has(link.startingNode) && this.nodeSet.has(link.endingNode)){
                const startingPos=Node.anchorAbsPos(link.startingAnchor)
                const endingPos=Node.anchorAbsPos(link.endingAnchor)
                const stiffness=this.parameters.field.links.stiffness
                const handle=Math.max(
                    20,
                    Math.min(stiffness,Math.abs(endingPos.x-startingPos.x)*0.5)
                )
                const bezierSide=link.startingNode.parameters.anchorMap.get(link.startingAnchor).type==="output"?handle:-handle
                link.attr("d", `M ${startingPos.x} ${startingPos.y}
                C ${startingPos.x+bezierSide} ${startingPos.y},
                ${endingPos.x-bezierSide} ${endingPos.y},
                ${endingPos.x} ${endingPos.y}`)
            }else{
                this.deleteLink(k,{record:false})
                k--
            }
        }
    }
    get leaves(){
        let res=new Set
        this.nodeSet.forEach((node)=>{
            let isLeave=true
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
    async resolveDescendantsOf(node){
        const descendants=new Set()
        const collect=(n)=>{
            for(const child of this.childrenMap(n).keys()){
                if(!descendants.has(child)){
                    descendants.add(child)
                    collect(child)
                }
            }
        }
        collect(node)
        if(descendants.size===0) return
        for(const desc of descendants){
            this.forwardStatus(desc,"floating")
        }
        const subLeaves=Array.from(descendants).filter(d=>{
            const kids=Array.from(this.childrenMap(d).keys())
            return kids.length===0||kids.every(k=>!descendants.has(k))
        })
        const resolutions=new Map()
        resolutions.set(node,Promise.resolve())
        await Promise.all(subLeaves.map(leaf=>this.resolveNode(leaf,resolutions)))
    }
    async parentSynapse(node,parentsMap){
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
            await Promise.all(Array.from(parentsMap.keys()).map(parent=>
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