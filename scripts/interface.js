import {$,CE,stylize,fakeData,DC,requestPOST,SingleJsonFile} from "./util.js"
import {save as saveSession, import as importSessionData} from "./sessions.js"
import * as d3 from "https://cdn.jsdelivr.net/npm/d3@7/+esm"
import {defaultMenu} from "../resources/config.js"
import { Data , Vector, Wave, XYTrace} from "./formats.js"
import {computePool} from "./workerPool.js"
import {GLTraceLayer,shapeId,parseCssColor,THREE_CDN} from "./plot2d-gl.js"
//the chemistry engine. The CLASSES are imported directly; the periodic table
//is DATA and is fetched by the App that needs it (see App), never at module
//load: importing a node graph must not drag a 72 Ko download with it.
import {Formula,Stoichiometry,FormulaCollection,loadTable} from "./chemistry.js"
//where the nodes go, and which two of them get wired together by themselves.
//Pure functions over plain descriptors, so the whole thing is testable
//without a browser (see layout.test.mjs).
import {LAYOUT_DEFAULTS,autoLinkPlan,buildGraph,layoutFlow} from "./layout.js"
//what a reload finds: the skeleton of the work in progress, and the panel
//geometry that outlives it. See the module header for why the two live in two
//different stores.
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
} from "./sessionStore.js"

window.raie=new Wave(10,2)
window.eiar=new Wave(7)

//kept between a node and the edge of the viewport when the field scrolls to it
const LAYOUT_REVEAL_MARGIN=24
//a bezier handle shorter than this and a short cable curls back on itself
const LAYOUT_MIN_LINK_HANDLE=20

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
                /* ALWAYS focus, and never blur.

                   This used to toggle: "if this node already has the focus,
                   blur it". That was the selection mechanism of the very first
                   version, when the browser's focus ring WAS the highlight and
                   clicking a node twice was how you released it. Since the
                   selection became a real class, the toggle has had no
                   purpose except to misbehave:

                     - it made the focus ring blink on and off around the
                       click, which is the "appears then disappears at once"
                       symptom;
                     - and it BROKE Delete. `keydown` only reaches the focused
                       element, so clicking a selected node a second time
                       blurred it, and the next Delete went nowhere at all.

                   Focusing unconditionally is what keeps the keyboard alive:
                   whatever was clicked last is the node Delete acts on, and
                   `deleteSelection()` then takes everything selected. */
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
            /* LE CONVENTION DES FICHIERS, ET C'EST CELLE-LÀ.

               Clic nu     : ONLY this node is selected. Whatever else was
                             selected is dropped.
               Ctrl / Cmd  : this node is added or removed, the rest is kept.

               This is the explorer's rule and it is the rule that makes
               everything else work:

                 - deselection is ALWAYS possible, because a plain click on a
                   selected node leaves only that node — one click, and the
                   others are gone;
                 - a multi-selection is still reachable, with the modifier;
                 - and there is only ONE thing to look at, because "selected"
                   and "focused" are the same list. The double ring went away
                   because there was one state to draw, not two.

               The earlier version made a plain click a no-op on an already
               selected node, to let a group be dragged without being
               dismantled. That is what made selection unreleasable: the only
               nodes that could leave were the ones that were not in it. The
               drag does not need the rule — it needs the nodes to BE
               selected, and Ctrl is right there. */
            if(flow){
                const additive=e.ctrlKey||e.metaKey
                flow.select(pilot,{additive})
            }
            globalThis.dispatchEvent(pilot.events.broadcast.nodeSelected)
            /* Only a node that ENDED UP selected opens its panels. Clicking one
               off must not shove its accordion to the top of the panel: that
               would make releasing a node feel identical to choosing it, and
               the panel would jump on every click of a multi-selection. */
            if(flow?.isSelected(pilot)){
                pilot.reveal()
            }
        }
        this.DOMelt.querySelector('rect').handleMouseDown=(e)=>e.target.pilot.drag(e)
        this.DOMelt.querySelector('rect').handleContextmenu=(e)=>{console.log(e)}
        this.DOMelt.querySelector('rect').handleKeyDown=(e)=>{
            if(e.key==="Delete"||e.key==="Backspace"){
                e.preventDefault()
                /* SUPPRIMER EFFACE LA SÉLECTION, PAS LE NŒUD FOCUSÉ.

                   This was `e.target.pilot.suicide()` — the focused node and
                   nothing else. With three nodes selected, Delete removed the
                   one under the focus ring and left the other two looking
                   selected, which is the worst of both: the selection says
                   "three things are marked" while one thing disappears, and
                   the two that remain cannot be deleted because the key does
                   not look at them.

                   The focus ring was not decoration, then: it was quietly
                   announcing WHICH node the next Delete would take, and the
                   user had no reason to believe the others were safe. */
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
    /* OUVRIR CE QUE CE NŒUD A, ET LE RAMENER EN HAUT.

       Cliquer sur un nœud doit répondre à une question qu'on se pose
       toujours: « où sont ses réglages? ». Un nœud dont l'accordéon est
       replié, ou enterré sous dix autres dans le panneau, ne répond à rien.

       Donc: on déplie, on remonte, et on fait les DEUX dans cet ordre. Dans
       l'autre ordre le défilement viserait une place devenue fausse — on
       aurait mesuré la position d'un accordéon qui n'existait pas encore à
       l'écran.

       LES DEUX PANNEAUX, ET C'EST NÉCESSAIRE: un nœud peut avoir un accordion
       à gauche (le trimmers, le pic picker) ET un graphique à droite (le
       plot). N'ouvrir que le premier laisserait la moitié de la node hors
       de vue, ce qui est pire que de n'en ouvrir aucune.

       LE SCROLL SE FAIT SUR LE PANNEAU, JAMAIS SUR L'ACCORDÉON. Faire
       `scrollIntoView` sur l'accordéon ferait défiler la page ENTIÈRE, donc
       le champ de nœuds remonterait sous la barre de menus: on perdrait le
       nœud qu'on vient de cliquer. On vise donc le conteneur, et on écrit
       son `scrollTop` — c'est le seul qui bouge. */
    reveal(){
        const panels=[this.accordion,this.accordionRight].filter(Boolean)
        for(const accordion of panels){
            /* unfold() d'abord, et seulement si le noeud sait se déplier: un
               accordéon détruit avec son nœud n'a plus de DOM à déplier, et
               l'appeler le ferait revenir. */
            if(accordion.parameters?.folded){
                accordion.unfold()
            }
            this.scrollPanelTo(accordion)
        }
    }
    /* Amène UN accordéon en haut de la zone visible de son panneau.

       On mesure l'écart entre le haut du panneau et celui de l'accordéon, et
       on l'ajoute au scroll courant. C'est un delta, pas une position
       absolue: la position absolue ferait sauter le panneau au haut de la
       liste à chaque clic, ce qui est exactement le contraire de « mettre au
       premier plan ce que je regarde ». */
    scrollPanelTo(accordion){
        const container=accordion.DOMelt?.container
        if(!container||!container.isConnected){
            return
        }
        //le panneau EST le conteneur qui défile: on remonte jusqu'à lui
        const panel=container.parentElement
        if(!panel){
            return
        }
        const containerTop=container.getBoundingClientRect().top
        const panelTop=panel.getBoundingClientRect().top
        const delta=containerTop-panelTop
        //un delta négatif signifie « il est déjà au-dessus de la zone visible»:
        //on le ressort alors à 0 pour ne pas mettre le panneau en négatif
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
        /* UN GLISSEMENT, UN GROUPE.

           If the dragged node is part of a selection of more than one, the
           WHOLE selection moves, rigidly: the same delta to each, so the group
           keeps its shape. Dragging one node out of a group would break it,
           and the user has no way to say "this one alone" other than clicking
           it empty first — which is the standard gesture everywhere else.

           The snapshot is taken HERE, before any pixel moves, because that is
           the only moment the "before" is true. Taking it on mouseup would
           record the position the node was dropped at as the starting point,
           and the undo would do nothing at all. */
        const group=[...flow.selectedNodes]
        const isGroup=group.length>1&&group.includes(pilot)
        const moved=isGroup?group:[pilot]
        const before=flow.selectionPositions()
        /* One fallback for the single-node case, which is the shape the rest of
           the file already speaks: a plain {x,y}. A group needs a Map, and a
           one-entry Map would force every reader to go through it. */
        const singleBefore={...pilot.parameters.position}
        for(const node of moved){
            //no transition while a node is dragged: a node that lags behind
            //the cursor feels broken, and the transition is only there to make
            //the automatic rearrangement readable
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
            /* A GROUP is only pinned if it really moved. Pinning a selection
               the user merely clicked would freeze a graph they were still
               arranging, and the next autoLayout would flow around nodes the
               user never placed. */
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
                //hand-placed: the automatic rearrangement now flows AROUND
                //this node. Only "Arrange nodes" takes the pins off.
                node.parameters.pinned=true
            }
            if(isGroup){
                /* ONE command for the whole group. One undo puts back the ten
                   nodes that moved together — which is the only definition of
                   "together" that an undo stack can express, and splitting it
                   would make Ctrl+Z take ten presses to undo one gesture. */
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
            //the command resolves the live node at execution time: the pilot
            //may have been deleted then restored by an undo in between
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
                //the "after" is COPIED here rather than read back from the node
                //at replay time: after an undo the node sits at `singleBefore`,
                //so reading it would make the redo a no-op
                redo:()=>resolveLive()?.setPosition(singleAfter)
            }))
        }
    }
    /* Moves the node and nothing else. The batch version: an arrangement moves
       every node at once and redraws the cables once at the end, instead of
       once per node. */
    applyPosition(position){
        this.parameters.position={...position}
        this.SVGg.attr('transform',`translate(${position.x},${position.y})`)
    }
    setPosition(position){
        this.applyPosition(position)
        this.destination.updateLinks()
    }
    /* "My output just changed, bring my descendants up to date."

       This is the ONLY re-resolve a node should trigger by itself. It is
       deliberately not resolveFlow(): a source node changing must not recompute
       the branches the user never touched. The knowledge of what is downstream
       belongs to the Flow, so the work is done there. */
    resolveChildren(){
        return this.destination?.resolveDescendantsOf(this)??Promise.resolve()
    }
    set status(value){
        const possible=['resolved','error','pending','floating']
        const rect=this.DOMelt.querySelector("rect")
        //`selected` is NOT in the list on purpose: it is orthogonal to the
        //status, and dropping it here would make a node blink out of the
        //selection every time it resolved — which is exactly when the user is
        //most likely to be looking at it.
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
        /* A deleted node cannot stay selected: the outline would sit on a
           detached element and dragging the group would move a node that is
           not in the flow. The rest of the selection SURVIVES, because
           deleting one node out of ten is not a reason to lose the other nine.
           An undo brings back a NEW instance, which is deliberately not
           reselected: the user deleted it, and having it come back already
           selected would be the app deciding on their behalf. */
        flow.selection.delete(this)
        //a deleted node cannot stay the current one either: the panel would
        //keep pointing at an accordion that no longer exists
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
    /* The one thing EVERY node gets back from a restore, and the reason it is
       here rather than copied into each class: an accordion is a fresh object
       after a reload, and a fresh accordion is open. A user who folded a node
       did it to get it out of the way, so a reload that unfolds it takes that
       choice back without touching anything they actually did.

       Subclasses that override this must call super. */
    restoreAfterImport(){
        if(this.restoredFolded){
            this.accordion?.fold()
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
    /* The pairs are the PARSE of raw, and a skeleton only carries the text, so
       re-parsing is what puts them back.

       The widget draws its table from those pairs, and the accordion was built
       at registration - with nothing in it. Without this re-render the node
       comes back with an EMPTY table, which reads as "my file is gone" rather
       than "not read yet".

       An exported session file still carries the pairs, and then the cached
       source makes the re-parse a no-op: what is rebuilt here is the skeleton. */
    restoreAfterImport(){
        super.restoreAfterImport()
        if(reparseRestoredSource(this)){
            this.renderAccordion()
        }
    }
}

/* classifier: a line through the origin, death = slope Ã— birth. Superlevel
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
//The 3Ïƒ convention, and the value the kernel returns when it has no population
//to read a z from. Named because "3" appears as a DEFAULT in three places that
//have to agree, and a literal in each of them is how they drift apart.
const CONVENTIONAL_Z=3
//slope of a line that keeps every pair with a positive birth (birth â‰¤ 0
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

/* -----------------------------------------------------------------
   Trimmer method registry. Methods are DATA, not code branches: the node
   asks the registry for the list, for the fields to render, and for the
   hint, so adding one later touches nothing in the shell. Where the method
   places the cursors is the KERNEL's job (trim.rs), not the shell's: a
   ratio invented here would silently override it.
   ---------------------------------------------------------------- */
//3 significant digits for a cursor position. toPrecision already switches to
//scientific notation once the exponent reaches the precision, so 100000
//renders as 1.00e+5 with no extra branching, and parseFloat reads it back.
const formatCursorValue=(value)=>{
    const numeric=Number(value)
    if(!Number.isFinite(numeric)) return ""
    return numeric===0?"0":numeric.toPrecision(3)
}

//A two-state scale switch whose TWO labels are always visible and the active one
//is simply coloured. The previous version rewrote the button text instead, which
//made the control jump and left the user guessing what the other state was
//called. Trimmer and PersistentHomology0D share the shape, not the labels.
function scaleToggle({get,set,leftLabel,rightLabel,title}){
    //one contiguous control, not two floating buttons: the border and the radius
    //live on the wrapper so the two halves read as a single object
    const wrap=CE("span",{
        title,
        style:{
            display:"inline-flex",
            border:"1px solid rgba(255,255,255,0.18)",
            borderRadius:"4px",
            overflow:"hidden"
        }
    },[])
    const paint=()=>{
        const on=get()
        for(const [button,isOn] of [[left,!on],[right,on]]){
            //the active side carries the accent, the other recedes
            button.style.color=isOn?"#c9e02b":"rgba(255,255,255,0.45)"
            button.style.background=isOn?"rgba(201,224,43,0.14)":"transparent"
        }
    }
    const make=(label,value)=>{
        const button=CE("button",{
            type:"button",
            style:{cursor:"pointer",padding:"2px 7px",borderRadius:"0",border:"none",font:"inherit"}
        },[label])
        button.addEventListener("click",()=>{
            set(value)
            paint()
        })
        return button
    }
    const left=make(leftLabel,false)
    const right=make(rightLabel,true)
    wrap.append(left,right)
    paint()
    wrap.paint=paint
    return wrap
}

const TRIM_METHODS={
    passthrough:{
        label:"No trim (pass-through)",
        hint:"The spectrum passes through untouched.",
        fields:[]
    },
    madResidual:{
        label:"kÂ·MAD on moving-average residual",
        hint:"Cuts below the baseline plus k times the noise. k is the rejection multiplier (5 keeps ~99.3% of a Gaussian; 1.96 would be 95%), and the window is the width of the moving average the noise is measured on.",
        //k and window are part of the PUBLISHED method, so they stay editable.
        //k is a multiplier, not a threshold: it means nothing without the sigma
        //it multiplies, which the kernel estimates from the data.
        fields:[
            {key:"k",value:5,min:1,step:0.1,title:"Rejection multiplier on the noise"},
            {key:"window",value:9,min:3,step:2,title:"Width of the moving average the noise is measured on"}
        ]
    },
    intensityThreshold:{
        label:"Intensity threshold",
        hint:"Drops every point below the threshold, which the cursor shows and you can drag. Type a value here to seed that cursor when the method is picked or Guess is pressed.",
        //The field seeds the cursor; the cursor remains what actually trims, so a
        //number typed here is a starting point and nothing more.
        fields:[
            {key:"threshold",value:0.1,min:0,step:"any",
                title:"Intensity under which every point is dropped"}
        ]
    }
}

//Cursor palette, taken from the node chrome rather than invented: lime is the
//app accent, and the two bounds must not collide with the bar gradient, which is
//itself green. Cyan reads as "cut" and magenta as "ceiling" on a dark ground.
const TRIM_LOW_COLOR="#00d4ff"
const TRIM_HIGH_COLOR="#ff5fd0"
const CURSOR_COLORS=[["lowBound",TRIM_LOW_COLOR],["highBound",TRIM_HIGH_COLOR]]
//Labels and lines are deliberately heavier than the rest of the node: the cursor
//IS the control, and on a busy histogram a 1px line disappears into the bars
const TRIM_CURSOR_STROKE=2.5
const TRIM_CURSOR_FIELD_FONT="0.95em"
class TrimmerNode extends NodeWithAccordion{
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
        const inputAnchors=this.DOMelt.querySelectorAll('.input.anchor')
        if(inputAnchors[0]) inputAnchors[0].innerHTML='<title>Input: one Wave (XY or 1D)</title>'
        const outputAnchors=this.DOMelt.querySelectorAll('.output.anchor')
        if(outputAnchors[0]) outputAnchors[0].innerHTML='<title>Output: trimmed Wave</title>'
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
    quantileThreshold(fraction=0.05){
        const bins=this.bins
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
    effectiveThreshold(){
        const set=this.parameters.methodParams?.threshold
        return Number.isFinite(set)?set:this.quantileThreshold(0.05)
    }

    //Value axis domain for the CURRENT scale mode. On a log axis the histogram
    //already reports the smallest and the LARGEST POSITIVE value (log10 of 0 is
    //undefined), so there is no "half a bin width" fudge left to invent: the
    //honest floor is the data minimum. The padding is multiplicative, a tenth
    //of a decade each side, because an additive margin would vanish next to a
    //spectrum spanning thousands.
    trimValueDomain(){
        const [low,high]=this.linearValueDomain
        if(!this.parameters.logY) return [low,high]
        if(!(high>0)){
            return [1,10]//no data at all: a readable empty frame beats NaN
        }
        const pad=Math.pow(10,0.1)
        /* The "strictly positive" floor above is a property of the KERNEL's
           report, not of this function, and the two states of a node disagree:
           before the first resolve linearValueDomain is still the constructor's
           [0,100000] placeholder. 0/pad is 0, and clamping it to
           Number.MIN_VALUE is far worse than useless on a log axis - that is
           4.9e-324, i.e. -323 decades, so the frame shows one sliver of bars
           under 323 empty ones, and a restored node sits like that until the
           user resolves. With no floor to honour, six decades under the top is
           the smallest assumption a reader can interpret. */
        const floor=low>0?low:high/1e6
        return [Math.max(floor/pad,Number.MIN_VALUE),high*pad]
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
    //
    //A NaN bound sent to the kernel means "you decide": the kernel then reports
    //its own threshold, which is exactly the value a guess needs. passthrough
    //reports -Infinity (it trims nothing), which is useless as a cursor
    //position, so it is mapped onto the frame instead: bottom and top.
    async seedBoundsFromKernel(){
        const inputWave=this.lastInputWave
        const domain=this.trimValueDomain()
        if(!domain.every(Number.isFinite)) return
        if(!inputWave){
            this.resetBoundsToFrame()
            this.refreshTrimmerUI()
            return
        }
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
                    threshold:this.effectiveThreshold()
                }
            })
            //The threshold is used AS IS: it may sit below the data range (a
            //legitimate "keep everything" setting) or above it. Clamping it into
            //the frame used to push a threshold of 0.1 up onto the data
            //minimum, which silently disabled the whole trim. Only a
            //non-finite answer - passthrough returns -Infinity - is replaced.
            this.parameters.lowBound=Number.isFinite(guess)?guess:domain[0]
            this.parameters.highBound=domain[1]
        }catch(err){
            console.warn("[TrimmerNode] guess failed, resetting the cursors to the frame:",err)
            this.resetBoundsToFrame()
        }
        this.refreshTrimmerUI()
    }
    //The Guess button, and the method-change path: seed the cursors from the
    //kernel, then actually trim with them.
    async guessFromKernel(){
        await this.seedBoundsFromKernel()
        await this.applyTrimBounds()
    }
    //Re-runs ONLY the trim kernel on the already-known input wave. The frame
    //stays untouched: a drag must not rescale the axis the user is dragging on.
    async applyTrimBounds(){
        const inputWave=this.lastInputWave
        if(!inputWave) return
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
            //data-driven quantile, so the box is never a misleading 0
            const shown=field.key==="threshold"&&!Number.isFinite(this.parameters.methodParams?.threshold)
                ?this.effectiveThreshold()
                :(params[field.key]??field.value)
            input.value=formatCursorValue(shown)
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
            this.keptLabel.textContent=`${this.trimResult.keptCount}/${this.trimResult.totalCount}`
        }
        this.graph?.drawGraph()
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
        //First paint, no data yet: seed the cursors once. With a wave connected,
        //startResolve has already placed them from the kernel, and this block
        //stays out of the way - it must never move a hand-placed cursor.
        if(!Number.isFinite(this.parameters.highBound)){
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
    async startResolve(){
        //Only the INPUT is constrained to a single link. The previous check
        //counted the links whose inputNode is this one, which - as childrenMap()
        //shows - are its CONSUMERS: wiring the trimmed wave to a second node
        //made the trimmer refuse to resolve, even though fan-out on the output
        //is none of its business.
        const inputLinks=(this.destination?.linkList??[]).filter(link=>link.outputNode===this)
        if(inputLinks.length>1||inputLinks.some(link=>link.inputAnchor.id!=="0")){
            this.status="error"
            this.outputs[0]=[]
            console.error("[TrimmerNode] exactly one link on input 0 is required")
            return
        }
        const input=this.inputs[0]
        let inputWave=null
        if(input instanceof Map){
            for(const values of input.values()){
                for(const waves of values){
                    const found=Array.isArray(waves)
                        ?waves.find(wave=>wave instanceof Wave)
                        :(waves instanceof Wave?waves:null)
                    if(found){inputWave=found;break}
                }
                if(inputWave) break
            }
        }
        if(!inputWave){
            this.status="floating"
            this.outputs[0]=[]
            //the wave is gone: a later drag must not trim a stale input
            this.lastInputWave=null
            this.refreshTrimmerUI()
            return
        }
        this.status="pending"
        this.lastInputWave=inputWave
        const stride=inputWave.degree===2&&inputWave.dims[1]===2?2:1
        const methodParams=this.methodParams()
        try{
            //the frame is drawn from the FULL wave, before any trimming: the
            //user places the cursors on the input distribution, not on the
            //already-cut one
            const histogram=await computePool.run("trimHistogram",{
                core:inputWave.core,
                //the binning follows the AXIS scale: on a log axis the bars must
                //be evenly spaced in decades, otherwise every point piles into
                //the first bar and the distribution is unreadable
                params:{
                    stride,
                    //an upper bound: in log mode the kernel derives the real bar
                    //count from the span of the data (bars per decade), because a
                    //fixed count over a 2-decade spectrum comes out mostly empty
                    bins:TrimmerNode.HISTOGRAM_BINS,
                    scale:this.parameters.logY?"log":"linear"
                }
            })
            this.histogramDropped=histogram.dropped??0
            //Array.from first: Float64Array.prototype.map returns a Float64Array,
            //not an array of objects, so mapping the typed array straight through
            //would silently produce a buffer of NaN instead of the bin objects
            const centres=Array.from(histogram.centres)
            this.bins=centres.map((value,index)=>({value,count:histogram.counts[index]}))
            this.linearValueDomain=this.valueDomainFromBins(histogram)
            this.pinTrimDomains()
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
    /* What this node IS, as opposed to what it computed.

       This is the only durable record of the settings. The undo stack cannot
       be one: a Command holds closures, and closures do not serialize, so the
       history dies with the tab whatever we do. The trimmer had neither half of
       this, and an exported session came back as a pass-through with no window
       - a silent loss of the one number the user had tuned. */
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

/* -----------------------------------------------------------------
   F-KMD: Formula - Kendrick Mass Defect.

   A formula is TYPED (the accordion, unchanged) and its m/z drives a
   KENDRICK analysis of every input wave. It became an Operation, so it
   now has one input and one output: the input waves go in, one product
   wave per input comes out.

   Several links may land on the SAME input anchor. They are processed
   INDEPENDENTLY and one after another, each producing its own product:
   the outputs of a node are a list, so a list is exactly what a list of
   inputs deserves. Nothing is merged, because merging spectra of
   different sizes and different F-KMD transforms would be a decision
   nobody asked for.

   The kernel is named "fkmd" already, and today it only copies the input
   XY through (see kernelWorker.js). The Rust side will be fkmd.rs, beside
   persistence.rs and trim.rs, and it will return a flat XY array. Nothing
   here will have to be renamed when it lands.
   ---------------------------------------------------------------- */
class FKMDNode extends NodeWithAccordion{
    constructor(title,origin,destinationFlow,position={x:180,y:10}){
        //one input (XY wave: X=mass, Y=intensity), one output
        super(title,[[]],[[]],origin,destinationFlow,position)
        this.status="floating"
        //the notation, exactly as typed. The grammar is chemistry.js's
        //("C6H12O6 [H+]", "12C6 1H12 16O6 [2H+]"...). The notation is parsed
        //as soon as it is TYPED (live feedback), but the m/z it yields only
        //reaches the kernel when the user commits with ENTER.
        //"C": the smallest formula that still says something, and a real one. It
        //gives the widget a reading on the first screen instead of a blank
        //field, and it is easy to overwrite because it is a single character.
        this.parameters.notation="C"
        //the formula READ, or null. Note: it is no longer the output - the
        //output is now a list of F-KMD product waves, one per input wave.
        this.formula=null
        //the reading error, shown as-is
        this.parseError=null
        //monotonic ticket: only the newest keystroke may publish its reading
        this.resolveRun=0
        //a second ticket, for the kernel: a commit and a typing in between
        //must not let a stale m/z reach the products
        this.kernelRun=0
        //the input waves, read at the last resolve
        this.inputWaves=[]
        const inputAnchors=this.DOMelt.querySelectorAll('.input.anchor')
        if(inputAnchors[0]) inputAnchors[0].innerHTML='<title>Input: one or more XY waves (X=mass, Y=intensity)</title>'
        const outputAnchors=this.DOMelt.querySelectorAll('.output.anchor')
        if(outputAnchors[0]) outputAnchors[0].innerHTML='<title>Output: one F-KMD product wave per input wave</title>'
    }
    registered(e){
        if(e.detail.msg.caster!==this||this.accordion){
            return
        }
        super.registered(e)
        this.setupFormulaUI()
        //read the default notation, but do NOT run the kernel: the node has no
        //input yet, and a resolve that finds no wave would only publish an
        //empty output. The formula is shown; the products come on the first
        //commit, once something is linked.
        this.readFormula()
    }
    setupFormulaUI(){
        if(!this.accordion) return
        const content=this.accordion.DOMelt.content
        content.replaceChildren()
        /* "content" sizing, not "viewport": the panel is an input line and a
           short readout, so it should be exactly as tall as what it holds. The
           fixed viewport height is for the nodes that embed a WebGL plot
           (Trimmer, PersistentHomology), where a height following the content
           would feed back into the plot's own measuring. There is no plot here,
           and a 260 px box around two rows is mostly emptiness.

           setSizingMode("content") puts the content back to display:block and
           height:auto, so the grid below is ours to define freely: one column,
           rows sized by what they hold. No height:100% and no minmax(0,1fr) -
           both exist to tame a BOUNDED box, and there is no bound here. */
        this.accordion.setSizingMode("content")
        stylize(content,{
            display:"grid",
            "grid-template-columns":"minmax(0, 1fr)",
            padding:"4px",
            gap:"4px"
        })
        //la notation est LE contenu du noeud: une seule ligne, large
        this.notationInput=CE("input",{
            type:"text",
            value:this.parameters.notation,
            spellcheck:false,
            title:"Chemical formula, composition then ionisation between brackets"
        },[])
        stylize(this.notationInput,{
            width:"100%",
            boxSizing:"border-box",
            fontFamily:"inherit",
            fontSize:"0.9em",
            padding:"4px 6px",
            borderRadius:"4px"
        })
        //ENTER commits: it re-reads the formula, sends the m/z to the kernel
        //for every input wave, and then brings the DESCENDANTS up to date.
        //Two things stay out of its reach: the rest of the flow (the branches
        //this node does not feed) and the parents (their outputs are already
        //in memory, re-resolving them would redo work nobody asked for).
        this.notationInput.addEventListener("keydown",(e)=>{
            if(e.key==="Enter"){
                e.preventDefault()
                this.startResolve().then(()=>this.resolveChildren())
            }
        })
        //EVERY keystroke only READS the formula: the m/z is displayed as it is
        //typed, so a wrong symbol is seen at once. The kernel is NOT run on
        //each key - one commit may cost a dozen kernel runs on a dozen spectra.
        this.notationInput.addEventListener("input",()=>{
            this.parameters.notation=this.notationInput.value
            this.readFormula()
        })
        content.append(this.notationInput)
        //the readout: composition, charge, m/z - or the reading error. Three
        //short lines, so it grows with its text: no overflow:auto, which would
        //only hide the last line behind a scrollbar nobody asked for
        this.readout=CE("div",{
            style:{
                fontSize:"0.85em",
                opacity:"0.85",
                padding:"2px 4px",
                whiteSpace:"pre-wrap"
            }
        },[])
        content.append(this.readout)
        this.renderReadout()
    }
    //the table belongs to the ORIGINE (the App that owns this node), never to a
    //global: two Apps may carry two different tables, and a node can never
    //parse with another window's table.
    //It AWAITS tableReady rather than reading origin.table: the App loads in the
    //background, so an immediate read would report "no table" for a table still
    //in flight, and the node would look broken for a few hundred ms.
    //The App fetches eagerly rather than lazily ON PURPOSE (speed of use, see
    //the App constructor): the wait lands here, once, and only when a formula
    //is actually parsed.
    async table(){
        if(this.origin.table) return this.origin.table
        await this.origin.tableReady
        return this.origin.table??null
    }
    /* Reads the formula, then transforms every input wave with its m/z.

       Split in two, because the two have different jobs and different guards:
         - readFormula() runs on every keystroke and publishes this.formula. It
           touches NOTHING else: live feedback on the notation is cheap.
         - applyKernel() runs on commit, and is what publishes outputs[0].
       A keystroke between a commit and the kernel returning must not publish
       products computed from a formula the user has already changed - hence
       kernelRun, checked after every await. */
    async startResolve(){
        await this.readFormula()
        await this.applyKernel()
    }
    /* Parses the notation and publishes the formula. NEVER throws: a typing
       mistake is a result, not an exception, or resolveFlow would stop here.

       It does NOT claim "resolved" on success. Reading "C" is not a result of
       this node: the node's result is a list of F-KMD products, and it has none
       until the kernel runs. Only applyKernel() may set "resolved", and only
       after it has actually produced waves. A node that showed green the moment
       a letter was typed would claim work it never did. */
    async readFormula(){
        const run=++this.resolveRun
        const notation=this.parameters.notation
        const table=await this.table()
        if(run!==this.resolveRun) return null   // a newer keystroke already won
        if(!table||!notation.trim()){
            this.formula=null
            this.parseError=null
            this.setStatus("floating")
            this.renderReadout()
            return null
        }
        try{
            this.formula=Formula.parse(notation,table)
            this.parseError=null
            //"floating", not "resolved": a formula is READ, the node is not DONE
            this.setStatus("floating")
        }catch(err){
            this.formula=null
            this.parseError=err.message
            this.setStatus("error")
        }
        this.renderReadout()
        return this.formula
    }
    /* The m/z the kernel will use, or null when there is nothing to apply.

       It is read from this.formula at CALL time, not re-derived from the
       notation: the m/z is a RESULT of the parsing, and computing it twice
       would give the kernel a second, divergent path to the same number. */
    formulaMz(){
        return this.formula?this.formula.mz:null
    }
    renderReadout(){
        if(!this.readout) return
        if(this.parseError){
            this.readout.textContent=this.parseError
            return
        }
        if(!this.formula){
            //no formula yet: either nothing typed, or the table is still
            //loading. The origin says which, and a node that guessed would
            //tell the user the table is missing while it downloads.
            this.readout.textContent=this.origin.tableError
                ?`table pÃ©riodique indisponible: ${this.origin.tableError}`
                :""
            return
        }
        const f=this.formula
        const lines=[
            Formula.compositionToString(f.composition,f.rule),
            `charge ${f.charge>0?"+":""}${f.charge}`,
            `m/z ${f.mz.toFixed(6)}`
        ]
        //the kernel side: how many spectra went in, how many came out. Without
        //it, a node with three products and three inputs is indistinguishable
        //from one that silently dropped two.
        if(this.skippedInputs){
            lines.push(`${this.skippedInputs} entrÃ©e(s) ignorÃ©e(s): pas une wave XY`)
        }
        for(const err of this.kernelErrors??[]){
            lines.push(`kernel: ${err}`)
        }
        this.readout.textContent=lines.join("\n")
    }
    /* Every XY wave linked to the input anchor, in link order.

       The input is what parentSynapse builds: Map<parent, Array<Array<Wave>>>,
       one inner array per LINK, each holding that output slot's waves. Three
       levels is not a design choice, it is the shape the synapse leaves, and
       reading it wrongly would yield an output silently short by one level -
       hence the explicit Array.isArray at each step.

       Several links may land on the SAME anchor: the walk visits each of them,
       so each contributes its own waves and, later, its own product. A 1D wave
       is skipped and COUNTED rather than dropped: a node that silently forgot
       two of three spectra would look exactly like one that worked. */
    collectInputWaves(){
        const input=this.inputs[0]
        const waves=[]
        let skipped=0
        if(input instanceof Map){
            for(const values of input.values()){
                for(const parentOutputs of values){
                    if(!Array.isArray(parentOutputs)) continue
                    for(const wave of parentOutputs){
                        if(!(wave instanceof Wave)) continue
                        if(wave.degree!==2||wave.dims[1]!==2){
                            skipped++
                            continue
                        }
                        waves.push(wave)
                    }
                }
            }
        }
        return {waves,skipped}
    }
    /* Sends each input wave to the kernel, one call at a time, and collects
       the products.

       SEQUENTIALLY, not Promise.all: the worker pool holds a few workers, and
       a fan-out would queue every wave at once. A dozen spectra would each
       pay a postMessage copy of a multi-megabyte core, and the UI would stall
       on all of them instead of one at a time. Sequential keeps the memory
       peak at a single core.

       A wave the kernel fails on does not stop the others: it is recorded and
       the resolve continues. One broken spectrum is one broken result, not a
       dead node. */
    async applyKernel(){
        const mz=this.formulaMz()
        const {waves,skipped}=this.collectInputWaves()
        this.inputWaves=waves
        this.skippedInputs=skipped
        if(mz===null||!waves.length){
            this.outputs[0]=[]
            this.kernelErrors=[]
            this.setStatus(mz===null?(this.parseError?"error":"floating"):"floating")
            this.renderReadout()
            return
        }
        const run=++this.kernelRun
        const products=[]
        const errors=[]
        for(const wave of waves){
            try{
                //the core is structured-cloned, never transferred: the INPUT
                //wave must keep its buffer, it belongs to the parent node and
                //to every other link that reads it
                const result=await computePool.run("fkmd",{
                    core:wave.core,
                    //the m/z is the whole parameter: the kernel derives
                    //round(mz)/m/z itself, once, and needs nothing else
                    params:{mz}
                })
                if(run!==this.kernelRun) return   // superseded: publish nothing
                const core=result?.core
                if(!(core instanceof Float64Array)||core.length%2){
                    errors.push(`the kernel returned ${core?.length??"nothing"}, not a flat XY`)
                    continue
                }
                if(core.length===0){
                    //the kernel REFUSED this m/z (non-finite, or it rounds to
                    //zero). An empty result is an answer, not a failure and not
                    //a zero-point wave: publishing the latter would put a dead
                    //wave in the graph and count as a success
                    errors.push(`m/z ${mz} gives no scale: nothing to divide by`)
                    continue
                }
                const pointCount=core.length/2
                //subarray, not slice: the core is ours (freshly returned by the
                //worker) and copying it twice would halve what we just paid for
                const x=core.subarray(0,pointCount)
                const y=core.subarray(pointCount)
                products.push(Wave.fromCoordinates(x,y,{
                    title:`${this.title} (F-KMD)`,
                    //the three things that say WHAT this wave is: the method,
                    //the key, and the m/z the transform came from
                    "f-kmd":true,
                    key:this.parameters.notation,
                    mz
                },["x","y"]))
            }catch(err){
                if(run!==this.kernelRun) return
                errors.push(err.message??String(err))
            }
        }
        if(run!==this.kernelRun) return
        this.kernelErrors=errors
        this.outputs[0]=products
        //"error" only if NOTHING came out: a partial success is a success, and
        //a node painted red over three good products would be a lie
        this.setStatus(errors.length&&!products.length?"error":"resolved")
        this.renderReadout()
    }
    setStatus(status){
        this.status=status
        dispatchEvent(this.events.broadcast.nodeStatusChanged.call(this,status))
    }
    serializeState(){
        return {
            notation:this.parameters.notation
        }
    }
    restoreState(state){
        if(typeof state?.notation==="string"){
            this.parameters.notation=state.notation
        }
        if(this.notationInput) this.notationInput.value=this.parameters.notation
        //the Formula is NOT saved, and neither are the products: both are derived
        //from the notation, from the table and from the input waves, all of
        //which may have changed since. The reading is restored so the widget is
        //not blank; the products come on the first commit, because re-running
        //the kernel here would resolve this node outside the flow's own order.
        this.readFormula()
    }
}

class PeakPickingNode extends NodeWithAccordion{

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

        // Tooltips on SVG anchors for clarity
        const inputAnchors=this.DOMelt.querySelectorAll('.input.anchor')
        if(inputAnchors[0]) inputAnchors[0].innerHTML='<title>Input: one Wave (XY or 1D)</title>'
        const outputAnchors=this.DOMelt.querySelectorAll('.output.anchor')
        if(outputAnchors[0]) outputAnchors[0].innerHTML='<title>Output: the picked peaks</title>'
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
       measurement and only differ in what they do with the answer. */
    async readZFromKernel(){
        const profile=this.lastInputWave
        const indices=this.persistenceKeptIndices
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

    //slope of the line through the origin and the centroid of the pairs â€”
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
        return this.destination?.linkList?.filter(link=>link.outputNode===this)??[]
    }

    fail(message){
        this.status="error"
        this.outputs[0]=[]
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

    async startResolve(){
        //Only the INPUT is constrained to a single link. The previous check
        //counted the links whose inputNode is this one, which - as childrenMap()
        //shows - are its CONSUMERS, and refused to resolve as soon as two nodes
        //consumed the output. That was a latent bug until the node grew a second
        //output; it is now plainly a single-output node, and the check is the
        //one TrimmerNode uses (see the note there). Fan-out on the OUTPUT is
        //none of this node's business.
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
            /* The integrated mass and its centroid, kept beside the births.
               NOT thrown away here: `pointsY` is the intensity of the single
               point that BORN each component — its chief — so it is what the
               output used to carry, and it is exactly the number the union-find
               integration exists to replace. */
            this.persistenceIntegratedMass=analysis.integratedMass
            this.persistenceCentroidX=analysis.centroidX
            this.pairsData={count:this.persistenceBirths.length}
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
        //the classified points, held in memory rather than published: the
        //anti-radio stage reads them together with their indices, and the OUTPUT
        //is whatever survives both stages.
        this.persistenceKeptPointsX=classification.keptPointsX
        this.persistenceKeptPointsY=classification.keptPointsY
        this.persistenceKeptIndices=classification.keptIndices
        this.persistenceKeptCount=classification.keptCount
        /* THE MASS BECOMES THE PEAK'S INTENSITY, and this is the line the whole
           integration turned on.

           `keptPointsY` is the intensity of the point that BORN each component
           — its chief. It was the node's output Y, which is why the union-find
           could sum intensities forever and nothing would change on screen: the
           sum was computed, carried, and then the chief was published instead.

           So the published Y is the integrated mass, falling back to the chief
           only when the kernel did not supply one (a stale pkg build). The
           fallback is explicit rather than silent, because "the area is missing"
           and "the area is zero" must not look alike. */
        this.persistenceKeptMass=classification.keptIntegratedMass
        this.persistenceKeptCentroidX=classification.keptCentroidX
        const keptMass=this.persistenceKeptMass
        const hasMass=keptMass&&keptMass.length===classification.keptPointsX.length
            &&keptMass.every(v=>Number.isFinite(v))
        this.persistencePublishedY=hasMass?keptMass:classification.keptPointsY

        //The auto z runs HERE, between the classification and the filter: the
        //guess measures the CLASSIFIED peaks at their input indices, so those
        //indices must exist first. Placing it after this one call is also what
        //keeps a resolve at a single classifier run instead of two.
        await this.resolveZIfUnset()

        await this.applyAntiRadio()

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
        if(this.countLabel) this.countLabel.textContent=`${classification.keptCount}/${pairCount}`
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
            /* The filter DROPS peaks, so `result.pointsX` is SHORTER than the
               array it was given, and the mass has to be filtered by the SAME
               mask or the two columns would no longer line up — the mass of one
               peak sitting under the name of another, which is worse than no
               mass at all.

               `isRadio` is that mask: 1 means dropped, 0 means kept, and it is
               aligned with the INPUT arrays, so it walks the mass in step with
               the peaks. */
            const keptMass=this.persistenceKeptMass
            const mask=result.isRadio
            const filteredMass=(keptMass&&mask&&keptMass.length===px.length)
                ?Float64Array.from(mask.reduce((acc,dropped,i)=>{
                    if(!dropped) acc.push(keptMass[i])
                    return acc
                },[]))
                :null
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
    publishOutput(pointsX,pointsY,kept){
        this.outputs[0]=kept&&pointsX?.length
            ?[Wave.fromCoordinates(pointsX,pointsY,{
                title:`${this.title} (peaks)`,
                slope:this.parameters.slope,
                z:this.parameters.z,
                kept,
                total:this.persistenceKeptCount??kept
            },["x","y"])]
            :[]
    }

    updateControlsUI(){
        if(this.slopeInput && Number.isFinite(this.parameters.slope)){
            this.slopeInput.value = formatSlope(this.parameters.slope)
        }
        if(this.countLabel && this.pairsData){
            const keptCount = this.outputs[0]?.[0]?.dims?.[0] ?? 0
            this.countLabel.textContent = `${keptCount}/${this.pairsData.count}`
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

        const slope = this.parameters.slope
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
class ChatNode extends Node{
    constructor(title,origin,destinationFlow,position={x:180,y:10}){
        super(title,[],[],origin,destinationFlow,position)
        this.status="floating"
        /* What the user typed, kept apart from the live connection:
           `parameters` is what a session stores, and this.socket is what this
           visit owns. Serialising a live WebSocket would put a connection
           object in the session file. */
        this.parameters.url=""
        this.parameters.nick=""
        this.parameters.room=""
        this.socket=null
        /* The backoff is exponential, as in the prototype, and CAPPED: a server
           that is down must not leave a retry loop running in a background tab
           for the rest of the session. */
        this.reconnectAttempt=0
        this.maxReconnectAttempts=10
        this.reconnectTimer=null
        this.dialog=null
    }
    /* The URL to dial: what the user typed, or the page's own host.

       Deriving it from the page is what makes the prototype work with no setup
       on the same host, and the choice of wss on https is not cosmetic — a
       secure page may not open an insecure socket, and the browser refuses it
       with an error nobody reads. The field stays editable for every other
       case, rather than the host being hard-coded and working on exactly one
       machine. */
    effectiveUrl(){
        if(this.parameters.url?.trim()){
            return this.parameters.url.trim()
        }
        const protocol=location.protocol==="https:"?"wss:":"ws:"
        return `${protocol}//${location.host}`
    }
    registered(e){
        const {channel,registrationName,label,caster}=e.detail.msg
        if(caster!==this||this.dialog){
            return
        }
        /* A Dialog, like every graph: the chat can be dragged, folded and
           closed with the same gestures as the rest. It is NOT an Accordion —
           a chat that collapsed when the panel scrolled past would be
           unusable, and the side panels are where the field toggles live. */
        this.dialog=new Dialog(label,this.origin,this.origin.midCentralContent)
        stylize(this.dialog.DOMelt.window,{
            top:"8%",
            left:"8%",
            width:"84%",
            height:"70%"
        })
        channel.register(`${registrationName}:chat`,this.dialog,`${label} chat`)
        this.render()
        this.connect()
    }
    render(){
        const content=this.dialog.DOMelt.content
        content.replaceChildren()
        stylize(content,{
            display:"grid",
            //a row for the connection bar, one for the log, one for the input
            "grid-template-rows":"auto minmax(0,1fr) auto",
            height:"100%",
            minHeight:"0",
            overflow:"hidden",
            padding:"4px",
            gap:"4px"
        })
        /* --- the bar: where we are, and whether we are connected ---------- */
        this.statusLabel=CE("div",{className:"chat-status"},["Not connected"])
        //a field per setting, each writing straight to `parameters`: no apply
        //button, because a chat that needs confirming before it remembers your
        //nick is a chat you use twice
        const urlField=CE("input",{
            type:"text",
            value:this.parameters.url,
            placeholder:"ws://host — empty means this page",
            title:"WebSocket URL of the chat server. Leave empty to use this page's own host."
        },[])
        urlField.addEventListener("change",()=>{
            this.parameters.url=urlField.value.trim()
        })
        const nickField=CE("input",{
            type:"text",size:8,
            value:this.parameters.nick,
            placeholder:"nick",
            title:"The name you post under"
        },[])
        nickField.addEventListener("change",()=>{
            this.parameters.nick=nickField.value.trim()
        })
        const roomField=CE("input",{
            type:"text",size:8,
            value:this.parameters.room,
            placeholder:"room",
            title:"The room to join. Leave empty to see the list of rooms."
        },[])
        roomField.addEventListener("change",()=>{
            this.parameters.room=roomField.value.trim()
        })
        const joinButton=CE("button",{type:"button"},["Join"])
        joinButton.addEventListener("click",()=>{
            //a full reconnect, not a re-join: the URL or the nick may have
            //changed, and the old socket is pointed at the wrong place
            this.disconnect()
            this.reconnectAttempt=0
            this.connect()
        })
        const bar=CE("div",{className:"chat-bar"},[
            this.statusLabel,urlField,nickField,roomField,joinButton
        ])
        /* --- the log ------------------------------------------------------- */
        this.log=CE("div",{className:"chat-log"},[])
        /* --- the input ----------------------------------------------------- */
        this.inputField=CE("input",{
            type:"text",
            placeholder:"Your message...   (Enter to send)",
            maxLength:500
        },[])
        this.inputField.addEventListener("keydown",(event)=>{
            if(event.key!=="Enter"){
                return
            }
            /* Enter POSTS and never inserts a newline: the box is one line
               tall and Enter is the only way to send. Without preventDefault
               the key would also reach whatever form encloses the dialog. */
            event.preventDefault()
            this.send()
        })
        content.append(bar,this.log,this.inputField)
    }
    append(text,className=""){
        if(!this.log){
            return
        }
        const line=CE("div",{className:`chat-line ${className}`},[])
        /* The prototype builds its lines with innerHTML, which would let
           anyone in the room inject markup into this page. Here the text goes
           in as TEXT, always: a chat room is untrusted input, and the only
           thing that changes is a CSS class we chose ourselves. */
        line.textContent=text
        this.log.appendChild(line)
        //stick to the bottom, the way a log reads
        this.log.scrollTop=this.log.scrollHeight
    }
    setStatus(text,connected){
        if(this.statusLabel){
            this.statusLabel.textContent=text
        }
        /* The node's own colour follows the connection, so the FIELD says the
           chat is down even when the chat window is hidden behind something
           else. */
        this.status=connected?"resolved":"floating"
    }
    connect(){
        const nick=this.parameters.nick.trim()
        if(!nick){
            /* No nick, no connection. Asking is better than posting as
               "Anonyme", which is what the server would default to: a room
               full of anonymes is a room where nobody can tell who said what. */
            this.setStatus("A nick is required",false)
            return
        }
        const url=this.effectiveUrl()
        let socket
        try{
            socket=new WebSocket(url)
        }catch(error){
            /* A malformed URL THROWS here rather than firing onerror, and an
               uncaught throw would leave the node claiming to be connecting to
               a URL that does not exist. */
            this.setStatus(`Cannot open ${url}`,false)
            return
        }
        this.socket=socket
        this.setStatus("Connecting...",false)
        socket.addEventListener("open",()=>{
            this.reconnectAttempt=0
            /* A named room is joined straight away; with no room, the server
               sends its list, which is exactly what an empty field asks for.
               Joining on open rather than on submit is what makes a restored
               session rejoin the room it was in. */
            if(this.parameters.room.trim()){
                this.transmit({type:"join_room",room:this.parameters.room.trim(),name:nick})
            }
        })
        socket.addEventListener("message",(event)=>{
            let data
            try{
                data=JSON.parse(event.data)
            }catch{
                //a server speaking another protocol is not a crash
                return
            }
            this.onServerMessage(data)
        })
        socket.addEventListener("close",()=>{
            this.socket=null
            this.setStatus("Disconnected",false)
            this.scheduleReconnect()
        })
        socket.addEventListener("error",()=>{
            /* `error` is ALWAYS followed by `close`, so the retry is scheduled
               there. Handling it here as well would double the attempts and
               make the backoff mean nothing. */
            this.setStatus("Connection failed",false)
        })
    }
    /* The backoff lives here rather than inside the socket, because a server
       that REFUSES every connection still fires `close`. With no schedule of
       its own, one refused connection leaves the node dead until a reload. */
    scheduleReconnect(){
        if(this.reconnectTimer||this.reconnectAttempt>=this.maxReconnectAttempts){
            return
        }
        const delay=Math.min(1000*2**this.reconnectAttempt,30000)+Math.random()*1000
        this.reconnectAttempt++
        this.setStatus(
            `Reconnecting in ${Math.round(delay/1000)}s (${this.reconnectAttempt}/${this.maxReconnectAttempts})`,
            false
        )
        this.reconnectTimer=setTimeout(()=>{
            this.reconnectTimer=null
            this.connect()
        },delay)
    }
    onServerMessage(data){
        if(data.type==="rooms"){
            this.renderRoomList(data.rooms??[])
            return
        }
        if(data.type==="room_created"){
            this.parameters.room=data.room
            this.transmit({type:"join_room",room:data.room,name:this.parameters.nick.trim()})
            return
        }
        if(data.type==="room_joined"){
            this.parameters.room=data.room
            this.log?.replaceChildren()
            for(const message of data.messages??[]){
                this.append(`${message.user} : ${message.text}`)
            }
            this.setStatus(`#${data.room}`,true)
            return
        }
        if(data.type==="users"){
            this.setStatus(`#${this.parameters.room} — ${(data.users??[]).length} connected`,true)
            return
        }
        if(data.type==="message"){
            this.append(`${data.message.user} : ${data.message.text}`)
            return
        }
        if(data.type==="system"){
            this.append(data.text,"system")
            return
        }
        if(data.type==="error"){
            /* The server's own complaints go in the log: it is the only way a
               user learns that their nick was taken or the room is full. */
            this.append(data.text,"system")
        }
    }
    renderRoomList(rooms){
        if(this.parameters.room.trim()||rooms.length===0){
            return
        }
        /* Only while there is no room yet: once one is joined, the panel is a
           conversation, not a directory. */
        const list=CE("div",{className:"chat-rooms"},[])
        for(const room of rooms){
            const button=CE("button",{type:"button"},[
                `#${room.name} — ${room.users} connected`
            ])
            button.addEventListener("click",()=>{
                this.parameters.room=room.id
                this.transmit({type:"join_room",room:room.id,name:this.parameters.nick.trim()})
            })
            list.appendChild(button)
        }
        this.log?.replaceChildren(list)
    }
    /* The one place a frame is written, so the "am I connected" test cannot be
       forgotten at one call site and honoured at another. */
    transmit(payload){
        if(!this.socket||this.socket.readyState!==WebSocket.OPEN){
            this.append("Not connected.","system")
            return false
        }
        this.socket.send(JSON.stringify(payload))
        return true
    }
    send(){
        const text=this.inputField.value.trim()
        if(!text){
            return
        }
        if(this.transmit({type:"message",text})){
            /* Cleared ONLY on a successful send: wiping the box on a dead
               socket would throw away what the user just typed. */
            this.inputField.value=""
        }
    }
    disconnect(){
        if(this.reconnectTimer){
            clearTimeout(this.reconnectTimer)
            this.reconnectTimer=null
        }
        if(this.socket){
            /* close(), not a terminate: the server needs the close frame to
               drop the user from its room list and to tell everyone else. */
            this.socket.close()
            this.socket=null
        }
    }
    serializeState(){
        /* Only the three fields the user typed. The socket, the log and the
           retry counter belong to THIS visit: storing them would make the
           session file large, unserialisable, and meaningless on reload. */
        return {
            url:this.parameters.url,
            nick:this.parameters.nick,
            room:this.parameters.room
        }
    }
    restoreState(state){
        if(!state){
            return
        }
        this.parameters.url=state.url??""
        this.parameters.nick=state.nick??""
        this.parameters.room=state.room??""
        /* The chat is NOT reopened on a reload: a page that starts talking to a
           server on its own is a page that cannot be opened quietly. The node
           returns with its room and nick filled in, and the user presses
           Join — which is also the only moment a nick is really theirs. */
        this.status="floating"
    }
    suicide(options={}){
        /* The pending retry MUST be cleared: a node deleted with a reconnect
           scheduled would come back as a socket nobody can see or close. */
        this.disconnect()
        this.dialog?.suicide()
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
        super.restoreAfterImport()
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
        super.restoreAfterImport()
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

/* ---- VirtualRowList: a scroll of identical rows, made affordable --------

   The list of a collection can hold tens of thousands of formulas, and a DOM
   row per formula is not a slow list, it is a dead tab: the browser lays out
   and paints every one of them on the first frame, then again on every scroll.

   So the rows are a POOL. Only the rows the viewport can show exist, plus a
   small overscan; the rest is a spacer of the right total height, and the
   scrollbar is honest because that spacer is what it measures. Scrolling does
   not create anything, it re-fills elements that already exist.

   The price is stated rather than hidden: only what fits is in the DOM, so a
   row's state must live in the DATA (this.rows) and not in the element. That
   is why onRow returns nothing and is handed the row every time. */
class VirtualRowList{
    //rows drawn beyond the viewport, top and bottom. A screenful is plenty on
    //a fast wheel and not enough on a slow drag; 8 rows is the compromise.
    static OVERSCAN=8
    constructor({rowHeight,onRow,onActivate=null}={}){
        this.rowHeight=rowHeight
        this.onRow=onRow
        this.onActivate=onActivate
        this.rows=[]
        this.pool=[]
        this.first=0
        this.last=0
        this.paintFrame=null
        this.spacer=CE("div",{className:"fc-spacer"},[])
        this.layer=CE("div",{className:"fc-layer"},[])
        this.element=CE("div",{className:"fc-viewport"},[this.spacer,this.layer])
        this.spacer.addEventListener("click",()=>{})
        this.observer=new ResizeObserver(()=>this.paint())
        this.observer.observe(this.element)
    }
    setRows(rows){
        this.rows=rows
        //the spacer IS the scrollbar: without its full height the list would
        //be a dozen rows tall no matter how many formulas it holds
        this.spacer.style.height=`${rows.length*this.rowHeight}px`
        this.paint()
        /* AND ONCE MORE, on the next frame.

           A paint measures `clientHeight`, and right after a re-render that
           number is the one the layout WILL have, not the one it has: the
           collections above have just been rebuilt, the write line has just
           been rebuilt, the browser has not reflowed. Painting on a stale zero
           fills a single row — or none — and the list then stays wrong until
           the user scrolls, which is exactly what "the formulas disappear when
           I pick another collection" looks like.

           The ResizeObserver catches the size changing, but it fires for SIZE,
           not for "the rows in it are different": a list that was already the
           right height and merely got new content is never resized. So the
           repaint is asked for explicitly, here, where the rows changed. */
        this.paintLater()
    }
    paintLater(){
        if(this.paintFrame) return
        this.paintFrame=requestAnimationFrame(()=>{
            this.paintFrame=null
            this.paint()
        })
    }
    /* The visible window, as row indices. A binary search over the offsets,
       because the list may hold a hundred thousand rows and a linear scan on
       every scroll frame is what virtualization was supposed to remove. */
    visibleRange(){
        const scrollTop=this.element.scrollTop
        /* One screenful when the box has not been laid out yet. A zero here
           would make `needed` zero, which hides every pooled row — and the list
           would then be blank for a reason that has nothing to do with how many
           formulas it holds. */
        const height=this.element.clientHeight||this.rowHeight*8
        const first=Math.max(0,Math.floor(scrollTop/this.rowHeight)-VirtualRowList.OVERSCAN)
        const last=Math.min(this.rows.length,Math.ceil((scrollTop+height)/this.rowHeight)+VirtualRowList.OVERSCAN)
        return {first,last}
    }
    paint(){
        const {first,last}=this.visibleRange()
        const needed=last-first
        while(this.pool.length<needed){
            //a null row means "BUILD": the callback returns a fresh element,
            //and from then on the pool re-fills the same ones forever
            const element=this.onRow(null,null,this.pool.length)
            element.style.position="absolute"
            element.style.left="0px"
            element.style.right="0px"
            this.layer.appendChild(element)
            this.pool.push(element)
        }
        for(let i=0;i<this.pool.length;i++){
            const element=this.pool[i]
            if(i>=needed){
                element.style.display="none"
                continue
            }
            element.style.display=""
            element.style.transform=`translateY(${(first+i)*this.rowHeight}px)`
            //the row is attached to its element here, so the click handler
            //installed once at build time always finds the CURRENT row
            this.onRow(element,this.rows[first+i],first+i)
        }
        this.first=first
        this.last=last
    }
    scrollToRow(index){
        if(!this.rows.length) return
        const clamped=Math.max(0,Math.min(this.rows.length-1,index))
        const top=clamped*this.rowHeight
        const height=this.element.clientHeight||this.rowHeight
        if(top<this.element.scrollTop){
            this.element.scrollTop=top
        }else if(top+this.rowHeight>this.element.scrollTop+height){
            this.element.scrollTop=top+this.rowHeight-height
        }
        this.paint()
    }
    dispose(){
        this.observer.disconnect()
        if(this.paintFrame) cancelAnimationFrame(this.paintFrame)
        this.element.remove()
        this.pool.length=0
        this.rows=[]
    }
}

/* ---- small pure helpers for the collection reader ----------------------
   They live out of the class because none of them touches the DOM, and a
   number format is exactly the thing that must be testable on its own. */

//"1 234 567" — the counts here reach six digits per collection, and a column
//of "1234567" is a column nobody can compare down
function formatCount(value){
    const n=Math.trunc(Number(value))
    if(!Number.isFinite(n)) return "—"
    return Math.abs(n).toString().replace(/\B(?=(\d{3})+(?!\d))/g," ")
}
function formatMz(mz){
    return Number.isFinite(mz)?mz.toFixed(4):"—"
}
//six significant figures: enough to tell two isotopologues apart in ppm,
//short enough to fit a 60 px cell
function formatValue(value){
    if(!Number.isFinite(value)) return "—"
    if(value===0) return "0"
    const magnitude=Math.abs(value)
    if(magnitude>=1e6||magnitude<1e-3) return value.toExponential(2)
    return value.toPrecision(6).replace(/0+$/,"").replace(/\.$/,"")
}
const SUBSCRIPTS={"0":"₀","1":"₁","2":"₂","3":"₃","4":"₄","5":"₅","6":"₆","7":"₇","8":"₈","9":"₉"}
const SUPERSCRIPTS={"0":"⁰","1":"¹","2":"²","3":"³","4":"⁴","5":"⁵","6":"⁶","7":"⁷","8":"⁸","9":"⁹","+":"⁺","-":"⁻"}
/* The notation, made readable: the COUNTS go down (C₆H₁₂O₆) and the charge
   goes up (H⁺). The digits of a MASS NUMBER stay on the baseline and are not
   subscripted — ¹²C₆ and ₁₂C₆ are not the same writing of the same thing, and
   a subscripted 12 would read as twelve atoms of a mass number nobody wrote.

   The key itself is NEVER touched: it is the identity, it never abbreviates,
   and it is what a downstream node re-parses. This is a display of it. */
function prettyNotation(notation){
    const text=String(notation)
    let out=""
    let i=0
    while(i<text.length){
        const ch=text[i]
        if(/[0-9]/.test(ch)){
            /* One pass, and ONE order: a loop that handled the digits first
               and the letters afterwards printed "₆₁₂₆CHO", which is not a
               formula in any language. */
            const before=text[i-1]??""
            let digits=""
            while(i<text.length&&/[0-9]/.test(text[i])) digits+=text[i++]
            const rest=text.slice(i)
            //what decides a mass number is that a LETTER follows it; what
            //decides a charge magnitude is that a SIGN does
            const sign=/^[^\+\-]*?([\+\-])/.exec(rest)
            if(/[A-Za-z\]]/.test(before)){
                //a COUNT, and it goes down
                out+=[...digits].map(d=>SUBSCRIPTS[d]).join("")
            }else if(sign&&!/^[A-Za-z]/.test(rest)){
                //the MAGNITUDE of a charge, and it goes up with its sign:
                //SO4[2-] is SO₄²⁻, never SO₄₂⁻
                out+=[...digits].map(d=>SUPERSCRIPTS[d]).join("")+SUPERSCRIPTS[sign[1]]
                //the sign is consumed here, so the main loop must not see it
                i+=sign.index+sign[0].length
            }else{
                //a MASS NUMBER, left on the baseline where it is read
                out+=digits
            }
            continue
        }
        if(ch==="+"||ch==="-"){
            out+=SUPERSCRIPTS[ch]
            i++
            continue
        }
        //the brackets of an ionisation are structure, not content: what they
        //contain is written out, and they are not drawn
        if(ch!=="["&&ch!=="]") out+=ch
        i++
    }
    return out
}
//the colour of a trace, taken from the palette the inspector already uses so
//a collection keeps the same colour in the graph as in the list
const TRACE_COLORS=["#e74c3c","#3498db","#2ecc71","#f39c12","#9b59b6","#1abc9c","#e67e22","#16a085"]
function traceColor(index){
    return TRACE_COLORS[((index%TRACE_COLORS.length)+TRACE_COLORS.length)%TRACE_COLORS.length]
}
/* Delete and Backspace, as ONE predicate.

   Two keys for one verb is not redundancy, it is the two keyboards: the Delete
   key of a PC sits far from the home position, and on a Mac there is no forward
   Delete at all — Backspace is what is under the right hand. The nodes of the
   flow have accepted both since the beginning (Node's key handler), and a panel
   that answered only one of them would feel like a different application.

   It also has to IGNORE the keystrokes that only LOOK like deletion, which is
   why the callers pair it with a check on what has the focus: Backspace inside
   the formula field, the filter or the note is an edit, and a panel that
   swallowed it would make those three fields unusable. */
function isDeleteKey(event){
    return event.key==="Delete"||event.key==="Backspace"
}
//The orders the list accepts. Each one returns 0 for "equal": the caller adds
//the m/z and the key as tie-breakers, because a list whose order changes
//between two identical paints is a list that moves the row under the cursor.
const FORMULA_SORTS={
    mz:{label:"m/z",compare:(a,b)=>a.mz-b.mz},
    intensity:{label:"intensity",compare:(a,b)=>(b.intensity??-1)-(a.intensity??-1)},
    error:{label:"error",compare:(a,b)=>Math.abs(a.errorPpm??Infinity)-Math.abs(b.errorPpm??Infinity)},
    notation:{label:"notation",compare:(a,b)=>(a.notation<b.notation?-1:a.notation>b.notation?1:0)}
}
/* THE COMPARATOR, as a function — never as a table entry.

   `FORMULA_SORTS[name]` is an OBJECT ({label, compare}), and calling it threw
   "sort is not a function" the first time a row was clicked: the list was
   silently empty from the start and the exception only surfaced when a stale
   row was activated. So the lookup, the fallback and the tie-breakers all live
   here, and the caller does `rows.sort(formulaComparator(...))` — there is no
   longer a shape to get wrong.

   `hasOwnProperty` and not a plain read, so a name like "constructor" or
   "toString" resolves to nothing rather than to something inherited from
   Object.prototype that happens to be callable.

   An UNKNOWN order falls back to m/z instead of throwing: the order is a
   display choice stored in a session file, and a file this build did not write
   must not be able to blank the list. */
function formulaComparator(name){
    const sort=Object.prototype.hasOwnProperty.call(FORMULA_SORTS,name)?FORMULA_SORTS[name]:null
    const compare=sort?.compare??FORMULA_SORTS.mz.compare
    return (a,b)=>compare(a,b)||a.mz-b.mz||(a.key<b.key?-1:1)
}
/* -------------------------------------------------------------------------
   FormulaCollectionNode — a READER for collections of Formula.

   ONE input, multiplexed: Flow.parentSynapse already gathers every link that
   lands on a single anchor into one Map, so a hundred collections of molecules
   arrive on one socket. Nothing here invents a second mechanism for it.

   THREE panels, and each answers a different question:
     - LEFT  : WHAT there is. Level 1 the collections (name, size, two
               checkboxes, a handle); level 2 the formulas of the collection on
               screen, virtualized, filterable, sortable.
     - CENTER: what it LOOKS like. One stick trace per collection ticked for
               the graphs, drawn in the node's own dialog.
     - RIGHT : what a given formula IS. The unabridged key, the mass, every
               measured target with its error, and a free-text annotation.

   The Formula / Stoichiometry switch is a VIEW and never a transformation.
   "Fold to stoichiometry" groups the leaves of a graph under their root — the
   engine already knows that lineage, so the grouping is a grouping and not a
   guess — and unfolding hands back every key, m/z and target untouched.
   ------------------------------------------------------------------------- */
class FormulaCollectionNode extends NodeWithAccordionGraph{
    //how many sticks the central graph will take before it says "capped"
    static GRAPH_POINT_BUDGET=200000
    //one line of the list. Fixed, and the reason the windowing is cheap. It
    //MUST equal the height of .fc-row in main.css: the offsets the list
    //computes are multiples of this, and a one-pixel disagreement puts the row
    //the user clicked somewhere else than the row they clicked on.
    static ROW_HEIGHT=22


    /* LEVEL 2 — the formulas of the collection on screen.

       The list is VIRTUALIZED and it has to be: the brief is tens of thousands
       of formulas per collection, and ten thousand DOM rows is ten thousand
       layout boxes the browser will rebuild on every scroll. The rows are a
       recycled pool — only the visible window exists, and scrolling re-fills
       the same elements instead of appending new ones.

       One deliberate consequence: a row of fixed height, and the targets of a
       formula are NOT expanded in place. They are in the detail panel on the
       right, one click away, and the row shows their NUMBER. Variable heights
       would break the offset arithmetic that makes the windowing cheap, and
       the alternative — a nested scrollable block inside a virtualized row —
       is worse to use than a panel that is already there. */
    buildFormulaBand(){
        const band=CE("div",{
            className:"fc-formulas",
            /* NO overflow and NO contain here. This band became a GRID when the
               write line was added above the list, and the scrolling and the
               containment belong to the middle row — `.fc-viewport-wrap`. Left
               on the band, `contain:strict` also brings SIZE containment: the
               grid is then laid out as if it were empty, the row collapses, and
               the list below it has nothing to show. */
            style:{minHeight:"0",display:"grid","grid-template-rows":"auto minmax(0,1fr) auto"}
        },[])
        /* The write line, and it is ABOVE the list: what you are adding goes at
           the top of a list you are reading downward, not at the bottom where
           you would have to scroll past fifty thousand rows to see it land.

           It is shown only for a collection this node owns. On a collection a
           parent made it is not disabled but REPLACED by a line of text saying
           why — a control that is visibly not applicable teaches, and one that
           silently does nothing does not. */
        this.addRow=CE("div",{className:"fc-addrow-wrap"},[])
        this.list=new VirtualRowList({
            rowHeight:FormulaCollectionNode.ROW_HEIGHT,
            onRow:(element,row)=>this.drawRow(element,row)
        })
        const viewport=CE("div",{className:"fc-viewport-wrap"},[])
        viewport.appendChild(this.list.element)
        viewport.addEventListener("scroll",()=>this.list?.paint())
        /* The band is focusable so the arrow keys have somewhere to arrive:
           without a tabindex the browser sends them to the next control, and a
           list of formulas is not readable with the mouse alone. */
        viewport.tabIndex=0
        viewport.addEventListener("keydown",(event)=>this.onListKeyDown(event))
        this.diagnosticsBand=CE("div",{style:{maxHeight:"5.5em",overflow:"auto",minHeight:"0"}},[])
        band.append(this.addRow,viewport,this.diagnosticsBand)
        this.formulaBand=band
        this.renderAddRow()
        return band
    }
    /* The write line, and it is ALWAYS there.

       It was conditional on the collection being local, which left a field that
       simply did not exist in most states — and a user who types "C" into the
       only other text field on the panel (the filter) sees nothing happen and
       concludes the node is broken. So: always visible, always writable, and
       every refusal SAYS WHY on the line itself.

       The input is built ONCE and reused. Rebuilding it on every render — which
       is what a naive renderAll does — throws away the caret, the focus and
       whatever is half-typed, so a field meant for entering a dozen formulas in
       a row would lose the user after the first one. */
    renderAddRow(){
        if(!this.addRow) return
        if(!this.formulaInput){
            this.addRow.append(this.buildFormulaInput())
        }
        const collection=this.currentCollection
        this.formulaInput.placeholder=collection?.local
            ?"C6H12O6 [H+]   then Enter"
            :"C6H12O6 [H+]   then Enter — will be added to a collection of yours"
        this.formulaInput.title=collection?.local
            ?`Formula to add to "${collection.name}". Enter adds it, Escape clears.`
            :"Enter adds this formula to a collection of this node"
        if(this.addHint){
            this.addHint.textContent=collection?.local
                ?""
                :"no collection of yours is on screen — Enter will use your first one, or create one"
        }
    }
    /* A row is selected by being READ, and read by being the selection: one
       gesture, no "details" button to find. */
    activateRow(row){
        if(row.kind==="molecule"){
            if(this.openMolecules.has(row.molecule)) this.openMolecules.delete(row.molecule)
            else this.openMolecules.add(row.molecule)
            this.parameters.selection=this.parameters.selection
        }else{
            const entry=row.entry
            if(this.openEntries.has(row.key)) this.openEntries.delete(row.key)
            else this.openEntries.add(row.key)
            this.parameters.selection=row.key
            this.selectedEntry=entry
        }
        this.origin?.saveSessionSoon?.()
        this.renderRows()
        this.renderSelection()
    }
    /* The keyboard path. The list is a scroll box, so a page-down there is the
       list's own business — but the ARROWS are this node's, because moving
       along a list of formulas is reading it, and a user with both hands on
       the keyboard should never have to reach for the mouse to move down one
       row. */
    onListKeyDown(event){
        const rows=this.rows??[]
        if(!rows.length) return
        const current=rows.findIndex(row=>row.key===this.parameters.selection)
        let next=current
        if(event.key==="ArrowDown") next=current<0?0:Math.min(rows.length-1,current+1)
        else if(event.key==="ArrowUp") next=current<0?rows.length-1:Math.max(0,current-1)
        else if(event.key==="Home") next=0
        else if(event.key==="End") next=rows.length-1
        else if(isDeleteKey(event)){
            /* No selection means nothing to remove, and SAYING so beats eating
               the keystroke: the alternative is a user who pressed Delete on a
               list, saw nothing happen, and pressed it harder. */
            if(current<0){
                event.preventDefault()
                this.reportDeletion("select a formula first — the arrows move, Delete removes")
                return
            }
            event.preventDefault()
            this.deleteVisibleRow(rows[current])
            return
        }else if(event.key==="Enter"||event.key===" "){
            if(current>=0){
                event.preventDefault()
                this.activateRow(rows[current])
            }
            return
        }else{
            return
        }
        event.preventDefault()
        this.parameters.selection=rows[next].key
        this.selectedEntry=rows[next].kind==="formula"?rows[next].entry:null
        this.list?.scrollToRow(next)
        this.renderRows()
        this.renderSelection()
    }
    /* Remove whatever the given row stands for, and say what happened.

       The row is not always ONE formula. In the stoichiometry view a row is a
       MOLECULE — a group of isotopologues folded under one line — and Delete on
       it has to mean the whole group, because that is the object the user sees
       and picked. Anything else would be a lie about what the list is showing:
       the row disappears, three of its five formulae come back on the next
       resolve, and the key looks broken in the one view built to be tidy.

       It is therefore sequential and not parallel. The removals each end in a
       full resolve, and a hundred resolves fired at once would interleave their
       rebuilds against one shared `this.collections` — the last one to land
       would win, and the list would show a state no single request ever asked
       for. One at a time is the price of the list and the graph agreeing, and a
       molecule is a handful of rows, not a hundred thousand. */
    async deleteVisibleRow(row){
        const collection=this.currentCollection
        if(!collection) return
        const keys=row.kind==="molecule"
            ?row.entries.map(entry=>entry.key)
            :[row.key]
        /* Every key goes, or none does. Half a molecule is not a molecule, and a
           partial removal is the one outcome that would have to be explained. */
        for(const key of keys){
            const result=await this.deleteFormula(collection.name,key)
            if(!result.ok){
                this.reportDeletion(result.message,true)
                return
            }
        }
        this.reportDeletion(
            row.kind==="molecule"
                ?`removed ${formatCount(keys.length)} formulae of ${collection.name}`
                :`removed from ${collection.name}`
        )
    }
    /* What a refusal or a success looks like, on the line under the field.

       The add row is where the user already looks after pressing Enter, so it is
       where a verdict belongs — and it is the only piece of the panel that is
       guaranteed to be on screen whatever state the list is in. A Dialog would
       be heavier than the event and would have to be dismissed. */
    reportDeletion(message,bad=false){
        if(!this.addHint) return
        this.addHint.textContent=message
        this.addHint.className=bad?"fc-addrow-note fc-addrow-bad":"fc-addrow-note fc-addrow-ok"
    }
    /* --- creating things, as opposed to reading them ------------------- */
    /* A READER that can only read is half a tool: the collections a user
       accumulates by hand have to live somewhere, and the answer cannot be
       "type them into a node upstream" — that node does not exist yet, and the
       user should not have to wait for it to write down a formula.

       A collection made here is LOCAL, and the difference is not cosmetic: it
       is rebuilt from the session at every resolve, so it can be added to and
       deleted, where a collection a parent made would swallow both silently
       and put the formula back on the next resolve. */
    /* The collection a typed formula belongs to, and the rule is deliberately
       forgiving because the alternative is a field that silently does nothing.

       In order: the collection on screen if this node owns it; else the first
       collection this node owns; else a new one. So a user who has never
       pressed "+ New collection" can still type a formula and press Enter, and
       it lands somewhere they can see. The stricter rule — "only into a local
       collection, and say so if there is none" — reads well and behaves like a
       form that refuses to submit, which is not what a field in a node is. */
    async targetLocalCollection(){
        if(this.currentCollection?.local) return this.currentCollection
        const first=this.parameters.localCollections[0]
        if(first){
            return this.collections.find(c=>c.name===first.name)??null
        }
        /* No collection of ours at all: one is made, and QUIETLY.

           A prompt here would be a modal popping out of a keystroke the user
           thought was a simple one, and Escape would then look like "Enter did
           nothing" all over again. The name is provisional and the handle menu
           renames it; the hint line says which collection it landed in.

           It is AWAITED: createCollection ends in a resolve, and reading
           `currentCollection` one microtask before that resolve finished would
           hand back a half-built collection — or null. */
        await this.createCollection("Formules",{ask:false})
        return this.currentCollection
    }
    async createCollection(defaultName="collection",{ask=true}={}){
        const name=ask
            ?prompt("Name of the new collection:",defaultName)?.trim()
            :defaultName
        if(!name) return null
        if(this.parameters.localCollections.some(local=>local.name===name)){
            //two collections under one name would SHARE their state record, so
            //unticking one would untick the other
            this.origin?.notice?.("Name already used",`"${name}" is already a collection here.`)
            return null
        }
        this.parameters.localCollections.push({name,keys:[]})
        this.parameters.current=name
        this.parameters.selection=null
        this.origin?.saveSessionSoon?.()
        //a resolve, like everywhere else: the new collection has to reach the
        //graph and the output without the user having to remember to ask
        await this.startResolve()
        this.resolveChildren()
        return this.currentCollection
    }
    async deleteCollection(name){
        const index=this.parameters.localCollections.findIndex(local=>local.name===name)
        /* A collection a parent made is NOT deletable: it would come back at the
           next resolve and the list would flicker. The verb is greyed out in
           the menu for the same reason.

           From the KEYBOARD it says so out loud instead of returning false in
           silence: Delete is not a button the user aimed at, it is a key they
           pressed, and a key that does nothing at all reads as a broken panel
           rather than as a refusal that has a reason. */
        if(index<0){
            this.origin?.notice?.(
                "Not yours to delete",
                `"${name}" was made by another node. It is rebuilt from that node at every resolve, so deleting it here would only make it disappear for a moment.`
            )
            return false
        }
        this.parameters.localCollections.splice(index,1)
        delete this.parameters.collectionState[name]
        /* The name is gone, so anything still pointing at it now points at
           nothing. syncCurrentCollection falls back to the first collection on
           the next resolve, but the SELECTION is a formula key and is not
           re-derived there: left alone, it would keep the detail panel
           describing a formula this node no longer holds. */
        this.parameters.selection=null
        this.selectedEntry=null
        this.openEntries.clear()
        this.openMolecules.clear()
        this.origin?.saveSessionSoon?.()
        await this.startResolve()
        this.resolveChildren()
        return true
    }
    /* The formula written into a local collection, as the text the user typed.

       The text and not the Formula, for the same reason as everywhere else: a
       session carrying formulas would carry a periodic table with them. The KEY
       would be wrong twice over — it is an identity, not a spelling, and for a
       group adduct it does not read back to the same formula. */
    async addFormulaToLocal(text){
        const typed=text.trim()
        if(!typed) return {ok:false,message:""}
        /* The table is fetched HERE, not at resolve time: the user is typing,
           and a field that answers "table…" to someone who has not pressed
           Resolve yet is a field that looks broken. Waiting here is invisible,
           because they are still holding the keyboard. */
        const table=await this.table()
        const collection=await this.targetLocalCollection()
        if(!collection){
            //the user dismissed the name prompt, or the name was taken
            return {ok:false,message:"no collection to add to"}
        }
        const local=this.parameters.localCollections.find(l=>l.name===collection.name)
        if(!local) return {ok:false,message:`"${collection.name}" is not a collection of this node`}
        /* Already there is a SUCCESS, not a refusal: the user asked for this
           formula to be in the list, and it is. Answering "no" would light the
           field red for doing exactly what they wanted. */
        if(local.keys.includes(typed)) return {ok:true,message:"already in the list"}
        //read it FIRST: a formula that does not parse must not be stored, or it
        //would come back as a diagnostic on every single resolve
        const problems=[]
        if(!table){
            return {ok:false,message:"the periodic table is not available yet, try again"}
        }
        if(!this.localFormula(typed,collection.name,problems)){
            return {ok:false,message:problems[0]??`"${typed}" is not a formula`}
        }
        local.keys.push(typed)
        /* The collection the user is looking at is DISCARDED and rebuilt from
           the texts, rather than patched. The patch would be faster; the rebuild
           is the one that cannot leave the list, the graph, the output and the
           session disagreeing — and it is also what re-resolves, which is what
           the user is entitled to expect after typing a formula in. */
        await this.startResolve()
        this.resolveChildren()
        return {ok:true,message:`added to ${collection.name}`}
    }
    /* The mirror of addFormulaToLocal: take ONE formula out of a collection of
       this node, and only of this node.

       THE LOOKUP IS THE WHOLE PROBLEM. The list shows `entry.key`, the canonical
       identity — "C6H12O6" is stored as "12C6 1H12 16O6" — while
       `localCollections[].keys` holds the TEXT the user typed. Those two strings
       are not equal and must never be compared as if they were: splicing the key
       out of a list of texts removes nothing, the formula survives the next
       resolve, and Delete looks broken in the one case where the user is most
       certain it should have worked.

       So the stored text is what is removed, and the row is located by RE-READING
       each stored text and asking for its canonical key. It costs one parse per
       formula in the collection, which is why it is done here and not in the
       render path: deletion is a deliberate act, a repaint is not.

       `collection.sources` would have answered this in O(1), and does not: the
       local collections are rebuilt from Formula OBJECTS, and asFormula only
       records a source for a STRING — so that map holds key→key for them, which
       is the very equality that must not be relied on. */
    async deleteFormula(collectionName,canonicalKey){
        const collection=this.collections.find(c=>c.name===collectionName)
        if(!collection) return {ok:false,message:"that collection is not on screen"}
        /* Only a collection this node OWNS can be written to. A parent's
           collection is rebuilt from the link at every resolve, so the formula
           would come straight back — and a Delete that undoes itself is worse
           than one that refuses and says why. */
        if(!collection.local){
            return {ok:false,message:`"${collectionName}" belongs to a parent — it comes back on the next resolve`}
        }
        const local=this.parameters.localCollections.find(l=>l.name===collectionName)
        if(!local) return {ok:false,message:`"${collectionName}" is not a collection of this node`}
        const table=this.loadedTable??await this.table()
        if(!table) return {ok:false,message:"the periodic table is not available yet, try again"}
        const stored=local.keys.findIndex(text=>{
            try{ return Formula.parse(text,table).key===canonicalKey }
            /* A text that no longer reads is NOT a reason to refuse the deletion:
               it is already dead weight in the list, and the one thing the user
               asked for is that the formula they clicked goes away. */
            catch(error){ return false }
        })
        if(stored<0) return {ok:false,message:`${prettyNotation(collection.find(canonicalKey)?.notation??canonicalKey)} is not stored here`}
        local.keys.splice(stored,1)
        /* The annotation goes with the formula. It is keyed by the canonical key
           and nothing else would ever read it again, so keeping it would grow
           every deleted formula's note forever in the session file. */
        delete this.collectionState(collectionName).notes[canonicalKey]
        if(this.parameters.selection===canonicalKey){
            this.parameters.selection=null
            this.selectedEntry=null
        }
        this.openEntries.delete(canonicalKey)
        this.origin?.saveSessionSoon?.()
        await this.startResolve()
        this.resolveChildren()
        return {ok:true,message:`removed from ${collectionName}`}
    }
    setView(view){
        if(this.parameters.view===view) return
        this.parameters.view=view
        this.openMolecules.clear()
        this.openEntries.clear()
        this.viewToggle?.paint()
        this.renderRows()
        this.origin?.saveSessionSoon?.()
    }
    /* The FKMD gesture, on ONE line: what you type is READ as you type, and
       ENTER commits it into the list.

       Same split as FKMDNode and for the same reason — a live reading is cheap
       and catches a typo on the spot, while adding to a collection is not a
       thing you want to do by accident. The readout sits BESIDE the field on
       the same line, so "write, check, commit" is one glance at one row and
       never a second place to look. */
    buildFormulaInput(){
        const input=CE("input",{
            type:"text",
            spellcheck:false,
            placeholder:"C6H12O6 [H+]   then Enter",
            title:"Formula to add to a collection of this node. Enter adds it, Escape clears.",
            style:{width:"100%",minWidth:"0",padding:"2px 4px"}
        },[])
        this.formulaInput=input
        this.formulaReadout=CE("span",{className:"fc-readout"},[""])
        /* The RESULT of the last Enter, on the same line. Without it a refusal
           is invisible — the field would simply stay full and the list would
           not move, which is the "nothing happened" the user cannot debug. */
        this.addHint=CE("span",{className:"fc-addrow-note"},[""])
        input.addEventListener("input",()=>this.readTypedFormula(input.value))
        input.addEventListener("keydown",(event)=>{
            if(event.key==="Enter"){
                event.preventDefault()
                this.commitTypedFormula()
            }else if(event.key==="Escape"){
                input.value=""
                this.formulaReadout.textContent=""
                this.addHint.textContent=""
                input.blur()
            }
        })
        const commit=CE("button",{
            type:"button",
            title:"Add this formula to a collection of this node",
            style:{cursor:"pointer",padding:"1px 6px",flex:"none"}
        },["↵"])
        commit.addEventListener("click",()=>this.commitTypedFormula())
        return CE("div",{className:"fc-addrow"},[input,this.formulaReadout,commit,this.addHint])
    }
    /* Enter, and the ↵ button, are ONE function.

       The field is emptied only when the formula really landed, and the reason
       is written on the line either way: a formula that did not parse stays on
       screen with its error, because wiping it would throw the user's typing
       away along with the message. */
    async commitTypedFormula(){
        const input=this.formulaInput
        if(!input) return
        /* A resolve is a full re-read, and that is the POINT: the collection is
           rebuilt from the texts that were typed, so what the list shows and
           what the session holds cannot drift apart. It is also what removes
           the need to remember to press Resolve — a collection that changed and
           did not re-resolve would leave the graph and the output describing
           the collection as it was a minute ago.

           The typed text is read ONCE, before the await, because the user may
           keep typing while the table downloads. */
        const text=input.value
        const result=await this.addFormulaToLocal(text)
        //a newer keystroke may have replaced what we committed
        if(this.formulaInput!==input) return
        this.formulaReadout.textContent=""
        this.formulaReadout.className="fc-readout"
        if(result.ok){
            if(input.value===text) input.value=""
            this.addHint.textContent=result.message
            this.addHint.className="fc-addrow-note fc-addrow-ok"
            input.focus()
        }else{
            this.addHint.textContent=result.message||"nothing to add"
            this.addHint.className="fc-addrow-note fc-addrow-bad"
        }
    }
    /* The live reading. It NEVER throws: a typing mistake is a result, not an
       exception, and a resolve in flight must not die on a half-typed symbol.

       When the table is not in yet it says so and ASKS FOR IT, then re-reads
       itself once it lands. Without the second half the field would keep
       saying "table…" for ever on a node that has simply never been resolved,
       which is the state the user meets first. */
    readTypedFormula(text){
        if(!this.formulaReadout) return
        const typed=text.trim()
        if(!typed){
            this.formulaReadout.textContent=""
            this.formulaReadout.className="fc-readout"
            return
        }
        if(!this.loadedTable){
            this.formulaReadout.textContent="loading the table…"
            this.formulaReadout.className="fc-readout fc-readout-warn"
            const asked=text
            this.table().then(()=>{
                //only if the field still holds what we read for it
                if(this.formulaInput?.value===asked) this.readTypedFormula(asked)
            })
            return
        }
        try{
            const formula=Formula.parse(typed,this.loadedTable)
            this.formulaReadout.textContent=
                `${formatMz(formula.mz)} · ${prettyNotation(String(formula))}`
            this.formulaReadout.className="fc-readout"
        }catch(error){
            this.formulaReadout.textContent=error.message
            this.formulaReadout.className="fc-readout fc-readout-error"
        }
    }
    setupRightPanel(){
        const content=this.accordionRight.DOMelt.content
        content.replaceChildren()
        this.accordionRight.setSizingMode("content")
        stylize(content,{
            display:"grid",
            "grid-template-rows":"minmax(0, 1fr) auto",
            minHeight:"0",
            height:"100%",
            overflow:"hidden",
            padding:"3px",
            gap:"3px"
        })
        this.detail=CE("div",{
            style:{overflow:"auto",minHeight:"0",display:"grid",gap:"2px",alignContent:"start",fontSize:"0.95em"}
        },[])
        this.graphOptions=CE("div",{style:{borderTop:"1px solid var(--border)",paddingTop:"3px"}},[])
        content.append(this.detail,this.graphOptions)
        this.renderGraphOptions()
    }
    renderDiagnostics(){
        if(!this.diagnosticsBand) return
        this.diagnosticsBand.replaceChildren()
        if(!this.diagnostics?.length) return
        const block=CE("div",{className:"fc-diagnostics"},[])
        block.append(CE("div",{className:"pp-caption"},["Diagnostics"]))
        for(const line of this.diagnostics.slice(0,40)){
            block.append(CE("div",{style:{opacity:"0.8"}},[line]))
        }
        if(this.diagnostics.length>40){
            block.append(CE("div",{style:{opacity:"0.6"}},[`… and ${this.diagnostics.length-40} more`]))
        }
        this.diagnosticsBand.append(block)
    }

    /* The HANDLE: the small grip under the row that opens a menu.

       A menu and not a third checkbox, because what a collection needs is a
       handful of verbs — isolate it, fold it, forget it, retitle it — and a
       panel of little boxes for verbs is a worse panel than one grip. */
    collectionHandle(collection,state){
        const handle=CE("button",{
            type:"button",
            className:"fc-handle",
            title:"Menu of this collection",
            style:{cursor:"pointer",padding:"0 3px",flex:"none"}
        },["⋮"])
        handle.addEventListener("click",(event)=>{
            event.stopPropagation()
            this.openCollectionMenu(collection,state,handle)
        })
        return handle
    }
    openCollectionMenu(collection,state,anchor){
        const others=this.collections.filter(c=>c.name!==collection.name)
        this.closeCollectionMenu()
        const items=[
            {
                label:"Isolate: graphs",
                hint:"only this collection is drawn",
                run:()=>{
                    for(const other of this.collections) this.collectionState(other.name).inGraphs=other.name===collection.name
                }
            },
            {
                label:"Isolate: output",
                hint:"only this collection leaves the node",
                run:()=>{
                    for(const other of this.collections) this.collectionState(other.name).inOutput=other.name===collection.name
                }
            },
            {
                label:this.parameters.view==="stoichiometry"?"Unfold the molecules":"Fold to stoichiometry",
                hint:"one row per molecule instead of per formula",
                run:()=>{
                    this.setView(this.parameters.view==="stoichiometry"?"formula":"stoichiometry")
                    if(this.parameters.view==="stoichiometry"){
                        this.openMolecules.clear()
                        this.openEntries.clear()
                    }
                }
            },
            {
                label:state.open?"Hide the formulas":"Show the formulas",
                run:()=>{
                    state.open=!state.open
                    if(state.open) this.parameters.current=collection.name
                }
            },
            {
                label:"Rename…",
                hint:"the name is how the state remembers this collection",
                run:()=>{
                    const typed=prompt("Name of this collection:",collection.name)
                    if(!typed||typed.trim()===collection.name) return
                    const next=typed.trim()
                    //the notes and the checkboxes follow the name, or renaming
                    //would silently discard everything the user had said here
                    const previousName=collection.name
                    this.parameters.collectionState[next]=state
                    delete this.parameters.collectionState[previousName]
                    collection.name=next
                    if(this.parameters.current===previousName) this.parameters.current=next
                }
            },
            {
                label:"Forget its information",
                hint:"drops the annotations, keeps the formulas",
                disabled:Object.keys(state.notes).length===0,
                run:()=>{
                    state.notes={}
                    this.renderAll()
                }
            },
            {
                label:"Delete this collection",
                /* Only for a collection this node owns. Deleting one that a
                   parent made would put it back on the next resolve, and the
                   list would flicker — so the verb is shown greyed with its
                   reason rather than hidden, which teaches where the boundary
                   is. */
                hint:collection.local?"and its annotations with it":"only for a collection made here",
                disabled:!collection.local,
                run:()=>this.deleteCollection(collection.name)
            }
        ]
        const menu=CE("div",{className:"fc-menu"},[])
        for(const item of items){
            if(!item) continue
            const button=CE("button",{type:"button",title:item.hint??""},[
                CE("span",{className:"fc-menu-label"},[item.label]),
                item.hint?CE("span",{className:"fc-menu-hint"},[item.hint]):null
            ])
            if(item.disabled) button.disabled=true
            button.addEventListener("click",()=>{
                this.closeCollectionMenu()
                item.run()
                this.origin?.saveSessionSoon?.()
                this.renderAll()
                this.refreshGraph()
                this.publishOutput()
                this.resolveChildren()
            })
            menu.appendChild(button)
        }
        document.body.appendChild(menu)
        this.collectionMenu=menu
        const box=anchor.getBoundingClientRect()
        //clamped to the window: a menu that opens off-screen is a menu that
        //cannot be dismissed, because the button that closes it is not visible
        const height=menu.getBoundingClientRect().height
        menu.style.left=`${Math.max(4,Math.min(box.left,window.innerWidth-menu.offsetWidth-4))}px`
        menu.style.top=`${Math.max(4,Math.min(box.bottom+2,window.innerHeight-height-4))}px`
        this.menuCloser=(event)=>{
            if(!menu.contains(event.target)) this.closeCollectionMenu()
        }
        /* Escape closes it too. Without this the only ways out are a click
           elsewhere and a choice from the menu — and `addEventListener` with an
           undefined handler is a no-op that fails silently, so the listener
           below looked installed and was not. */
        this.menuEscape=(event)=>{
            if(event.key==="Escape"){
                event.stopPropagation()
                this.closeCollectionMenu()
            }
        }
        setTimeout(()=>{
            globalThis.addEventListener("mousedown",this.menuCloser,true)
            globalThis.addEventListener("keydown",this.menuEscape,true)
        },0)
    }
    closeCollectionMenu(){
        if(!this.collectionMenu) return
        this.collectionMenu.remove()
        this.collectionMenu=null
        globalThis.removeEventListener("mousedown",this.menuCloser,true)
        globalThis.removeEventListener("keydown",this.menuEscape,true)
    }

    /* LEVEL 1 — the collections. One row each: name, how many formulas it
       holds, the two checkboxes, and a handle that opens a menu.

       The name is a BUTTON, not a label. It is what puts that collection on
       screen underneath, and a name you cannot click is a name you read twice
       to work out which of the four rows you are already looking at. */
    buildCollectionBand(){
        this.collectionBand=CE("div",{
            className:"fc-collections",
            style:{overflow:"auto",minHeight:"0",display:"grid",gap:"2px",alignContent:"start"}
        },[])
        /* "New collection" sits at the TOP of the band, not at the bottom of
           the node: it is a verb, and a verb that scrolls away under a hundred
           collections is a verb nobody finds twice. The rows go in their own
           container so that re-rendering the list does not destroy the button
           and its handler along with it. */
        const create=CE("button",{
            type:"button",
            className:"fc-newcollection",
            title:"Create a collection here, and type formulas into it",
            style:{cursor:"pointer",padding:"2px 6px",justifySelf:"start",marginBottom:"2px"}
        },["+ New collection"])
        create.addEventListener("click",()=>this.createCollection())
        this.collectionRows=CE("div",{style:{display:"grid",gap:"2px",alignContent:"start"}},[])
        this.collectionBand.append(create,this.collectionRows)
        return this.collectionBand
    }
    renderCollections(){
        if(!this.collectionRows) return
        this.collectionRows.replaceChildren()
        if(!this.collections.length){
            this.collectionRows.append(CE("div",{
                style:{opacity:"0.7",fontSize:"0.85em",padding:"4px"}
            },["No collection yet. Create one, or connect a node that publishes Formula."]))
            return
        }
        for(const collection of this.collections){
            this.collectionRows.append(this.buildCollectionRow(collection))
        }
    }
    /* Selecting a collection is ONE function, and every control on the row calls
       it. There were two handlers — the caret and the name — each repeating the
       same five lines, and the caret's version additionally TOGGLED `open`. Two
       copies of "what happens when you pick this" is how a row ends up looking
       selected while the list under it shows something else. */
    selectCollection(name){
        if(!this.collections.some(collection=>collection.name===name)) return false
        this.parameters.current=name
        this.parameters.selection=null
        this.selectedEntry=null
        this.collectionState(name).open=true
        this.syncCurrentCollection()
        this.origin?.saveSessionSoon?.()
        this.renderAll()
        //belt and braces: the list measures its box at paint time, and a paint
        //that happened before the panel settled would leave it stale
        this.list?.paintLater()
        return true
    }
    buildCollectionRow(collection){
        const state=this.collectionState(collection.name)
        const isCurrent=this.currentCollection?.name===collection.name
        const row=CE("div",{
            className:`fc-collection${isCurrent?" current":""}`,
            tabIndex:0,
            title:`${collection.name} — ${formatCount(collection.entries.length)} formulas. Delete removes it when it is yours.`
        },[])
        /* The dot is rendered on EVERY row, empty or not. It is the first cell,
           which is why it is also the first column of the grid: leaving it out
           on the rows that do not own a collection would push every other cell
           one column to the left, and a list whose controls are in a staircase
           is a list nobody trusts. */
        row.append(CE("span",{
            className:collection.local?"fc-collection-local":"fc-collection-local off",
            title:collection.local
                ?"Made in this node: it can be written to and deleted"
                :"A collection a parent made: it comes back on the next resolve"
        },[collection.local?"●":""]))
        const open=CE("button",{
            type:"button",
            className:"fc-collection-open",
            title:isCurrent?"Hide the formulas of this collection":"Show the formulas of this collection",
            /* the inline `flex` here used to do nothing at all — the row is a
               GRID, so the widths come from the template and the cells only
               need to be told not to overflow their track */
            style:{cursor:"pointer",minWidth:"0"}
        },[state.open&&isCurrent?"▾":"▸"])
        open.addEventListener("click",(event)=>{
            event.stopPropagation()
            if(this.currentCollection?.name===collection.name){
                //already on it: the caret only folds, and the list stays put
                state.open=!state.open
                this.origin?.saveSessionSoon?.()
                this.renderAll()
            }else{
                this.selectCollection(collection.name)
            }
        })
        const name=CE("button",{
            type:"button",
            className:"fc-collection-name",
            title:`${collection.name} — click to read its formulas`,
            style:{cursor:"pointer",textAlign:"left",minWidth:"0",overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}
        },[collection.name])
        name.addEventListener("click",()=>this.selectCollection(collection.name))
        const count=CE("span",{
            className:"fc-collection-count",
            title:`${formatCount(collection.entries.length)} formulas, ${formatCount(collection.entries.reduce((n,e)=>n+e.targets.length,0))} measured points`
        },[formatCount(collection.entries.length)])
        /* The two checkboxes, and they mean two DIFFERENT things, which is why
           they are two boxes and not one tristate: "output" is what leaves this
           node, "graph" is what is drawn in the central dialog. A user who
           wants a collection compared but not propagated ticks the second and
           not the first, and a single box could not express it. */
        const inOutput=this.collectionCheck(state,"inOutput","Include this collection in the node's output")
        const inGraphs=this.collectionCheck(state,"inGraphs","Draw this collection in the central dialog")
        const handle=this.collectionHandle(collection,state)
        row.append(open,name,count,inOutput,inGraphs,handle)
        /* DELETE / BACKSPACE on the row itself.

           The row is focusable (tabIndex above) and this is its key handler.
           Without it the user has to aim at a ⋮ and then hunt the verb in a
           floating menu to throw away a collection they just made by accident —
           which is the one moment deletion is most likely to be what they want.

           Both keys do the same thing, like they do on the nodes of the flow:
           Mac keyboards have no Delete, and Backspace is what sits under the
           right hand there. */
        row.addEventListener("keydown",(event)=>{
            if(!isDeleteKey(event)) return
            /* a checkbox that has the focus must keep Space and Enter for
               itself, and Backspace on one is not "delete the collection" —
               the row's own handler must not answer for its children */
            if(event.target!==row) return
            event.preventDefault()
            event.stopPropagation()
            this.deleteCollection(collection.name)
        })
        /* NO "focus selects" handler, and that is deliberate.

           `selectCollection` calls renderAll, which rebuilds every row of the
           band — so selecting from `focus` would destroy the very element that
           had just taken the focus, the ring would go back to the body, and the
           Delete that follows would reach nothing. The row is its own delete
           target, so it needs no state change to be deletable, and the focus
           ring alone already shows which collection the key is about to throw
           away. Selecting a collection to READ it stays a click. */
        return row
    }
    collectionCheck(state,key,title){
        const box=CE("input",{type:"checkbox",title,style:{margin:"0",flex:"none"}},[])
        box.checked=!!state[key]
        box.addEventListener("change",()=>{
            state[key]=box.checked
            this.origin?.saveSessionSoon?.()
            if(key==="inGraphs") this.refreshGraph()
            this.publishOutput()
            this.resolveChildren()
        })
        return box
    }

    /* The LEFT panel, in three bands: the toolbar, the collections, the
       formulas of the collection on screen.

       The heights are decided ONCE, here, and not by the content: the
       collection list gets a bounded share and the formula list takes the rest,
       because a formula list has no natural height — it has "as much as you
       scroll" — and an accordion that grew with it would push every other
       node's panel off the panel. */
    setupLeftPanel(){
        const content=this.accordion.DOMelt.content
        content.replaceChildren()
        this.accordion.setSizingMode("viewport",{height:520})
        this.accordion.DOMelt.container.style.maxHeight="75%"
        stylize(content,{
            display:"grid",
            "grid-template-rows":"auto minmax(0, 34%) minmax(0, 1fr)",
            minHeight:"0",
            height:"100%",
            overflow:"hidden",
            padding:"3px",
            gap:"3px"
        })
        content.append(this.buildToolbar(),this.buildCollectionBand(),this.buildFormulaBand())
    }
    buildToolbar(){
        const bar=CE("div",{className:"pp-row",style:{gridTemplateColumns:"auto minmax(0,1fr) auto",fontSize:"0.95em"}},[])
        /* The Formula / Stoichiometry switch, and the ONLY control of the view: the wide
           Fold button that used to sit under this row is gone, and this took its
           place. Two names for one idea is a cost, and with the action gone there
           is nothing left to pay it. */
        this.viewToggle=scaleToggle({
            /* `get` answers for the RIGHT label, which is the convention of every
               other scaleToggle in this file: Lin/Log asks `logY`, so `true` means
               the right-hand state. It used to answer for the LEFT one, and both
               halves were wrong together — the accent lit "Stoichiometry" while
               the list was still showing formulae, and clicking "Stoichiometry"
               called setView("formula"). One line, and the switch was exactly
               backwards in the one place a reader checks it: under the cursor. */
            get:()=>this.parameters.view==="stoichiometry",
            set:(on)=>this.setView(on?"stoichiometry":"formula"),
            leftLabel:"Formula",
            rightLabel:"Stoichiometry",
            title:"One row per formula, or one row per molecule with its isotopologues folded under it"
        })
        this.filterInput=CE("input",{
            type:"search",
            value:this.parameters.filter,
            placeholder:"filter…",
            spellcheck:false,
            title:"Keep only the rows whose notation contains this text",
            style:{width:"100%",minWidth:"0",padding:"2px 4px"}
        },[])
        this.filterInput.addEventListener("input",()=>{
            this.parameters.filter=this.filterInput.value
            this.renderRows()
        })
        this.sortSelect=CE("select",{title:"Column the list is ordered by"},[])
        for(const [value,sort] of Object.entries(FORMULA_SORTS)){
            this.sortSelect.appendChild(new Option(sort.label,value))
        }
        this.sortSelect.value=this.parameters.sort
        this.sortSelect.addEventListener("change",()=>{
            this.parameters.sort=this.sortSelect.value
            this.renderRows()
        })
        this.countLabel=CE("span",{className:"pp-readout"},["—"])
        this.sortField=CE("label",{style:{display:"flex",alignItems:"center",gap:"4px",minWidth:"0"}},[this.sortSelect])
        this.sortField.title="Order of the list"
        bar.append(this.viewToggle,this.filterInput,CE("div",{style:{display:"flex",alignItems:"center",gap:"4px"}},[this.sortField,this.countLabel]))
        /* The wide "Fold to stoichiometry" button that used to sit under this row
           is GONE, and the toggle above takes its place.

           They were the same verb twice: the button called setView("stoichiometry")
           and cleared the open sets, which is what the toggle does too when it is
           moved to the right. What it cost was a full-width button under the
           toolbar — the loudest object on a panel whose whole job is a quiet
           column of formulae — to say something the first control already said.

           So the toolbar is ONE row again: view, filter, order, count. */
        return bar
    }

    /* --- the three panels ------------------------------------------------ */
    constructor(title,origin,destinationFlow,position={x:180,y:10}){
        //ONE input, and it is multiplexed: Flow.parentSynapse gathers every
        //link landing on that single anchor into one Map, so a hundred
        //collections arrive on one socket instead of a hundred sockets.
        //ONE output: what the ticked collections add up to.
        super(title,[[]],[[]],origin,destinationFlow,position)
        this.status="floating"
        /* formula = one row per measurable formula.
           stoichiometry = one row per MOLECULE, the isotopologues folded under
           it. The toggle is a VIEW, never a transformation: the rows below are
           the same objects either way, and unfolding restores them untouched. */
        this.parameters.view="formula"
        this.parameters.filter=""
        this.parameters.sort="mz"
        //the tolerance that pairs a formula with the points measured on it
        this.parameters.ppmWindow=5
        this.parameters.logY=false
        this.parameters.graphBudget=FormulaCollectionNode.GRAPH_POINT_BUDGET
        //the collection on screen, and the formula read inside it, both by NAME
        this.parameters.current=null
        this.parameters.selection=null
        //per collection: the two checkboxes, the notes, and nothing else
        this.parameters.collectionState={}
        /* the collections the user makes HERE. Only the text they typed is
           stored, one string per formula: a Formula holds a Map indexed by
           Element, so a session carrying them would carry a periodic table
           with it. They are rebuilt at every resolve, which is why a local
           collection can be added to while a parent one cannot. */
        this.parameters.localCollections=[]
        //runtime only, rebuilt by every resolve
        this.collections=[]
        this.diagnostics=[]
        this.currentCollection=null
        this.selectedEntry=null
        this.loadedTable=null
        this.list=null
        this.rows=[]
        /* THE TABLE IS ASKED FOR HERE, AT CONSTRUCTION, and not on first use.

           A node that waits to be asked is a node that answers "loading…" to a
           keystroke typed AFTER the table had already arrived — which is what
           happened, and it looked like the node was broken. The App is already
           fetching it; all this does is attach to that fetch from the start.

           And when it lands, the node PUTS ITSELF RIGHT: the collections that
           were stored as text could not be read a moment ago, because a formula
           without a table is only a name. So they are re-read and the resolve
           runs, which is why a formula typed before the page finished loading
           still shows up on its own. */
        this.table().then(()=>{
            if(!this.accordion) return
            this.renderAll()
            if(this.parameters.localCollections.length) this.startResolve()
        })
        //the unfolded molecules and the unfolded formulas, by key
        this.openMolecules=new Set()
        this.openEntries=new Set()
        const inputAnchors=this.DOMelt.querySelectorAll('.input.anchor')
        if(inputAnchors[0]){
            inputAnchors[0].innerHTML='<title>Input: any number of collections of Formula, all on this one anchor</title>'
        }
        const outputAnchors=this.DOMelt.querySelectorAll('.output.anchor')
        if(outputAnchors[0]){
            outputAnchors[0].innerHTML='<title>Output: the collections ticked for output</title>'
        }
    }
    registered(e){
        if(e.detail.msg.caster!==this||this.accordionRight){
            return
        }
        super.registered(e)
        const {channel,registrationName,label}=e.detail.msg
        /* The right panel is the DETAIL of what the left list has selected:
           the full key, the mass, every target with its error, and the free
           text. The left panel stays a list — putting ten thousand rows and
           their commentary in one column would make both unreadable. */
        this.accordionRight=new Accordion(
            `${label} (detail)`,
            this.origin,
            this.origin.main.querySelector(".vertical.right.content")
        )
        channel.register(`${registrationName}:detail`,this.accordionRight,`${label} (detail)`)
        this.setupLeftPanel()
        this.setupRightPanel()
    }
    renderAll(){
        this.renderCollections()
        this.renderAddRow()
        this.renderRows()
        this.renderSelection()
        this.renderDiagnostics()
    }

    /* --- the rows the left panel shows ---------------------------------- */
    /* One list, three shapes, and the difference is only in what a row HOLDS.

       In "formula" view a row is a leaf. In "stoichiometry" view a row is a
       molecule: the leaves that share a root are folded into it, and the count
       in front says how many. The fold is a GROUPING, never a merge: the
       formulas keep their own keys, their own m/z and their own targets, and
       unfolding gives every one of them back exactly as it was. What is lost
       by folding is the noise of a thousand isotopologues competing for one
       line, and nothing else. */
    visibleRows(){
        const collection=this.currentCollection
        if(!collection) return []
        const entries=collection.entries
        const filter=this.parameters.filter.trim().toLowerCase()
        let rows
        if(this.parameters.view==="stoichiometry"){
            const groups=new Map()
            for(const entry of entries){
                const key=entry.molecule??entry.key
                if(!groups.has(key)) groups.set(key,{molecule:key,entries:[]})
                groups.get(key).entries.push(entry)
            }
            rows=[...groups.values()].map(group=>({
                kind:"molecule",
                molecule:group.molecule,
                entries:group.entries,
                key:group.entries[0].key,
                /* The group is LABELLED with the key that grouped it, not with
                   the notation of whichever leaf happened to come first.

                   `String(root)` is what this used to print, and it is wrong for
                   every protonated or adducted species: toString writes from
                   `written` — the core — while the grouping reads `counts`, which
                   carries the absorbed group. So CH4;H+ is grouped as CH5+ and then
                   LABELLED "CH4[H+]", a formula with five hydrogens written as
                   four plus a bracket. The row said one thing and the count in
                   front of it (×2, both spellings) said another.

                   moleculeKey is the one string guaranteed to describe the whole
                   group: it is what put these leaves in this box, and it is
                   already a display form — Hill order, no isotope mass numbers.
                   Printing it also makes the label independent of the ORDER of
                   the entries, which "the first leaf" never was: the same
                   collection could show CH4[H+] or CH5[+] on two machines that
                   enumerated their parents differently. */
                notation:group.molecule,
                mz:group.entries.reduce((n,e)=>n+e.mz,0)/group.entries.length,
                count:group.entries.length
            }))
        }else{
            rows=entries.map(entry=>({kind:"formula",entry,key:entry.key,notation:entry.notation,mz:entry.mz}))
        }
        if(filter){
            rows=rows.filter(row=>row.notation.toLowerCase().includes(filter)
                ||(row.kind==="molecule"&&row.entries.some(e=>e.key.toLowerCase().includes(filter))))
        }
        rows.sort(formulaComparator(this.parameters.sort))
        return rows
    }
    renderRows(){
        if(!this.list) return
        const rows=this.visibleRows()
        this.rows=rows
        this.list.setRows(rows)
        this.updateCountReadout(rows)
    }
    updateCountReadout(rows){
        if(!this.countLabel) return
        const collection=this.currentCollection
        const total=collection?collection.entries.length:0
        const molecules=collection&&this.parameters.view==="stoichiometry"
            ?new Set(collection.entries.map(e=>e.molecule??e.key)).size
            :total
        this.countLabel.textContent=collection
            ?`${formatCount(rows.length)} / ${formatCount(this.parameters.view==="stoichiometry"?molecules:total)}`
            :"—"
        this.countLabel.title=collection
            ?`${formatCount(rows.length)} shown, ${formatCount(total)} formulas, ${formatCount(molecules)} molecules`
            :"no collection selected"
    }
    /* The row itself. Plain divs, not the Table class: that one is a grid of
       strings with a ruler, and what is needed here is a row with a note
       marker, a title, and a click that means something.

       TWO MODES IN ONE FUNCTION, because the pool must not grow a second kind
       of element: a null element BUILDS a fresh one, a real one gets FILLED.
       Two callbacks would mean two pools of the same thing, and a recycled
       element must never activate the formula it used to be showing — which is
       why the row is re-attached on every single fill. */
    drawRow(element,row){
        if(!element){
            const root=CE("div",{className:"fc-row"},[])
            const notation=CE("span",{className:"fc-cell fc-notation"},[""])
            const mz=CE("span",{className:"fc-cell fc-num"},[""])
            const error=CE("span",{className:"fc-cell fc-num"},[""])
            const intensity=CE("span",{className:"fc-cell fc-num"},[""])
            const note=CE("span",{className:"fc-cell fc-note"},[""])
            root.append(notation,mz,error,intensity,note)
            //one listener, not the app's delegated handleClick AND one of our
            //own: both would fire on a single click and toggle the row twice
            root.addEventListener("click",(event)=>{
                event.stopPropagation()
                if(root.row) this.activateRow(root.row)
            })
            root.cells=[notation,mz,error,intensity,note]
            root.notation=notation
            return root
        }
        const [notation,mz,error,intensity,note]=element.cells
        element.row=row
        notation.textContent=prettyNotation(row.notation)
        element.notation.title=row.kind==="molecule"
            ?`${formatCount(row.count)} formulas on this molecule — click to unfold`
            :row.key
        mz.textContent=formatMz(row.mz)
        if(row.kind==="molecule"){
            /* The count REPLACES the error column in this view: a molecule has
               no error of its own, and "how many did I just fold" is the
               number the user is looking for at that moment. */
            error.textContent=`×${formatCount(row.count)}`
            error.className="fc-cell fc-count"
            intensity.textContent=""
            note.textContent=""
        }else{
            const entry=row.entry
            error.textContent=Number.isFinite(entry.errorPpm)
                ?`${entry.errorPpm>=0?"+":""}${entry.errorPpm.toFixed(1)}`
                :"—"
            error.className="fc-cell fc-num"
            intensity.textContent=Number.isFinite(entry.intensity)?formatValue(entry.intensity):"—"
            note.textContent=entry.note?"✎":""
            note.title=entry.note||"no information yet — write some in the panel on the right"
        }
        element.classList.toggle("selected",this.parameters.selection===row.key)
        element.classList.toggle("unfolded",row.kind==="molecule"
            ?this.openMolecules.has(row.molecule)
            :this.openEntries.has(row.key))
        return element
    }

    /* --- the central graph: one trace per collection the user ticked ----- */
    /* What is drawn is the COLLECTION, not the formula list: one trace per
       ticked collection, x = m/z, y = intensity, sticks to zero. That is what
       makes a hundred collections comparable at a glance, which a formula
       index never would.

       The budget is a hard stop and it says so out loud. A hundred collections
       of fifty thousand formulas is five million sticks, and a WebGL buffer of
       that size is not a slow graph, it is a dead tab. What was dropped is
       reported in the readout rather than silently thinning the picture. */
    refreshGraph(){
        if(!this.graph) return
        const traces=[]
        let eligible=0
        let drawn=0
        for(const collection of this.collections){
            if(!this.collectionState(collection.name).inGraphs) continue
            const points=[]
            for(const entry of collection.entries){
                for(const target of entry.targets){
                    if(!Number.isFinite(target.mz)||!Number.isFinite(target.intensity)) continue
                    points.push([target.mz,target.intensity])
                }
            }
            if(!points.length) continue
            eligible+=points.length
            //sorted by m/z: a stick plot read left to right must not jump
            points.sort((a,b)=>a[0]-b[0])
            const x=new Float64Array(points.length)
            const y=new Float64Array(points.length)
            for(let i=0;i<points.length;i++){
                x[i]=points[i][0]
                y[i]=points[i][1]
            }
            traces.push(new XYTrace({
                id:`${collection.name}:sticks`,
                title:`${collection.name} (${points.length})`,
                wave:Wave.fromCoordinates(x,y,{collection:collection.name},["m/z","intensity"]),
                options:{
                    color:traceColor(this.collections.indexOf(collection)),
                    mode:"sticks-to-zero",
                    layer:"gl"
                }
            }))
            drawn+=points.length
        }
        const capped=drawn>this.parameters.graphBudget
        this.graph.setTraces(traces)
        this.graph.parameters.axis.left.scale=this.parameters.logY?"log":"linear"
        /* The axes say what they measure, and they are written ONCE here rather
           than left to syncAxisLabels: that helper copies the labels of the
           FIRST trace, and a graph whose axes change meaning when a collection
           is ticked on or off is a graph nobody reads twice. */
        this.graph.parameters.axis.bottom.label="m/z"
        this.graph.parameters.axis.bottom.autoLabel=false
        this.graph.parameters.axis.left.label="Intensity"
        this.graph.parameters.axis.left.autoLabel=false
        this.graph.drawGraph()
        if(this.graphReadout){
            this.graphReadout.textContent=capped
                ?`${formatCount(drawn)} / ${formatCount(eligible)} (capped)`
                :`${formatCount(drawn)} / ${formatCount(eligible)}`
            this.graphReadout.style.color=capped?"#ffb347":""
        }
    }

    /* What this node publishes: the ticked collections, and nothing else.

       A collection is published as a PLAIN descriptor, not as Formula objects.
       Two reasons, and the second is the decisive one: a downstream node that
       wants the chemistry re-parses `key` against the same table (it never
       abbreviates, so it round-trips exactly), and a session that stored live
       formulas would store a periodic table along with each of them. */
    publishOutput(){
        const published=[]
        for(const collection of this.collections){
            if(!this.collectionState(collection.name).inOutput) continue
            published.push({
                name:collection.name,
                formulas:collection.entries.map(entry=>({
                    key:entry.key,
                    notation:entry.notation,
                    mz:entry.mz,
                    mass:entry.mass,
                    charge:entry.charge,
                    molecule:entry.molecule,
                    errorPpm:entry.errorPpm,
                    intensity:entry.intensity,
                    note:entry.note,
                    targets:entry.targets.map(t=>({
                        mz:t.mz,
                        intensity:t.intensity,
                        errorPpm:t.errorPpm,
                        cost:Number.isFinite(t.cost)?t.cost:null
                    }))
                }))
            })
        }
        this.outputs[0]=published
    }
    async startResolve(){
        this.status="pending"
        await this.table()
        this.readCollections()
        this.syncCurrentCollection()
        this.publishOutput()
        this.renderAll()
        this.refreshGraph()
        this.setStatus(this.collections.length?"resolved":"floating")
    }
    /* The periodic table, ONCE and on demand.

       The table belongs to the ORIGINE and is AWAITED, never read directly: the
       App loads it in the background, so a node that read `origin.table` the
       instant it woke would report "no table" for a table still in flight. The
       same shape as FKMDNode's, deliberately.

       THE CACHE IS CALLED `loadedTable`, and that is not a style choice. A node
       with a method `table()` cannot also have a field `table`: assigning
       `this.table = null` in the constructor puts an OWN property on the
       instance that shadows the method, and the next `this.table()` throws
       "this.table is not a function" — which is exactly what happened, and it
       took the whole node down at creation. The method asks; the App owns the
       data; the node keeps one reading of it under a name that cannot collide. */
    async table(){
        if(this.origin.table){
            this.loadedTable=this.origin.table
            return this.loadedTable
        }
        const loaded=await this.origin.tableReady
        this.loadedTable=loaded??null
        return this.loadedTable
    }
    /* The collection on screen, chosen by name and never by index.

       After a resolve the collections are rebuilt from the parents, so a
       selection held as an index would silently move to a different collection
       as soon as one was added above it. A name survives that, and a name that
       has gone away simply falls back to the first one. */
    syncCurrentCollection(){
        const names=this.collections.map(c=>c.name)
        if(this.parameters.current&&names.includes(this.parameters.current)){
            this.currentCollection=this.collections.find(c=>c.name===this.parameters.current)
        }else{
            this.currentCollection=this.collections[0]??null
            this.parameters.current=this.currentCollection?.name??null
        }
        this.selectedEntry=this.currentCollection&&this.parameters.selection
            ?this.currentCollection.entries.find(e=>e.key===this.parameters.selection)??null
            :null
    }
    setStatus(status){
        this.status=status
        dispatchEvent(this.events.broadcast.nodeStatusChanged.call(this,status))
    }

    /* --- reading the multiplexed input ----------------------------------- */
    /* The ONE input is a Map parent -> outputs, and Flow.parentSynapse fills
       it from EVERY link that lands on it. That is the multiplexing: no
       bookkeeping here, and a hundred cables on a single anchor behave exactly
       like one.

       A collection is whatever a parent publishes. Three shapes are accepted,
       because the producers do not agree yet and a reader that refused two of
       them would be useless on the flow as it stands:
         - a Formula / Stoichiometry: a collection of one,
         - an array of them: one collection named after the parent,
         - an object with `formulas` and an optional `points` array: the full
           form, where each point carries the m/z that was measured.
       Anything else is named in the diagnostics rather than dropped in
       silence: a collection the user cannot see is one they will spend an
       hour looking for. */
    /* THE collections of this node, at every resolve: the ones that arrive on
       the input, plus the ones the user made here.

       The local ones come LAST and deliberately so. They are the ones this node
       owns, and burying them under a hundred parents' collections would make
       them the hardest to find, for no gain: a collection the user created is
       the one they are looking for. */
    readCollections(){
        const collections=[]
        const diagnostics=[]
        const input=this.inputs[0]
        if(input instanceof Map){
            for(const [parent,values] of input){
                const parentName=parent.events?.registrationName??parent.title
                for(const output of values??[]){
                    for(const raw of (Array.isArray(output)?output:[output])){
                        const collection=this.asCollection(raw,parentName,diagnostics)
                        if(collection) collections.push(collection)
                    }
                }
            }
        }
        for(const local of this.parameters.localCollections){
            const collection=this.buildCollection(
                local.name,
                (local.keys??[]).map(key=>this.localFormula(key,local.name,diagnostics)).filter(Boolean),
                [],
                diagnostics,
                {local:true}
            )
            if(collection) collections.push(collection)
        }
        this.collections=collections
        this.diagnostics=diagnostics
    }
    /* The objects behind a local collection's stored keys.

       Only the KEYS are stored, never the formulas: a Formula holds a Map
       indexed by Element, so a session carrying them would drag the periodic
       table along. `key` never abbreviates, so re-reading it is exact — and if
       it cannot be re-read (a table still loading, a key from another table)
       that is a diagnostic on ONE collection, not a failure of the node. */
    localFormula(key,name,diagnostics){
        if(!this.loadedTable){
            diagnostics.push(`${name}: the periodic table is not ready, "${key}" is not shown`)
            return null
        }
        try{
            /* The text as TYPED, not `key`. It looks redundant next to the
               notation, and it is the only spelling that comes back identical:
               a formula carrying a group adduct does not survive being
               re-read from its key, because the adduct's atom is counted once
               in the composition and once in the brackets. The user typed a
               string that parses to what they meant, so that string is what
               this node keeps. */
            return Formula.parse(key,this.loadedTable)
        }catch(error){
            diagnostics.push(`${name}: ${error.message}`)
            return null
        }
    }
    asCollection(raw,parentName,diagnostics){
        /* FOUR shapes, and the fourth is the one the class itself produces.

           The node is a reader, and a reader that only understood one shape
           would be useless on the flow as it stands — the producers do not
           agree yet. So: a Formula alone, an array of them, a {name, formulas,
           points} object, and a FormulaCollection coming back from another
           node. Anything else is NAMED in the diagnostics rather than dropped in
           silence: a collection the user cannot see is one they will spend an
           hour looking for. */
        if(raw instanceof FormulaCollection){
            const points=raw.points??[]
            const collection=this.buildCollection(
                raw.name||parentName,raw.formulas,points,diagnostics)
            //the class may have been built with a different ppm window, and the
            //one on screen is the one the user can change
            if(collection) collection.ppm=this.parameters.ppmWindow
            return collection
        }
        if(raw instanceof Formula||raw instanceof Stoichiometry){
            return this.buildCollection(parentName,[raw],[],diagnostics)
        }
        if(Array.isArray(raw)){
            return this.buildCollection(parentName,raw,[],diagnostics)
        }
        if(raw&&typeof raw==="object"){
            const name=raw.name??raw.title??parentName
            const formulas=raw.formulas??raw.entries??raw.items??null
            if(Array.isArray(formulas)){
                return this.buildCollection(name,formulas,raw.points??raw.targets??[],diagnostics)
            }
        }
        diagnostics.push(`${parentName}: nothing readable (${raw?.constructor?.name??typeof raw})`)
        return null
    }

    /* Builds ONE collection — and hands the chemistry to the class that owns it.

       The pairing, the ppm window, the "closest wins" rule, the deduplication
       by key and the family of every formula all live in FormulaCollection,
       in chemistry.js. This method only decides WHAT a collection is made of
       and stamps the node's own annotations onto it.

       The annotations are stamped here and not in the class, and that is the
       boundary: a note is something the USER said about a formula, not a fact
       about it. A chemistry file that carried user annotations would be
       describing a panel. */
    buildCollection(name,formulas,points,diagnostics,{local=false}={}){
        const state=this.collectionState(name)
        const collection=new FormulaCollection({
            name,
            table:this.loadedTable,
            ppm:this.parameters.ppmWindow
        })
        for(const formula of formulas??[]) collection.add(formula)
        collection.setPoints(points??[])
        for(const entry of collection.entries) entry.note=state.notes[entry.key]??""
        //`local` is the one thing the class cannot know: a collection this node
        //made can be written to and deleted, a collection a parent made is
        //rebuilt at every resolve and would swallow the change silently
        collection.local=local
        collection.state=state
        diagnostics.push(...collection.diagnostics)
        collection.diagnostics=[]
        return collection
    }
    /* The state record of a collection, created on first sight. The name is
       the key, not an index: indices move when a parent is rewired, and a
       checkbox that jumps to another collection after a reload is a bug the
       user cannot work around. */
    collectionState(name){
        const states=this.parameters.collectionState
        if(!states[name]){
            states[name]={inOutput:true,inGraphs:true,notes:{},open:true}
        }
        const state=states[name]
        if(typeof state.inOutput!=="boolean") state.inOutput=true
        if(typeof state.inGraphs!=="boolean") state.inGraphs=true
        if(!state.notes||typeof state.notes!=="object") state.notes={}
        return state
    }

    renderSelection(){
        if(!this.detail) return
        this.detail.replaceChildren()
        const entry=this.selectedEntry
        if(!entry){
            this.detail.append(CE("div",{className:"pp-caption"},["Selection"]))
            this.detail.append(CE("div",{style:{opacity:"0.7",fontSize:"0.85em"}},[
                this.collections.length
                    ?"Pick a formula in the list on the left."
                    :"Connect a node that publishes a collection of Formula."
            ]))
            return
        }
        const state=this.currentCollection?this.collectionState(this.currentCollection.name):null
        const line=(label,value)=>{
            const row=CE("div",{className:"fc-field"},[])
            row.append(
                CE("span",{className:"fc-field-label"},[label]),
                CE("span",{className:"fc-field-value"},[String(value)])
            )
            return row
        }
        this.detail.append(CE("div",{className:"pp-caption"},["Selection"]))
        this.detail.append(CE("div",{className:"fc-bigkey",title:entry.notation},[prettyNotation(entry.notation)]))
        this.detail.append(line("m/z",formatMz(entry.mz)))
        this.detail.append(line("mass",Number.isFinite(entry.mass)?entry.mass.toFixed(6):"—"))
        this.detail.append(line("charge",entry.charge>0?`+${entry.charge}`:`${entry.charge}`))
        this.detail.append(line("molecule",entry.molecule?prettyNotation(entry.molecule):"—"))
        this.detail.append(line("intensity",formatValue(entry.intensity)))
        this.detail.append(line("error",Number.isFinite(entry.errorPpm)?`${entry.errorPpm>=0?"+":""}${entry.errorPpm.toFixed(2)} ppm`:"—"))
        /* The KEY is the identity and it never abbreviates, so it is shown
           verbatim and wrapped: comparing two rows means reading every mass
           number, and an ellipsis in the middle of one is worse than no key. */
        this.detail.append(line("key",entry.key))
        this.detail.append(CE("div",{className:"pp-caption"},[`Targets (${entry.targets.length})`]))
        if(!entry.targets.length){
            this.detail.append(CE("div",{style:{opacity:"0.7",fontSize:"0.85em"}},[
                `No measured point within ${this.parameters.ppmWindow} ppm.`
            ]))
        }else{
            const table=CE("div",{className:"fc-targets"},[])
            table.append(CE("div",{className:"fc-targets-line fc-targets-head"},["m/z","intensity","error","cost"]))
            for(const target of entry.targets){
                table.append(CE("div",{className:"fc-targets-line"},[
                    formatMz(target.mz),
                    formatValue(target.intensity),
                    Number.isFinite(target.errorPpm)?`${target.errorPpm>=0?"+":""}${target.errorPpm.toFixed(2)}`:"—",
                    Number.isFinite(target.cost)?target.cost.toFixed(3):"—"
                ]))
            }
            this.detail.append(table)
        }
        this.detail.append(CE("div",{className:"pp-caption"},["Information"]))
        /* The free text is the "add information" the list promises. It is
           written on every keystroke into the state, so a reload finds the
           annotation where the user left it. */
        this.noteField=CE("textarea",{
            className:"fc-note",rows:"3",spellcheck:false,
            placeholder:"anything worth remembering about this formula"
        },[])
        this.noteField.value=state?.notes?.[entry.key]??""
        this.noteField.addEventListener("input",()=>{
            if(!state) return
            const text=this.noteField.value
            if(text) state.notes[entry.key]=text
            else delete state.notes[entry.key]
            this.origin?.saveSessionSoon?.()
            this.renderRows()
        })
        this.detail.append(this.noteField)
    }

    /* --- the two halves of the state, and the restorations -------------- */
    serializeState(){
        /* Only the CHOICES are stored, never the chemistry.

           The collections come from the links: a skeleton knows which parents
           are wired, and the resolve rebuilds what they say. A state carrying
           ten thousand Formula objects would be a session file measured in
           hundreds of megabytes, and a SECOND copy of data the flow already
           holds — the thing nodeRestoreData explicitly avoids when it says
           "inputs keep their shape only".

           What is worth keeping is what no resolve can guess: the collections
           the user unticked, the one they were reading, the filters, and the
           annotations they typed. The graph half is the inherited one, because
           the axes and the trace options are as much the user's as these are. */
        return {
            ...(super.serializeState()??{}),
            view:this.parameters.view,
            filter:this.parameters.filter,
            sort:this.parameters.sort,
            ppmWindow:this.parameters.ppmWindow,
            logY:this.parameters.logY,
            graphBudget:this.parameters.graphBudget,
            current:this.parameters.current,
            selection:this.parameters.selection,
            collectionState:DC(this.parameters.collectionState),
            //the collections the user made here, as the text they typed. They
            //are the only collections this state carries, and carrying them as
            //texts is what keeps a session from growing a periodic table
            localCollections:DC(this.parameters.localCollections)
        }
    }
    restoreState(state){
        super.restoreState(state)
        if(!state){
            return
        }
        //a view that is neither of the two would leave the toggle painting half
        //a state, so an unreadable value falls back instead of sticking
        this.parameters.view=state.view==="stoichiometry"?"stoichiometry":"formula"
        this.parameters.filter=typeof state.filter==="string"?state.filter:""
        this.parameters.sort=FORMULA_SORTS[state.sort]?state.sort:"mz"
        if(Number.isFinite(state.ppmWindow)&&state.ppmWindow>0){
            this.parameters.ppmWindow=state.ppmWindow
        }
        this.parameters.logY=!!state.logY
        if(Number.isFinite(state.graphBudget)&&state.graphBudget>0){
            this.parameters.graphBudget=state.graphBudget
        }
        this.parameters.current=typeof state.current==="string"?state.current:null
        this.parameters.selection=typeof state.selection==="string"?state.selection:null
        this.parameters.collectionState=state.collectionState&&typeof state.collectionState==="object"
            ?DC(state.collectionState)
            :{}
        /* A saved collection is a name and a list of texts. Anything else in
           here is a session file this build did not write, and dropping it
           quietly would be better than throwing on it: the collection comes
           back empty and the user retypes what they had. */
        this.parameters.localCollections=Array.isArray(state.localCollections)
            ?state.localCollections
                .filter(local=>local&&typeof local.name==="string")
                .map(local=>({name:local.name,keys:Array.isArray(local.keys)?local.keys.filter(k=>typeof k==="string"):[]}))
            :[]
        /* The widgets only exist once the node has been REGISTERED, and a
           restore happens after — but a headless restore must not throw on a
           node that never opened a panel, so every repaint is guarded. */
        this.viewToggle?.paint()
        if(this.sortSelect) this.sortSelect.value=this.parameters.sort
        if(this.filterInput) this.filterInput.value=this.parameters.filter
        this.renderCollections()
        this.renderRows()
        this.renderSelection()
        this.renderGraphOptions()
    }
    restoreAfterImport(){
        super.restoreAfterImport()
        /* The panels are drawn EMPTY on purpose. The collections arrive with
           the resolve that follows the import; re-reading them here would
           resolve this node outside the flow's own order — the rule
           DelimitedTextNode and SimpleXYPlotNode both follow. */
        this.renderCollections()
        this.renderRows()
    }
    refreshFromLinks(){
        /* The undo path: this is a NEW instance whose inputs are empty Maps,
           and the command has just drawn the links again. Same contract as
           SimpleXYPlotNode — rebuild from the live links, never from a copy
           the command happens to be holding. */
        this.destination?.syncInputs(this).then(()=>this.startResolve())
    }

    renderGraphOptions(){
        if(!this.graphOptions) return
        this.graphOptions.replaceChildren()
        this.logToggle=scaleToggle({
            get:()=>this.parameters.logY,
            set:(on)=>{
                this.parameters.logY=on
                this.graph.parameters.axis.left.scale=on?"log":"linear"
                this.graph.drawGraph()
            },
            leftLabel:"Lin",
            rightLabel:"Log",
            title:"Scale of the intensity axis"
        })
        const budget=CE("input",{
            type:"number",min:"1000",step:"10000",size:7,
            value:String(this.parameters.graphBudget),
            title:"How many points the central graph may draw at once, over every collection",
            style:{width:"100%",minWidth:"0",padding:"2px"}
        },[])
        budget.addEventListener("change",()=>{
            const parsed=Number(budget.value)
            this.parameters.graphBudget=Number.isFinite(parsed)&&parsed>=1000
                ?Math.trunc(parsed)
                :FormulaCollectionNode.GRAPH_POINT_BUDGET
            budget.value=String(this.parameters.graphBudget)
            this.refreshGraph()
        })
        this.graphReadout=CE("span",{
            className:"pp-readout",
            title:"Points drawn / points eligible, and how many the budget left out"
        },[""])
        const row=CE("div",{className:"pp-row",style:{gridTemplateColumns:"auto minmax(0,1fr) auto",fontSize:"0.95em"}},[])
        row.append(this.logToggle,CE("label",{style:{display:"flex",alignItems:"center",gap:"4px",minWidth:"0"}},["Budget",budget]),this.graphReadout)
        this.graphOptions.append(CE("div",{className:"pp-caption"},["Graphs"]),row)
    }
    suicide(options={}){
        /* The scroll list holds a ResizeObserver and a pool of rows: without
           this, a deleted node leaves an observer watching a detached box. */
        this.list?.dispose()
        this.list=null
        this.accordionRight?.suicide()
        this.accordionRight=null
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
            eye.textContent=trace.options.hidden?"ðŸš«":"ðŸ‘"
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
        super.restoreAfterImport()
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

/* The type of every node a session can name, in ONE place. It used to be spelled
   out inside App.importSession, and a list of node types written twice is a list
   that drifts: a type added to one and forgotten in the other would come back as
   a bare Node with no inputs at all, silently. */
const NODE_CONSTRUCTORS={
    Node,
    NodeWithAccordion,
    NodeWithAccordionGraph,
    NodeWithRightAccordionGraph,
    SimpleXYPlotNode,
    DelimitedTextNode,
    Operation,
    //the three names the peak-picker has carried: a session saved before the
    //merge names the old nodes, and an unknown type would silently become a
    //bare Node with no inputs at all
    PeakPickingNode,
    PersistentHomology0DNode:PeakPickingNode,
    "AntiRadioNode":PeakPickingNode,
    TrimmerNode,
    FKMDNode,
    FormulaCollectionNode,
    //the first tools-category node: it has no data, but a session must be able
    //to name it, or a reload would turn it into a bare Node with no dialog
    ChatNode
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
        //the pin travels with the node: an undo that brings a node back must
        //bring back the choice the user made about where it lives
        pinned:!!node.parameters.pinned,
        status:node.status,
        source:node.parameters.source?DC(node.parameters.source):null,
        state:node.serializeState?.()??null
    }
}

function createNodeForHistory(origin,flow,data){
    const position={...data.position}
    //DC on the shape only: a record must not share its arrays with the node it
    //brings back, or the next resolve would rewrite the history
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

/* THE ONE place that knows how a node class is called.

   Two signatures coexist here: the nodes that build their own inputs and outputs
   take (title, app, flow, position), the rest take the classic
   (title, inputs, outputs, app, flow, position). Calling one the other way does
   not fail politely - `destination` arrives undefined and the constructor dies on
   this.destination.nodeSet, and the whole app goes with it. So the undo command,
   the file import and the reload all come through here rather than each picking
   its own spelling. */
const SELF_SHAPED_NODES=new Set([
    DelimitedTextNode,Operation,PeakPickingNode,TrimmerNode,FKMDNode,
    //ChatNode builds its own (empty) inputs and outputs, so it takes the
    //(title, app, flow, position) signature. Left out of this set, a reload
    //would call it with five arguments and its slots would be the App.
    ChatNode,
    //one multiplexed input, one output: the collection reader declares its own
    //shape for the same reason, and a session that spelled it out would be
    //describing a socket count the flow decides anyway
    FormulaCollectionNode
])
/* A file spells a node's shape out. A skeleton only knows how many slots the node
   HAD: what was in them was data, and data is rebuilt by the resolve. A link is
   restored by index, so it is the count that has to survive. */
const emptySlots=count=>Array.from({length:Math.max(0,Math.trunc(count)||0)},()=>[])
function buildNode(data,app,flow,constructors=NODE_CONSTRUCTORS){
    const NodeType=constructors[data.type]??constructors.Node
    const position={x:data.position?.x??10,y:data.position?.y??10}
    if(SELF_SHAPED_NODES.has(NodeType)){
        return new NodeType(data.title,app,flow,position)
    }
    return new NodeType(
        data.title,
        data.inputs??emptySlots(data.inputCount),
        data.outputs??emptySlots(data.outputCount),
        app,
        flow,
        position
    )
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
            //a node that dies leaves a hole where it was: the arrangement is
            //what closes it, so the field never keeps a gap nobody can fill
            nodeKilled(e){this.autoLayout()},
            nodeStatusChanged(e){this.forwardStatus(e.detail.emitter,e.detail.msg.status)},
            linkSelected(e){},
            async resolveFlow(e){
                await this.resolveFlow()
            },
        }}
        this.nodeSet=new Set()
        this.linkList=[]
        /* THE SELECTION, and it lives on the Flow because that is where the
           geometry is: "is this node selected" is a property of the field, not
           of the node, and a node that did not know it was selected could not
           draw its own outline.

           It is a Set of node instances, NOT of node ids. A node deleted and
           restored by an undo is a DIFFERENT instance with the same id, and a
           selection that outlived the delete would then point at a dead
           object: the outline would stay on nothing, and dragging it would
           move a node that is no longer there. The entries are therefore
           pruned against nodeSet on every read (see selection()). */
        this.selection=new Set()
        /* The node whose panels are on screen — the LAST one clicked into the
           selection. A Set cannot remember an order, so "last" has to be
           carried, and it is carried here rather than recomputed. */
        this.lastSelected=null
        /* Clicking the BACKGROUND empties the selection. Without this, two
           selected nodes could only be emptied one click at a time, which is
           the other half of "I can never deselect". The check is on the event
           TARGET, not the currentTarget: a click that landed on a node must
           not be mistaken for a click on the field behind it, which would
           clear the selection the very moment a node was added to it. */
        this.container.addEventListener("click",(event)=>{
            //a click on a node's own box, on a cable, or on an anchor is the
            //node's business and leaves the selection alone
            if(event.target.closest(".node, .link, .anchor")){
                return
            }
            this.clearSelection()
        })
        //tracks the live instance that replaced a deleted node (undo of "Delete
        //node"), so older commands recorded against the dead instance stay effective
        this.replacements=new Map()
        this.parameters={
            field:{
                drawn:false,
                node:[],
                links:{stiffness:75}
            },
            //the arrangement is a PARAMETER, not a constant buried in the
            //layout: a bigger flow wants wider columns, and a session that
            //remembers its own spacing reopens looking the way it was left
            layout:{...LAYOUT_DEFAULTS}
        }
        stylize(this.container,{
            position:"relative",
            width:"100%",
            height:"100%",
            //the field is grown to fit the drawing, so a flow bigger than the
            //window scrolls instead of losing nodes off the right edge
            overflow:"auto"
        })
        //the App observes any element that owns a handleResize, so the field
        //follows the window: a narrower window must not crop the drawing
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
        //always merged over the defaults: a session restores flow.parameters
        //field by field, and an older file simply has no layout in it
        return {...LAYOUT_DEFAULTS,...this.parameters.layout}
    }
    /* The flow, described the way layout.js wants it: plain numbers, no DOM.

       Mind the names, they are the ones of the DOM and they read backwards -
       the node that PRODUCES is link.inputNode and owns an output anchor, the
       node that CONSUMES is link.outputNode. */
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
    /* Puts every node where it belongs: one column per stage of the flow, the
       nodes of a column packed with the smallest gap that still reads as a
       gap, and the order inside a column chosen to cross as few cables as
       possible. Nodes the user dragged by hand (pinned) stay exactly where
       they are and everything else flows around them.

       It runs on its own whenever the shape of the flow changes; only the
       "Arrange nodes" command records it, because an arrangement the user did
       not ask for has no business in the undo stack. */
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
    /* What the user asked for: forget every pin and lay the whole flow out
       again. Recorded - but only if it moved something, because an undo entry
       that undoes nothing is an undo entry that confuses. */
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
    /* Can these two ends be joined at all? Everything that makes a cable
       impossible is decided here, once, so the click and the automatic wiring
       can never disagree about what a link is. */
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
        //the same cable twice would make Delete ambiguous
        const alreadyThere=this.linkList.some(link=>
            link.inputNode===source
            &&link.outputNode===target
            &&Number(link.inputAnchor?.id)===sourceIndex
            &&Number(link.outputAnchor?.id)===targetIndex
        )
        if(alreadyThere){
            return false
        }
        //a flow resolves from its leaves: a loop would never finish
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
    /* THE way two nodes get connected.

       The click (anchor to anchor) and the wiring a brand new node does by
       itself both come through here, so a cable can only be born one way:
       checked, drawn, undoable, and followed by an arrangement that keeps it
       readable. `source` is the node that PRODUCES (it owns the output
       anchor), `target` the one that consumes. */
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
    /* A node that shows up where there is obviously room for it is wired in
       without asking: one dangling output in the whole flow and a free input
       here, and the same the other way round. Two dangling ends is ambiguity,
       and nothing is guessed - the user draws that one cable. The caller
       arranges the flow afterwards, so the newcomer lands in its column. */
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
    /* Grows the svg to the drawing. A node the layout pushed past the edge of
       the window is not lost: the container scrolls, and revealNode scrolls to
       the one the user just made. */
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
    /* ===================================================================
       LA SÉLECTION.

       Une seule règle gouverne tout: la sélection est un ensemble de nœuds
       que l'utilisateur a désignés, jamais un ensemble qu'on devine. Donc
       on ne touche PAS à la sélection quand un nœud disparaît tout seul —
       arrangeNodes, un resolve, un import: un graphe qui se réorganise ne doit
       pas décider de votre sélection. Seul un DELETE explicite la nettoie,
       parce qu'un nœud supprimé ne peut pas rester sélectionné.

       Les nœuds morts sont ÉLAGUÉS à la lecture, jamais sur un timer: un undo
       peut ramener un nœud entre deux clics, et un élagage programmé aurait
       déjà jeté la sélection. */
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
    /* THE ONE CLICK RULE, in one place, so it cannot be read two ways.

       additive=false (a plain click) leaves ONLY this node selected.
       additive=true  (ctrl/cmd) toggles this node and keeps the others.

       The plain click NARROWS rather than toggles, which is what makes
       deselection possible: with three nodes selected, a plain click on one of
       them leaves that one and drops the other two. There is always a way out,
       and it is the gesture people already have in their hand. */
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
            //the released node hands the "current" role to a remaining one, so
            //the panel never points at a node that is no longer selected
            if(this.lastSelected===node){
                this.lastSelected=[...this.selection].pop()??null
            }
        }else{
            this.selection.add(node)
            this.lastSelected=node
        }
        this.paintSelection()
    }
    /* Adds or removes a node with NO reference to the rest: `additive=false`
       clears the others, exactly as a plain click does. Kept as its own method
       because "toggle this one, whatever else" is a real thing to want (a
       pattern menu, a test), and having it spelled out stops the next reader
       from assuming it is the same gesture as a plain click. */
    toggleSelection(node){
        this.select(node,{additive:true})
    }
    /* EFFACE TOUT CE QUI EST SÉLECTIONNÉ, and it is ONE undo step.

       The alternative — letting each node's own suicide() record its own
       command — produces N commands for N nodes, so one Ctrl+Z brings back
       one of them and the user has to press it N times to undo one gesture.
       Every node's own suicide() stays exactly as it was: this walks the
       selection, and calls them one at a time, so all the bookkeeping each of
       them already does (links, replacements, the record flag) still happens.

       The order is irrelevant to the result and is left to the Set: the nodes
       do not know about each other. */
    deleteSelection(){
        const nodes=[...this.selectedNodes]
        if(nodes.length===0){
            return
        }
        const flow=this
        /* The whole batch as ONE command. Each suicide() below runs with
           `skipHistory`, so none of them pushes its own entry; this one stands
           for all of them. */
        if(!this.origin.history.replaying){
            this.origin.history.record(new Command({
                label:nodes.length===1
                    ?`Delete node ${nodes[0].title}`
                    :`Delete ${nodes.length} nodes`,
                undo:()=>{
                    const restored=nodes.map(node=>createNodeForHistory(node.origin,flow,nodeRestoreData(node)))
                    flow.selectOnly(restored[restored.length-1]??null)
                }
            }))
        }
        for(const node of nodes){
            //each node's own suicide removes its links and its stale entries
            node.suicide({skipHistory:true})
        }
        this.clearSelection()
    }
    /* The node the user is working on RIGHT NOW: the last one they clicked into
       the selection. Kept as its own field rather than inferred from the Set,
       because a Set has no order and "last" is the whole point. */
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
        //the current node goes with the set: leaving it pointing at nothing
        //would let a later action scroll to a panel nobody chose
        this.lastSelected=null
        this.paintSelection()
    }
    selectAll(){
        this.selection=new Set(this.nodeSet)
        //nothing was clicked, so there is no "last": the field itself is the
        //current thing, and a panel scroll would have nowhere to go
        this.lastSelected=null
        this.paintSelection()
    }
    /* L'apparence est la SEULE chose qui distingue un nœud sélectionné. On ne
       touche pas à `status` — un nœud en attente reste en attente, il n'est
       pas « résolu » parce qu'on l'a cliqué. La classe est retirée à la
       peinture ET à chaque lecture du statut, donc un nœud qui change de
       statut ne garde pas une Selected fantôme. */
    paintSelection(){
        for(const node of this.nodeSet){
            const rect=node.DOMelt?.querySelector("rect")
            if(!rect){
                continue
            }
            rect.classList.toggle("selected",this.selection.has(node))
        }
    }
    /* Les positions de tous les nœuds sélectionnés, indexées par nœud. C'est
       la photo AVANT un déplacement de groupe, celle que l'undo remit en
       place. Une Map et non un tableau: deux nœuds ne peuvent pas être au
       même endroit, alors qu'une liste les confondrait dès qu'on les relit. */
    selectionPositions(){
        const snapshot=new Map()
        for(const node of this.selectedNodes){
            snapshot.set(node,{...node.parameters.position,pinned:!!node.parameters.pinned})
        }
        return snapshot
    }
    /* Déplace TOUS les nœuds sélectionnés, et rien d'autre.

       Le même décalage est appliqué à chacun, donc le groupe garde sa forme
       exacte: c'est ce qui distingue un déplacement d'un réagencement, et
       c'est pourquoi on ne passe pas par layoutFlow ici. Les câbles sont
       redessinés UNE fois à la fin, pas une fois par nœud. */
    moveSelectionBy(dx,dy){
        for(const node of this.selectedNodes){
            node.parameters.position.x+=dx
            node.parameters.position.y+=dy
            node.SVGg.attr('transform',`translate(${node.parameters.position.x},${node.parameters.position.y})`)
        }
        this.updateLinks()
    }
    /* ===================================================================
       LE PATTERN: une sélection devient un patron RÉUTILISABLE.

       "Déplacer plusieurs nœuds" et "les sauvegarder comme un pattern" sont
       deux besoins distincts: on veut garder un enchaînement — « filtre +
       plot » — pour le remettre ailleurs, dans un autre fichier, pas seulement
       le déplacer.

       CE QUI EST COPIÉ, ET CE QUI NE L'EST PAS.
       Les nœuds sont copiés par nodeRestoreData, donc AVEC leur état (bornes
       de trim, pente du classifieur…), mais SANS leurs données dérivées. C'est
       la même règle que le squelette de session: un patron décrit une FORME,
       pas un résultat. Un patron qui embarquerait le spectre d'origine ferait
       exploser le fichier dès qu'il serait inséré plus d'une fois.

       LA GÉOMÉTRIE EST NORMALISÉE, ET C'EST CE QUI REND LE PATTERN PORTABLE.
       Un patron enregistré à (400, 250) et un autre à (10, 10) se
       chevaucheraient. On ramène donc le coin haut-gauche du groupe à
       l'origine, et c'est ce qui permet de le poser n'importe où.

       LES LIENS SONT RELATIFS, PAR LEUR INDEX D'ANCRE — jamais par l'objet.
       Un lien vers un nœud extérieur au patron est ABANDONNÉ: le patron serait
       incomplet, et un demi-câble produirait une connexion fantôme au moment
       de l'instanciation. */
    patternFromSelection(name="pattern"){
        const nodes=[...this.selectedNodes]
        if(nodes.length===0){
            return null
        }
        const inside=new Set(nodes)
        //the group's own top-left corner, which becomes the pattern's origin
        let minX=Infinity,minY=Infinity
        for(const node of nodes){
            minX=Math.min(minX,node.parameters.position.x)
            minY=Math.min(minY,node.parameters.position.y)
        }
        const links=[]
        for(const link of this.linkList){
            if(!inside.has(link.inputNode)||!inside.has(link.outputNode)){
                //half a cable: the far end is not part of the pattern
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
    /* Instancie un patron à `at`, et renvoie les nœuds créés.

       Les positions sont décalées par `at` et non posées en absolu: c'est
       l'appelant qui décide où le patron atterrit, ce qui est tout le sens
       d'un patron — une chose que l'on place, et non une chose qui choisit
       sa place. */
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
            /* Un nœud posé n'est PAS épinglé. Les épingles voyagent avec les
               nœuds placés à la main, mais un patron est une forme qu'on pose
               pour la première fois: l'épingler gèlerait le réagencement
               autour d'une position que l'utilisateur n'a pas choisie. */
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
        //the positions are the ones just computed, NOT the ones on screen: the
        //css transition is still running, so a measurement would scroll to
        //where the node used to be
        const width=node.parameters.width
        const height=node.nodeHeight
        if(x<this.container.scrollLeft){
            this.container.scrollLeft=x-LAYOUT_REVEAL_MARGIN
        }else if(x+width>this.container.scrollLeft+box.width){
            this.container.scrollLeft=x+width-box.width+LAYOUT_REVEAL_MARGIN
        }
        if(y<this.container.scrollTop){
            this.container.scrollTop=y-LAYOUT_REVEAL_MARGIN
        }else if(y+height>this.container.scrollTop+box.height){
            this.container.scrollTop=y+height-box.height+LAYOUT_REVEAL_MARGIN
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
            //the cable drawn while the mouse was down is only a PREVIEW: it is
            //thrown away and the real one is built by linkNodes, so the click
            //and the automatic wiring produce exactly the same cable
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
                //a deleted cable may have emptied a column: the arrangement is
                //what closes the hole it leaves
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
            //the status is NOT forwarded here: stopBuildingLink only records
            //where the cable was dropped. It is linkNodes, which decides
            //whether a cable is born at all, that marks the target as owing a
            //new resolve - a refused link must change nothing.
        }
    }
    updateLinks(){
        for(let k=0;k<this.linkList.length;k++){
            const link=this.linkList[k]
            if(!link.startingNode||!link.endingNode){
                //a cable that is still being drawn: it has one end, so there
                //is nothing to route and nothing to clean up. It is NOT a
                //dangling link - it is a cable in the making
                continue
            }
            if(this.nodeSet.has(link.startingNode) && this.nodeSet.has(link.endingNode)){
                const startingPos=Node.anchorAbsPos(link.startingAnchor)
                const endingPos=Node.anchorAbsPos(link.endingAnchor)
                //the handle follows the gap the arrangement left between the
                //two columns: a fixed handle on a short cable folds back on
                //itself, and a long one stays flat when the two ends are far
                //apart
                const stiffness=this.parameters.field.links.stiffness
                const handle=Math.max(
                    LAYOUT_MIN_LINK_HANDLE,
                    Math.min(stiffness,Math.abs(endingPos.x-startingPos.x)*0.5)
                )
                const bezierSide=link.startingNode.parameters.anchorMap.get(link.startingAnchor).type==="output"?handle:-handle
                link.attr("d", `M ${startingPos.x} ${startingPos.y}
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
    /* Re-resolves everything DOWNSTREAM of `node`, and nothing else.

       This is the only correct scope for "my output just changed": the flow
       must not be resolved from the leaves (that would redo unrelated branches
       and, for a source node, re-run work the user did not touch), and this
       node itself must NOT be re-resolved - its output is already published,
       and re-resolving it would overwrite a fresh result with a stale one.

       The descendants are resolved from their own LEAVES, because a node in the
       middle of the subtree may depend on a sibling further down: resolving the
       tips upward is what makes the shared resolutions Map do its job. */
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
        //the starting node is not re-resolved: its output is the new value
        resolutions.set(node,Promise.resolve())
        await Promise.all(subLeaves.map(leaf=>this.resolveNode(leaf,resolutions)))
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
                /* A click OUTSIDE closes the menu without going through
                   afterToggle, so the panel and the body class would stay as
                   they were: the top panel stretched, the graph clipped, for a
                   menu that is no longer open. Every path that closes a menu
                   must therefore undo what opening one did. */
                document.body.classList.remove("menu-open")
                this.afterToggle()
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
                            this.afterToggle()
                        }else{
                            for(const sibling of e.target.parentNode.children){
                                if(sibling!=e.target){
                                    closeSelfAndChildren(sibling)
                                }
                            }
                            e.target.classList.toggle('open')
                            this.afterToggle()
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
    /* Called every time a submenu opens or closes.

       WHY IT EXISTS. The flow menu lives in the top panel, which is a row of
       a CSS grid with a fixed height. A submenu is `position:absolute` (see
       .parent.open>.child), so it does not take part in the layout: it simply
       hangs BELOW its item and is clipped by whatever says `overflow:hidden`.
       With enough entries — which is exactly what "lots of nodes" produces —
       the list is taller than the panel, and the entries at the bottom are
       simply not there.

       The fix is not to make the panel enormous: it is to let the panel GROW
       to whatever the open menu needs, and to give it back when the menu
       closes. The panel keeps its own height for the graph underneath, and
       only the menu's own overflow is accommodated.

       Overridable, and a no-op by default: the top menu has all the room it
       needs, so only the flow menu — the one that grows with the number of
       node types — needs this. */
    afterToggle(){
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
                /* A HARD RESET, and the only destructive gesture in the app: the
                   skeleton, the durable copy and the panel geometry all go, and
                   they go together. Nothing partial about it, nothing that means
                   something different depending on what is on screen.

                   The pending autosave is cancelled first, or a timer still
                   waiting would put the pipeline straight back into the store a
                   moment after the purge and the reset would not stick. */
                origin.saveSessionSoon?.cancel()
                purgeAll()
                //replaces the current app with a fresh empty one
                origin.dispose()
                globalThis.Attributor=new App()
            },
            saveLocalSession(e){
                try{
                    const bytes=exportSkeleton(origin).length
                    origin.saveSession({localStorage:true})
                    origin.notice(
                        "Saved locally",
                        `${(bytes/1e6).toFixed(2)} MB kept in this browser: the graph, your `+
                        `settings and the text of your file. It is not on your disk, and `+
                        `"New session" deletes it - use "Export session" for anything you keep.`
                    )
                }catch(error){
                    //the budget is a browser limit, not a bug, and the way out
                    //does not involve losing the session
                    origin.notice("Not saved", error.message)
                }
            },
            openLocalSession(e){
                try{
                    origin.openLocalCopy()
                }catch(error){
                    origin.notice("Could not open the local copy",error.message)
                }
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
                arrangeFlow(e){
                    origin.channel.get("mainFlow")?.arrangeNodes()
                },
                selectAllNodes(e){
                    origin.channel.get("mainFlow")?.selectAll()
                },
                clearNodeSelection(e){
                    origin.channel.get("mainFlow")?.clearSelection()
                },
                /* The clipboard is the App's, not the Flow's: a pattern
                   outlives the flow it was cut from — that is the whole point
                   of saving one — so it cannot live on the Flow instance that
                   an import is about to replace. */
                copySelectionAsPattern(e){
                    const flow=origin.channel.get("mainFlow")
                    const pattern=flow?.patternFromSelection(e.detail.msg?.name)
                    if(!pattern){
                        origin.notice?.("Nothing to save","Select one or more nodes first.")
                        return
                    }
                    origin.patterns.set(pattern.name,pattern)
                    origin.savePreferencesSoon?.()
                    origin.notice?.(
                        "Pattern saved",
                        `"${pattern.name}" holds ${pattern.nodes.length} node(s). `+
                        "Paste it from the Flow menu, in this session or another one."
                    )
                },
                pastePattern(e){
                    const name=e.detail.msg?.name
                    const pattern=origin.patterns.get(name)
                    if(!pattern){
                        origin.notice?.("No such pattern",`"${name}" was never saved.`)
                        return
                    }
                    const flow=origin.channel.get("mainFlow")
                    const created=flow?.instantiatePattern(pattern,{
                        x:40,y:40
                    })??[]
                    if(created.length){
                        flow.selectOnly(created[0])
                        flow.revealNode(created[0])
                    }
                },
                deletePattern(e){
                    const name=e.detail.msg?.name
                    if(origin.patterns.delete(name)){
                        origin.savePreferencesSoon?.()
                    }
                },
                createNode(e){
                    const {title,type,source} = e.detail.msg
                    let node
                    switch (type) {
                        case "trimmer": {
                            node = new TrimmerNode(title, origin, origin.channel.get("mainFlow"), {x:180,y:10})
                            break
                        }
                        case "fkmd": {
                            node = new FKMDNode(title, origin, origin.channel.get("mainFlow"), {x:180,y:10})
                            break
                        }
                        case "chat": {
                            //self-shaped: a tool node, with no data to rebuild
                            node = new ChatNode(title, origin, origin.channel.get("mainFlow"), {x:180,y:10})
                            break
                        }
                        case "formulaCollection": {
                            //self-shaped: ONE multiplexed input, and any number
                            //of cables may land on it
                            node = new FormulaCollectionNode(
                                title,
                                origin,
                                origin.channel.get("mainFlow"),
                                {x:180,y:10}
                            )
                            break
                        }
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
                        //"peakPicking" and not two entries: the classifier and the
                        //anti-radio width filter are two stages of ONE decision, and
                        //making them two nodes made the user wire three cables to
                        //ask one question.
                        case "peakPicking":
                            node = new PeakPickingNode(
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
                    const flow=origin.channel.get("mainFlow")
                    //a node that lands where there is obviously room for it
                    //wires itself in. Those cables belong to the SAME command
                    //as the node: one undo removes the node and everything the
                    //app did to it on its own
                    flow?.linkNewNode(node)
                    //the arrangement runs whether the newcomer wired itself in
                    //or not: a node created at the default spot would otherwise
                    //land on top of whatever is already there
                    flow?.autoLayout()
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
                                //the cables are DECIDED AGAIN rather than
                                //replayed: the rule only depends on the shape
                                //of the flow, which the undo just put back
                                //exactly as it was - and a recorded cable would
                                //point at a node instance that no longer exists
                                flow?.linkNewNode(node)
                                flow?.autoLayout()
                                node.refreshFromLinks?.()
                                flow?.revealNode(node)
                            }
                        }))
                    }
                    flow?.revealNode(node)
                }
            }
        }
    }
    /* LET AN OPEN SUBMENU FLOAT OVER THE PAGE, WITHOUT MOVING ANYTHING.

       WHAT THIS USED TO DO, AND WHY IT WAS WRONG. The first version grew the
       top panel to the height of the open list and gave the room back on
       close. That was answering the wrong question: the panel is a fixed row
       of a grid, and resizing it pushes the ENTIRE workspace down — the graph,
       the side panels, everything below. A menu that rearranges the window when
       you open it is far more disruptive than one that overlaps it, and the
       overlap is what every other menu on every other platform already does.

       So the panel is left strictly alone, and only two things happen:

         - a `menu-open` class on the BODY, which stops #top and the workspace
           from clipping the dropdown (both are overflow:hidden, and an
           absolutely-positioned list hangs outside the panel's own box);
         - a scroll cap on the list itself, so a submenu with sixty entries
           scrolls instead of running off the bottom of the screen.

       NOTHING HERE MEASURES AND SETS A HEIGHT. That is the whole point, and
       it is why the method is now this short. */
    afterToggle(){
        const open=[...this.container.querySelectorAll(".parent.open")]
        /* On the BODY, not on the menu: #top — the panel that also clips — is
           an ANCESTOR of this menu, so a class set here could never relax it. */
        document.body.classList.toggle("menu-open",open.length>0)
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

//mouse zoom: the domain expansion per wheel notch is exp(deltaY Ã— this);
//0.002 â‰ˆ Â±20% for a classic 100px notch, smooth for trackpad deltas
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
//an axis may be dragged outside the graph zone on purpose: drawing it past
//the fit bounds is how you read a value the data does not reach
const AXIS_POSITION_LIMIT=3

class Plot2D{
    //every plot gets a unique SVG id: references such as url(#gradient) are
    //resolved document-wide, so two plots sharing one id would make the first
    //definition win for both
    static instanceCounter=0
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
        this.axisDrag=null
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
       Mouse zoom â€” the wheel rescales both domains around the data point
       under the cursor, computed in the space of each axis scale (identity
       for a linear axis, log10 for a logarithmic one) so the anchored
       point never moves on screen. Zooming out stops at the auto-fit
       bounds a double-click restores. autoDomain is switched off: drawGraph
       then keeps the manual domains, the SVG overlay, the WebGL camera
       (refreshCamera reads these very scales) and the widgets drawn on top
       (the classifier line â€¦) all follow through the regular redraw path.
      ----------------------------------------------------------------- */
    handleWheelZoom(event){
        //a plot can opt out of the wheel zoom (the trimmer frame is a fixed
        //histogram: zooming it would only shrink the bars out of reach)
        if(this.allowZoom===false) return
        //a plain horizontal scroll (deltaY 0) must not freeze autoDomain
        if(!event.deltaY) return
        //the plot owns the wheel gesture: no ancestor may scroll while zooming
        event.preventDefault()
        const zone=this.graphzone
        if(!(zone.width>0&&zone.height>0)) return
        //deltaMode: 0 pixels, 1 lines (Ã—16), 2 pages (Ã—plot height)
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
    //is clamped inside the fit bounds â€” it can slide within them but never
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
                    //a real id: SVG references (gradients, clip paths) are
                    //document-wide, so two plots must not answer to the same one
                    .attr("id",`plot2d-${++Plot2D.instanceCounter}`)
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
            const axisLength=Math.abs(range[1]-range[0])
            switch (this.parameters.axis[axis].type){
                case "left":
                    this.axesSVG[axis].call(
                        this.applyTickReadability(d3.axisLeft(scale),axis,scale,axisLength)
                    )
                    break
                case "right":
                    this.axesSVG[axis].call(
                        this.applyTickReadability(d3.axisRight(scale),axis,scale,axisLength)
                    )
                    break
                case "top":
                    this.axesSVG[axis].call(
                        this.applyTickReadability(d3.axisTop(scale),axis,scale,axisLength)
                    )
                    break
                case "bottom":
                    this.axesSVG[axis].call(
                        this.applyTickReadability(d3.axisBottom(scale),axis,scale,axisLength)
                    )
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
        //the axis groups exist only now: the drag behaviour is (re)bound here
        //so a freshly drawn axis is grabbable
        this.attachAxisDrag()
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

    /* -----------------------------------------------------------------
       Axis dragging â€” grab an axis and it MOVES: only its position (the
       SVG translate) changes, the data domain is left untouched, so the
       plot itself never shifts. A horizontal axis follows the vertical
       pointer, a vertical one the horizontal pointer. The pointer is NOT
       clamped to the zone: an axis is meant to be pulled outside to read a
       value the data does not reach.
       ---------------------------------------------------------------- */
    axisDragPointer(horizontal,event){
        //no clamp: leaving the graphzone is the whole point
        return horizontal?event.y:event.x
    }
    attachAxisDrag(){
        for(const key of Object.keys(this.parameters.axis)){
            if(!this.axisShown(key)) continue
            const group=this.axesSVG[key]
            if(!group||group.empty()) continue
            const axis=this.parameters.axis[key]
            const horizontal=axis.orientation==="horizontal"
            group.style("cursor",horizontal?"ns-resize":"ew-resize")
            group.call(d3.drag()
                .on("start",(event)=>{
                    //flush a pending wheel burst so it cannot fold into this
                    this.commitZoomGesture()
                    this.axisDrag={
                        key,
                        axis,
                        before:{left:axis.position.left,top:axis.position.top},
                        originPointer:this.axisDragPointer(horizontal,event),
                        originPosition:horizontal?axis.position.top:axis.position.left
                    }
                })
                .on("drag",(event)=>{
                    const drag=this.axisDrag
                    if(!drag) return
                    const zoneSize=horizontal?this.graphzone.height:this.graphzone.width
                    if(!(zoneSize>0)) return
                    const pointer=this.axisDragPointer(horizontal,event)
                    //position is a FRACTION of the zone, and it is deliberately
                    //allowed to leave [0,1] so the axis can be read past the fit
                    const raw=drag.originPosition+(pointer-drag.originPointer)/zoneSize
                    const next=Math.min(Math.max(raw,-AXIS_POSITION_LIMIT),AXIS_POSITION_LIMIT)
                    if(horizontal) drag.axis.position.top=next
                    else drag.axis.position.left=next
                    this.scheduleZoomDraw()
                })
                .on("end",()=>{
                    const drag=this.axisDrag
                    this.axisDrag=null
                    if(!drag) return
                    //the click ending this drag must not trigger the dblclick reset
                    this.lastPanEndAt=performance.now()
                    const after={left:drag.axis.position.left,top:drag.axis.position.top}
                    //a pure axis move is its own intention: it gets its own
                    //history entry instead of folding into the zoom command
                    if(drag.before.left===after.left&&drag.before.top===after.top) return
                    this.origin?.history?.record?.(new Command({
                        label:`Move ${drag.key} axis`,
                        undo:()=>{drag.axis.position={...drag.before};this.drawGraph()},
                        redo:()=>{drag.axis.position={...after};this.drawGraph()}
                    }))
                })
            )
        }
    }
    /* -----------------------------------------------------------------
       Tick readability. Two independent causes of unreadable axes:
        â€¢ too many ticks for the room available â†’ the count is derived from
          the ACTUAL pixel length of the axis (~1 tick per 80px);
        â€¢ labels too wide (12,345,678.9) â†’ SI shorthand, and a scientific
          form on log axes where the span is huge.
       Both are applied to the four axis orientations.
       ---------------------------------------------------------------- */
    axisTickConfig(axis,scale,rangePixels){
        const length=Math.abs(rangePixels)
        const count=Math.max(2,Math.floor(length/80))
        const log=this.parameters.axis[axis].scale==="log"
        const formatter=log
            ? (value => {
                if(!Number.isFinite(value)) return ""
                if(value===0) return "0"
                const magnitude=Math.abs(value)
                return (magnitude<1e-3||magnitude>=1e4)
                    ? value.toExponential(0)
                    : String(value)
            })
            : d3.format(".3~s")
        return {count,formatter}
    }
    applyTickReadability(generator,axis,scale,rangePixels){
        const {count,formatter}=this.axisTickConfig(axis,scale,rangePixels)
        return generator.ticks(count).tickFormat(formatter)
    }
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
    Plot2DWebGL â€” the "sandwich" plot
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
       Setup phase â€” bootstrap the Three.js subsystem ONCE
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
       CPU side of the data path: traces â†’ one descriptor per trace.
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
         â€¢ the axis transforms (log) and the reference origin are known;
         â€¢ the buffers are refilled as soon as the data, the styling, the
           scales OR the identity of the underlying array changed;
         â€¢ a one frame watch re-checks the sources so a producer that
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
           the SVG layer â€” options.layer = "gl" (default) | "svg" */
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
       update, one render â€” the GPU does the rest.
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
                    console.log(e.detail.emitter.title+" a reÃ§u le focus")
                },
                killed(e){console.log("quelqu'un s'est fait tuÃ© !\n","il s'appelait ",e.detail.emitter.events.registrationId)},
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
        this.DOMelt.folder.setAttribute("aria-label","Replier la fenÃªtre");
        this.DOMelt.label=CE('div',{className:"label",pilot:this,handleDblClick:(e)=>e.target.pilot.toggleMaximized(e)},[title.toString()]);
        this.DOMelt.label.handleMouseDown=(e)=>e.target.pilot.drag(e);
        this.DOMelt.label.handleClick=(e)=>this.focus(e)
        /* LE BOUTON JAUNE, entre le repli (vert) et la fermeture (rouge).

           Il ne range que LES FENÊTRES DU MÊME PANEAU. Deux fenêtres qui
           vivent dans deux conteneurs différents ne se disputent pas la même
           place, donc les quadriller ensemble les écraserait l'une sur
           l'autre. La destination est donc ce qui décide du groupe, et c'est
           pourquoi elle est comparée et non supposée. */
        this.DOMelt.tiler=CE('div',{className:"tiler",pilot:this},[]);
        this.DOMelt.tiler.handleClick=(e)=>{
            //the clic ne doit pas ALSOUMER la fenêtre qu'il vient de ranger:
            //sans ça, l'ordre des z passe devant la disposition
            e.stopPropagation()
            if(this.DOMelt.tiler.classList.contains("disabled")){
                return
            }
            e.target.pilot.gridSiblings()
        };
        this.DOMelt.tiler.setAttribute("role","button");
        this.DOMelt.tiler.setAttribute("aria-label","Ranger les fenêtres du panneau en grille");
        this.DOMelt.tiler.title="Disposer toutes les fenêtres de ce panneau en grille";
        /* UNE FENÊTRE HORS DU PANNEAU CENTRAL N'A PAS DE GRILLE.

           The tiler arranges the windows that SHARE this destination, and most
           destinations are not the central panel: the "About" box opens on
           `main`, and a graph opens on `midCentralContent`. Tiling the About
           box means tiling it against every other window of the whole
           application — which is not what the button promises and, since those
           windows live at wildly different sizes, looked like the button
           having a mind of its own.

           So the button is greyed and inert outside the central panel, rather
           than hidden: a control that vanishes between two panels is harder to
           learn than one that is visibly not applicable. The same `disabled`
           class the dismisser already uses for the non-closable graphs. */
        if(!destination?.classList?.contains("center")){
            this.DOMelt.tiler.classList.add("disabled")
            this.DOMelt.tiler.setAttribute("aria-disabled","true")
            this.DOMelt.tiler.title="Seul le panneau central peut être rangé en grille"
        }
        this.DOMelt.handler=CE('div',{},[this.DOMelt.label,this.DOMelt.folder,this.DOMelt.tiler,this.DOMelt.dismisser]);
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
            //label + repli + grille + fermer: quatre colonnes, pas trois. Une
            //colonne de trop et le titre mangerait la place des boutons.
            "grid-template-columns":"1fr 1em 1em 1em",
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
        stylize(this.DOMelt.tiler,{
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
        this.DOMelt.folder.setAttribute("aria-label",folded?"DÃ©plier la fenÃªtre":"Replier la fenÃªtre")
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
            this.DOMelt.folder.setAttribute("aria-label","Restaurer la fenÃªtre")
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
    /* RANGE LES FENÊTRES DU MÊME PANNEAU SUR UNE GRILLE.

       L'ordre de remplissage est celui demandé: la DROITE d'abord, puis le
       HAUT. Donc on remplit une rangée entière avant de descendre — c'est ce
       que fait le premier index, qui avance de 0 à columns-1 sur la première
       ligne avant de passer à la suivante.

       LA GRILLE EST LA PLUS PROCHE D'UN CARRÉ, ET C'EST LE BON CHOIX ICI.
       Deux fenêtres donnent 2×1, trois donnent 2×2, cinq donnent 3×2. On
       aurait pu faire 1×N ou N×1 selon le nombre, mais une fenêtre unique
       étirée sur toute la hauteur serait absurde, et trois fenêtres en
       colonne ne se compareraient pas. La racine carrée donne le rectangle le
       plus proche d'un carré qui contient tout le monde.

       AUCUNE FENÊTRE N'EST IGNORÉE, ET AUCUNE N'EST ÉCRASÉE: la dernière case
       d'une grille incomplète reste VIDE. C'est très différent d'étirer la
       dernière fenêtre sur deux cases pour meubler le vide — ce qui est
       exactement ce que ferait une division en pourcentage. */
    gridSiblings(){
        const destination=this.destination
        if(!destination){
            return
        }
        /* On ne range que les fenêtres RÉELLEMENT montées dans ce panneau, et
           dans l'ordre du DOM. Une fenêtre détruite reste dans le channel mais
           plus dans la page: la ranger produirait une case fantôme. */
        const siblings=[...destination.querySelectorAll(".popup.container")]
            .filter(window=>window.isConnected)
        if(siblings.length===0){
            return
        }
        const columns=Math.ceil(Math.sqrt(siblings.length))
        const rows=Math.ceil(siblings.length/columns)
        const width=100/columns
        const height=100/rows
        siblings.forEach((window,index)=>{
            const pilot=window.pilot
            if(!pilot){
                return
            }
            //gauche->droite PUIS haut->bas: l'index avance dans la rangée
            const column=index%columns
            const row=Math.floor(index/columns)
            /* Une fenêtre MAXIMISÉE occupe toute la page et n'occupe aucune
               case: on la sort donc du mode maximum avant de la poser, sinon
               `maximized` resterait vrai et le prochain classement repartirait
               d'une fenêtre 100%×100% posée sur une case. */
            if(pilot.maximized){
                pilot.toggleMaximized({preventDefault(){},stopPropagation(){}})
            }
            /* On écrit les quatre côtés, pas width/height en pourcentage
               SEULEMENT: une fenêtre déjà glissée a un `right` ou un `bottom`
               écrit, et un `left` sans `right` se retrouve étirée entre les
               deux. Les quatre ensemble, c'est une position. */
            const style=window.style
            style.left=`${column*width}%`
            style.top=`${row*height}%`
            style.width=`${width}%`
            style.height=`${height}%`
            style.right="auto"
            style.bottom="auto"
        })
        /* La fenêtre sur laquelle on a cliqué passe devant: elle est la plus
           récente, c'est donc elle qu'on veut voir. */
        this.focus()
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
        this.announce()
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
        this.announce()
    }
    /* Folding a widget is not an undoable act, so it records no command and
       never reaches the history - which means the autosave, which listens to the
       history, would never hear about it. Left unsaid, the skeleton keeps the
       fold state from the last structural change and a reload quietly unfolds
       every panel the user had put away. */
    announce(){
        this.origin?.saveSessionSoon?.()
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
    /* The periodic table belongs to the App, and the App LOADS it itself.

       `table` is an optional injection point: pass a table to test with a
       fixture, or to run two Apps against different masses (NIST, AME,
       enriched isotopes). Left out, the App fetches data/elements.json once
       and owns the result.

       The load is NOT awaited by the constructor: the interface must be usable
       the instant it appears. So this.table is null for a few hundred
       milliseconds and tableReady is the promise that settles it. Any node
       that needs the table AWAITS tableReady - it never reads this.table
       without awaiting, or it would report "no table" for a table merely still
       in flight. A load failure resolves tableReady to null and says so once,
       instead of leaving a promise that rejects into nowhere.

       WHY HERE, and not in main.js: main.js starts the program, it does not
       know what a session is made of. Making IT fetch the table meant writing
       down, in the bootstrap, a list of what the App needs - the first line of
       a second source of truth that would grow with every feature. Inside the
       App the list stays implicit: whatever a node asks the origin for, the
       origin is the one that provides it.

       This is a deliberate PRAGMATIC choice, not the ideal architecture. Two
       things are knowingly left rough, and both are one refactor away:
         - the table is loaded even for a session that never parses a formula.
           Making it lazy (a getter that fetches on first access) would remove
           the 72 Ko from a pure-data session; it costs an await in every
           consumer, which is why it is not done yet.
         - every App fetches its own copy, so "New session" re-downloads the
           file. Sharing one instance per window would fix it, at the price of
           a module-level cache - the very global this was moved away from. */
    constructor({table=null,tableUrl="../data/elements.json"}={}){
        this.table=table
        this.tableError=null
        this.tableReady=table
            ?Promise.resolve(table)
            :loadTable(tableUrl).then(
                loaded=>{this.table=loaded; return loaded},
                err=>{
                    this.tableError=err.message??String(err)
                    console.error("[App] le tableau pÃ©riodique n'a pas pu Ãªtre chargÃ©:",err)
                    return null
                }
            )
        this.channel=new Channel(this)
        this.history=new History()
        /* THE PATTERNS, and they are on the App on purpose.

           A pattern is a shape the user cut out of a flow and expects to
           paste LATER — possibly after the session that produced it has been
           closed. So it cannot belong to the Flow (an import replaces that
           instance) nor to a node (a deleted node would take it down). The App
           is the only thing that outlives both.

           A Map, not an array: patterns are pasted by name, and a list would
           make every paste a scan for a string the user typed. */
        this.patterns=new Map()
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
        this.setupSessionStore()
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
        //kept on the instance: the autosave registers its own resize listeners
        //through it, and a second copy of this walker is a second thing to keep
        //in step with the first
        this.observeResizeHandlers=observeResizeHandlers
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
            /* The SKELETON, not the full session, and the difference is not a
               detail. A full session carries the file text AND the parsed pairs
               AND the resolved outputs, and measures about three times as much:
               5000 points of a real spectrum is already 4 MB complete, which is
               the entire browser budget for the whole site. The skeleton keeps
               the text, and the resolve rebuilds the rest - so a durable copy of
               the same spectrum is 0.14 MB and a handful of them fit.

               The full session is what goes to a FILE, where there is no budget
               and being able to reopen without re-running a kernel is worth it. */
            saveLocalSession(exportSkeleton(this))
        }
        return json
    }
    /* The durable copy comes back the way a reload does: as a skeleton, through
       the same two steps, with the same guarantees. One code path means one set
       of bugs, and the alternative - a second restore for the local copy - is a
       second thing to keep in step with the first. */
    openLocalCopy(){
        const document=parseSkeleton(readLocalSession())
        if(!document){
            throw new Error(
                "There is no local copy to open. \"Save (local)\" in the File menu makes one."
            )
        }
        this.dispose()
        let restored=null
        try{
            restored=restoreSession(document)
        }catch(error){
            //the skeleton is dropped rather than kept: one this build cannot read
            //would fail again on every opening, with no way past it
            console.error("[App] the local copy could not be opened:",error)
            clearLocalSession()
        }
        if(!restored){
            //never leave the user with nothing: an empty app beats no app
            globalThis.Attributor=new App()
            return globalThis.Attributor
        }
        globalThis.Attributor=restored
        restored.applyPanelParameters()
        restored.resolveAfterRestore()
        return restored
    }
    /* The one way this app talks instead of writing to the console.

       It exists because the two failures that matter - a storage budget
       exceeded, a local copy that cannot be read - are both invisible from the
       outside: the app keeps working perfectly, and the user only finds out
       later that nothing was saved. A Dialog is what this codebase already has
       for saying something, so it is what this uses. */
    notice(title,text){
        const dialog=new Dialog(title,this,this.main)
        stylize(dialog.DOMelt.window,{
            width:"420px",
            top:"35%",
            left:"35%"
        })
        dialog.DOMelt.content.appendChild(
            CE("div",{style:{padding:"10px",lineHeight:"1.5"}},[text])
        )
        return dialog
    }
    /* THE AUTOSAVE, and the two places it listens from.

       It hangs off historyChanged rather than off the nodes: every command
       already goes through History, so this one event catches a move, a node
       created or deleted, a link, a trim, an arrangement - everything - without
       a single node having to remember to announce itself. A node dragged by
       hand is not a command (it becomes one on mouseup), which is why the drag
       records its own history entry rather than relying on this. */
    setupSessionStore(){
        //read FIRST: a stored panel size is only worth restoring onto a panel
        //that is about to exist
        this.applyStoredPreferences()
        //one debounced writer for the whole app. 400 ms is long enough to
        //coalesce a drag into a single write, and short enough that closing the
        //tab right after an edit still keeps it
        this.saveSessionSoon=debounce(()=>{
            writeSession(this)
        },{name:"the session"})
        globalThis.addEventListener("historyChanged",this.saveSessionSoon)
        /* Not everything the skeleton remembers is an undoable act: folding a
           widget, dragging a ruler, a checkbox. None of those record a command,
           so the writes above would only ever catch up at the NEXT structural
           change - and anything done in the last moment before the tab closes
           would be lost outright. One forced write on the way out is what makes
           "nothing is lost" true instead of nearly true. */
        this.flushOnPageHide=()=>{
            this.saveSessionSoon?.flush()
        }
        globalThis.addEventListener("pagehide",this.flushOnPageHide)
        //the panel geometry is NOT in the history stack: a resize is not an
        //undoable act, so the septa announce themselves instead
        this.savePreferencesSoon=debounce(()=>{
            savePreferences(this)
        },{name:"the panel layout"})
        for(const septum of [this.topSeptum,this.botSeptum]){
            septum.handleResize=()=>this.savePreferencesSoon()
            this.observeResizeHandlers?.(septum,this.resizeObserver)
        }
    }
    applyStoredPreferences(){
        const stored=readPreferences()
        if(!stored){
            return
        }
        for(const key of ["topContent","botContent","leftContent","rightContent"]){
            const value=stored[key]
            //a stored value is merged, never replaced: a build that added a
            //panel must not lose the key it does not know about
            if(this.parameters[key]&&value&&typeof value==="object"){
                Object.assign(this.parameters[key],value)
            }
        }
        //the file's layout wins over this: App.importSession calls
        //applyPanelParameters() after, on the session it just read
        this.applyPanelParameters()
    }
    /* The reload gesture. A skeleton carries no data - the pairs, the inputs and
       the outputs were all left out on purpose - so restoring the shape is only
       half the job. The graph is already painted by the time this runs, and the
       resolve happens behind it: that is what turns "the same picture, empty"
       into "the same picture, back". */
    resolveAfterRestore(){
        const flow=this.channel.get("mainFlow")
        if(!flow?.nodeSet?.size){
            return Promise.resolve()
        }
        return flow.resolveFlow()
            .then(()=>{
                //the statuses just settled: save them, so a second reload
                //restores a graph that says "resolved" and not one that says
                //"floating" on every node
                this.saveSessionSoon?.()
            })
            .catch(error=>{
                //a kernel that fails marks its own node and does not reject the
                //chain, so reaching here means something else went wrong: the
                //graph is on screen and usable, which is what matters
                console.error("[App] the restored flow did not resolve cleanly:",error)
            })
    }
    dispose(){
        //idempotent teardown of the whole app (used before replacing it with an
        //imported session): stops the observers, the menus and the channel
        if(this.disposed){
            return
        }
        this.disposed=true
        //the autosave must not outlive the app it describes: a pending write
        //would put an app back that is no longer on screen, and a pagehide
        //listener left attached would keep writing a session the user deleted
        this.saveSessionSoon?.cancel()
        globalThis.removeEventListener("historyChanged",this.saveSessionSoon)
        globalThis.removeEventListener("pagehide",this.flushOnPageHide)
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
            json=readLocalSession()
            if(!json){
                throw new Error("There is no local copy to open. \"Save (local)\" makes one.")
            }
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
            createNode:({data,app,flow})=>buildNode(data,app,flow),
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
        /* Where the work goes, stated where somebody goes looking for it.

           The honest version is three sentences, not a paragraph: nothing leaves
           the machine, a durable copy can be deleted with one button, and a large
           spectrum may be refused by the browser's budget. Anything longer stops
           being read. */
        this.notice(
            "Where your data goes",
            "Your work is kept in this browser only. Nothing is sent to a server, and no one else can read it. "+
            "\"New session\" deletes all of it: the current session, the local copy, and the window layout. "+
            "Use \"Export session\" for anything you want to keep on disk."
        )
    }
}

/* Restores a skeleton and hands back the App, or null when there is nothing to
   restore. The node types stay HERE, where the classes are: a boot file that had
   to import fourteen node classes to name them would be a second list of node
   types, and two lists drift. */
function restoreSession(document){
    let created=null
    const options=importOptions(document,{
        createApp:()=>{
            created=new App()
            return created
        },
        buildNode
    })
    if(!options){
        return null
    }
    try{
        return importSessionData(JSON.stringify(document),options)
    }catch(error){
        /* The import builds a WHOLE app before anything can fail: it draws its
           menus, its field and its panels. Falling back without taking that one
           down first is what leaves two .app#main in the body, the second one
           sitting on top of the first. */
        created?.dispose()
        throw error
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

                if (impact < 0) { // Ã©viter de "recoller" les particules dÃ©jÃ  en fuite
                    const impulse = 2 * impact / 2; // masses Ã©gales
                    a.vx += impulse * nx;
                    a.vy += impulse * ny;
                    b.vx -= impulse * nx;
                    b.vy -= impulse * ny;
                }
            }
        }

        const animate = () => {
            // Mise Ã  jour des positions
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

            // Mise Ã  jour de l'affichage
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
            // Mise Ã  jour des positions
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
                            r: this.r * Math.sqrt(totalMass) // rayon âˆ âˆšmasse
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

            // Mise Ã  jour SVG
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



export {App, restoreSession, Plot2D, Plot2DWebGL, PeakPickingNode, TrimmerNode, FKMDNode}
