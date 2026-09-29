/* -------------------------------------------------------------------------
    layout.js — where the nodes of a flow go, and which two of them should be
    wired together next.

    Pure functions over plain descriptors: no DOM, no d3, no history. A layout
    that can only be checked by looking at a canvas is a layout nobody can fix,
    so everything here is written to be called from a test (layout.test.mjs) as
    well as from the Flow.

    THE VOCABULARY IS BACKWARDS IN THE DOM, and that is worth writing down once:
      - the node that PRODUCES a value owns an OUTPUT anchor, and a Link stores
        it as link.inputNode;
      - the node that CONSUMES it owns an INPUT anchor, and a Link stores it as
        link.outputNode.
    Everything below therefore says "source" (produces, drawn on the LEFT) and
    "target" (consumes, drawn on the RIGHT), and never the DOM names.

    A node descriptor is {id, width, height, inputCount, outputCount, x, y,
    pinned}: `id` is anything (the Flow passes the Node object itself), x/y are
    the CURRENT top-left corner, and `pinned` means "the user put this one
    there by hand, leave it alone".
    A link descriptor is {source, target, sourcePort, targetPort}.
   ------------------------------------------------------------------------- */

export const LAYOUT_DEFAULTS={
    margin:20,        // kept empty around the drawing, so nothing hugs the border
    //wider than the bezier handle used to draw a link (field.links.stiffness):
    //a narrower column would make every curve fold back on itself
    columnGap:80,
    rowGap:14,        // vertical gap between two nodes of the same column
    sweeps:8,         // barycenter passes used to reduce link crossings
    obstacleGap:12    // clearance kept around a PINNED node
}

const number=(value,fallback=0)=>Number.isFinite(value)?value:fallback

/* --- the graph, described once ---------------------------------------- */

export function buildGraph({nodes=[],links=[]}={}){
    const byId=new Map()
    for(const node of nodes??[]){
        byId.set(node.id,node)
    }
    const outgoing=new Map()//source -> Map(target -> link)
    const incoming=new Map()//target -> Map(source -> link)
    for(const id of byId.keys()){
        outgoing.set(id,new Map())
        incoming.set(id,new Map())
    }
    for(const link of links??[]){
        const source=link?.source
        const target=link?.target
        if(!byId.has(source)||!byId.has(target)||source===target){
            continue
        }
        if(outgoing.get(source).has(target)){
            //a flow is a pipeline: two cables between the same two nodes are
            //the same cable, and counting them twice would count crossings
            //that nobody can see
            continue
        }
        const edge={
            source,
            target,
            sourcePort:number(link.sourcePort),
            targetPort:number(link.targetPort)
        }
        outgoing.get(source).set(target,edge)
        incoming.get(target).set(source,edge)
    }
    return {byId,outgoing,incoming,order:[...byId.keys()]}
}

export function parentsOf(graph,id){
    return graph.incoming.has(id)?[...graph.incoming.get(id).keys()]:[]
}

export function childrenOf(graph,id){
    return graph.outgoing.has(id)?[...graph.outgoing.get(id).keys()]:[]
}

export function usedPorts(graph,id){
    const outputs=new Set()
    const inputs=new Set()
    for(const edge of graph.outgoing.get(id)?.values()??[]){
        outputs.add(edge.sourcePort)
    }
    for(const edge of graph.incoming.get(id)?.values()??[]){
        inputs.add(edge.targetPort)
    }
    return {inputs,outputs}
}

/* The port numbers of a node that no cable is using, in order. An EMPTY array
   is information: a node with no free input is not waiting for anything. */
export function freePorts(graph,id,kind){
    const node=graph.byId.get(id)
    if(!node){
        return []
    }
    const count=number(kind==="input"?node.inputCount:node.outputCount)
    const used=usedPorts(graph,id)[kind==="input"?"inputs":"outputs"]
    const free=[]
    for(let port=0;port<count;port++){
        if(!used.has(port)){
            free.push(port)
        }
    }
    return free
}

/* Can `from` reach `to` by following the cables? Used to refuse a link that
   would close a loop: a flow resolves from its leaves, and a cycle would
   resolve forever. `extra` are the links already accepted in this same round
   (a node being wired in can get a cable on each side). */
export function reaches(graph,from,to,extra=[]){
    if(from===to){
        return true
    }
    const seen=new Set([from])
    const stack=[from]
    const step=(id)=>{
        const children=new Set(childrenOf(graph,id))
        for(const edge of extra){
            if(edge.source===id){
                children.add(edge.target)
            }
        }
        return children
    }
    while(stack.length){
        const current=stack.pop()
        for(const child of step(current)){
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

/* --- layers: a node sits one column right of its deepest parent -------- */

export function assignLayers(graph){
    const layer=new Map()
    let pending=graph.order
    while(pending.length){
        const deferred=[]
        for(const id of pending){
            const parents=parentsOf(graph,id)
            if(parents.every(parent=>layer.has(parent))){
                layer.set(id,parents.length?Math.max(...parents.map(p=>layer.get(p)))+1:0)
            }else{
                deferred.push(id)
            }
        }
        if(deferred.length===pending.length){
            //every node left is waiting for another one: the flow has a loop.
            //The cable that closes it is cut here, so each node lands one
            //column right of the parents it does have - and the loop is drawn
            //as a cable that goes back to the left, which is what a loop looks
            //like anyway.
            for(const id of deferred){
                const placed=parentsOf(graph,id).filter(parent=>layer.has(parent))
                layer.set(id,placed.length?Math.max(...placed.map(p=>layer.get(p)))+1:0)
            }
            break
        }
        pending=deferred
    }
    for(const id of graph.order){
        if(!layer.has(id)){
            layer.set(id,0)
        }
    }
    return layer
}

/* --- order inside a column: the fewer crossed cables, the better -------- */

function initialOrder(graph,layer,depth){
    const layers=Array.from({length:depth},()=>[])
    const seen=new Set()
    const walk=(start)=>{
        const stack=[start]
        while(stack.length){
            const id=stack.pop()
            if(seen.has(id)){
                continue
            }
            seen.add(id)
            layers[layer.get(id)].push(id)
            const children=childrenOf(graph,id)
            for(let k=children.length-1;k>=0;k--){
                stack.push(children[k])
            }
        }
    }
    for(const id of graph.order){
        if(!parentsOf(graph,id).length){
            walk(id)
        }
    }
    for(const id of graph.order){
        walk(id)
    }
    return layers
}

export function orderLayers(graph,layer,{sweeps=LAYOUT_DEFAULTS.sweeps}={}){
    const depth=Math.max(0,...layer.values())+1
    const layers=initialOrder(graph,layer,depth)
    let best=layers.map(ids=>ids.slice())
    let bestCrossings=countCrossings(graph,layers)
    for(let sweep=0;sweep<sweeps;sweep++){
        const down=sweep%2===0
        //one sweep fixes the columns against the previous ones, the next sweep
        //fixes those against the ones after: alternating is what lets a chain
        //of forks settle instead of oscillating
        const columns=down
            ?layers.map((_,k)=>k)
            :layers.map((_,k)=>depth-1-k)
        for(const k of columns){
            const reference=down?k-1:k+1
            if(reference<0||reference>=depth){
                continue
            }
            const ranks=new Map(layers[reference].map((id,i)=>[id,i]))
            const decorated=layers[k].map((id,i)=>{
                const neighbours=down?parentsOf(graph,id):childrenOf(graph,id)
                const values=neighbours.map(n=>ranks.get(n)).filter(v=>v!==undefined)
                //no neighbour in that column: keep the place it already had, so
                //a disconnected island does not jump to the top
                const barycenter=values.length
                    ?values.reduce((a,b)=>a+b,0)/values.length
                    :i
                return {id,barycenter,rank:i}
            })
            decorated.sort((a,b)=>a.barycenter-b.barycenter||a.rank-b.rank)
            layers[k]=decorated.map(entry=>entry.id)
        }
        const crossings=countCrossings(graph,layers)
        if(crossings<bestCrossings){
            bestCrossings=crossings
            best=layers.map(ids=>ids.slice())
        }
    }
    return best
}

/* How many pairs of cables swap sides between two neighbouring columns. This
   is the number the ordering above is trying to bring down. */
export function countCrossings(graph,layers){
    const ranks=new Map()
    layers.forEach((ids,depth)=>ids.forEach((id,order)=>ranks.set(id,{depth,order})))
    const pairs=new Map()
    for(const targets of graph.outgoing.values()){
        for(const edge of targets.values()){
            const from=ranks.get(edge.source)
            const to=ranks.get(edge.target)
            if(!from||!to||to.depth!==from.depth+1){
                //only links between NEIGHBOUR columns can cross: a link that
                //skips a column goes over it, nothing to count
                continue
            }
            const key=`${from.depth}>${to.depth}`
            if(!pairs.has(key)){
                pairs.set(key,[])
            }
            pairs.get(key).push([from.order,to.order])
        }
    }
    let crossings=0
    for(const list of pairs.values()){
        for(let i=0;i<list.length;i++){
            for(let k=i+1;k<list.length;k++){
                if((list[i][0]-list[k][0])*(list[i][1]-list[k][1])<0){
                    crossings++
                }
            }
        }
    }
    return crossings
}

/* --- coordinates: the smallest drawing that has no overlap ------------- */

export function rectsOverlap(a,b,gap=0){
    return a.x<b.x+b.width+gap
        && b.x<a.x+a.width+gap
        && a.y<b.y+b.height+gap
        && b.y<a.y+a.height+gap
}

function nodeRect(graph,positions,id){
    const node=graph.byId.get(id)
    const topLeft=positions.get(id)
    return {
        id,
        x:number(topLeft?.x),
        y:number(topLeft?.y),
        width:number(node?.width),
        height:number(node?.height)
    }
}

/* A rectangle centred on a y, used while a column is still being packed. */
function columnRect(graph,id,centreY){
    const node=graph.byId.get(id)
    return {
        id,
        x:0,
        y:centreY-number(node?.height)/2,
        width:number(node?.width),
        height:number(node?.height)
    }
}

/* One column: start from what the parents asked for (their middle, averaged),
   then push the nodes apart just enough, then pull the whole column back
   toward what was asked. The pull uses the MEDIAN of the shifts, not the mean:
   one distant parent must not drag the entire column with it. */
function placeColumn({ids,graph,layer,positions,previous,rowGap,obstacleGap}){
    const halves=ids.map(id=>number(graph.byId.get(id).height)/2)
    const fixed=ids.map(id=>!!graph.byId.get(id).pinned)
    const ideal=ids.map((id,i)=>{
        const node=graph.byId.get(id)
        if(fixed[i]){
            return number(node.y)+halves[i]
        }
        const parents=parentsOf(graph,id)
            .filter(parent=>layer.get(parent)<layer.get(id)&&positions.has(parent))
        if(parents.length){
            //the middle of the parents, not their corner: a column placed on
            //corners would hang one node-height too high for every parent
            const middle=parents.reduce(
                (sum,parent)=>sum+positions.get(parent).y+number(graph.byId.get(parent).height)/2,
                0
            )
            return middle/parents.length
        }
        //an island: stack it under whatever is already in the column, so the
        //column stays compact instead of piling everything on the margin
        return previous&&i>0
            ?previous[i-1]+halves[i-1]+rowGap+halves[i]
            :LAYOUT_DEFAULTS.margin+halves[i]
    })
    const centres=ideal.slice()
    const separate=(from,to,step)=>{
        let cursor=null
        for(let i=from;i!==to;i+=step){
            if(fixed[i]){
                //a pinned node is a wall: the column flows around it
                cursor=centres[i]
                continue
            }
            if(cursor!==null){
                const neighbour=i-step
                const floor=cursor+step*(halves[neighbour]+rowGap+halves[i])
                if(step>0?centres[i]<floor:centres[i]>floor){
                    centres[i]=floor
                }
            }
            cursor=centres[i]
        }
    }
    separate(0,ids.length,1)
    const shifts=ids.map((id,i)=>ideal[i]-centres[i]).sort((a,b)=>a-b)
    const shift=shifts.length?shifts[Math.floor(shifts.length/2)]:0
    if(shift){
        for(let i=0;i<ids.length;i++){
            if(!fixed[i]){
                centres[i]+=shift
            }
        }
        separate(0,ids.length,1)
    }
    //a node that would land on a pinned one of the SAME column slides below it,
    //and below THAT one if need be
    for(let i=0;i<ids.length;i++){
        if(fixed[i]){
            continue
        }
        for(let attempt=0;attempt<ids.length+1;attempt++){
            const hit=ids.findIndex((other,k)=>k!==i&&fixed[k]&&rectsOverlap(
                columnRect(graph,ids[i],centres[i]),
                columnRect(graph,other,centres[k]),
                obstacleGap
            ))
            if(hit<0){
                break
            }
            centres[i]=centres[hit]+halves[hit]+obstacleGap+halves[i]
        }
    }
    return centres.map((centre,i)=>centre-halves[i])
}

/* Everything the Flow needs in one call: where each node goes, how the
   columns were ordered, and how big the drawing has to be to show all of it. */
export function layoutFlow({nodes=[],links=[],options={}}={}){
    const settings={...LAYOUT_DEFAULTS,...options}
    const graph=buildGraph({nodes,links})
    const layer=assignLayers(graph)
    const layers=orderLayers(graph,layer,{sweeps:settings.sweeps})
    const positions=new Map()
    let columnX=settings.margin
    let previous=null
    for(const ids of layers){
        const width=ids.reduce((widest,id)=>Math.max(widest,number(graph.byId.get(id).width)),0)
        const tops=placeColumn({
            ids,
            graph,
            layer,
            positions,
            previous,
            rowGap:settings.rowGap,
            obstacleGap:settings.obstacleGap
        })
        ids.forEach((id,i)=>{
            const node=graph.byId.get(id)
            positions.set(id,{
                x:node.pinned?number(node.x):columnX,
                y:tops[i]
            })
        })
        previous=tops.map((top,i)=>top+number(graph.byId.get(ids[i]).height)/2)
        columnX+=width+settings.columnGap
    }
    //a pinned node of ANOTHER column can still sit under a free one: this last
    //sweep is against the whole drawing, whatever column the wall belongs to
    for(const id of graph.order){
        if(graph.byId.get(id).pinned){
            continue
        }
        const rect=nodeRect(graph,positions,id)
        for(let attempt=0;attempt<graph.order.length+1;attempt++){
            const hit=graph.order
                .find(other=>other!==id&&graph.byId.get(other).pinned
                    &&rectsOverlap(rect,nodeRect(graph,positions,other),settings.obstacleGap))
            if(hit===undefined){
                break
            }
            const blocker=nodeRect(graph,positions,hit)
            rect.y=blocker.y+blocker.height+settings.obstacleGap
            positions.get(id).y=rect.y
        }
    }
    if(!graph.order.length){
        return {positions,layers,layer,graph,hasPins:false,crossings:0,bounds:{width:0,height:0}}
    }
    let minX=Infinity
    let minY=Infinity
    let maxX=-Infinity
    let maxY=-Infinity
    for(const id of graph.order){
        const rect=nodeRect(graph,positions,id)
        minX=Math.min(minX,rect.x)
        minY=Math.min(minY,rect.y)
        maxX=Math.max(maxX,rect.x+rect.width)
        maxY=Math.max(maxY,rect.y+rect.height)
    }
    //the drawing never starts left of or above the origin: a node the user
    //dragged out of the field would otherwise be invisible with no way to
    //scroll back to it. Everybody moves, pins included - a pin says where the
    //user would LIKE the node, and off-screen is nowhere.
    const shiftX=minX<0?-minX:0
    const shiftY=minY<0?-minY:0
    if(shiftX||shiftY){
        for(const id of graph.order){
            const position=positions.get(id)
            position.x+=shiftX
            position.y+=shiftY
        }
        minX+=shiftX
        minY+=shiftY
        maxX+=shiftX
        maxY+=shiftY
    }
    return {
        positions,
        layers,
        layer,
        graph,
        hasPins:graph.order.some(id=>graph.byId.get(id).pinned),
        crossings:countCrossings(graph,layers),
        bounds:{
            width:maxX+settings.margin,
            height:maxY+settings.margin
        }
    }
}

/* --- "wire the newcomer in by itself" ---------------------------------- */

/* A node that shows up where there is obviously room for it is connected
   without asking: ONE dangling output in the whole flow plus a free input
   here, and the same the other way round - which is what drops a node in the
   middle of a chain. Two dangling ends is ambiguity, and an ambiguity resolved
   by guessing is worse than no guess at all: the user moves one cable. */
export function autoLinkPlan(graph,newNodeId){
    const plan=[]
    if(!graph.byId.has(newNodeId)){
        return plan
    }
    const danglingOutputs=[]
    const danglingInputs=[]
    for(const id of graph.order){
        if(id===newNodeId){
            continue
        }
        for(const port of freePorts(graph,id,"output")){
            danglingOutputs.push({node:id,port})
        }
        for(const port of freePorts(graph,id,"input")){
            danglingInputs.push({node:id,port})
        }
    }
    const freeInputs=freePorts(graph,newNodeId,"input")
    const freeOutputs=freePorts(graph,newNodeId,"output")
    const candidates=[]
    if(danglingOutputs.length===1&&freeInputs.length){
        candidates.push({
            source:danglingOutputs[0].node,
            sourcePort:danglingOutputs[0].port,
            target:newNodeId,
            targetPort:freeInputs[0]
        })
    }
    if(danglingInputs.length===1&&freeOutputs.length){
        candidates.push({
            source:newNodeId,
            sourcePort:freeOutputs[0],
            target:danglingInputs[0].node,
            targetPort:danglingInputs[0].port
        })
    }
    /* A candidate that would close a loop is dropped: the flow would never
       finish resolving, and the user can always draw that cable by hand. The
       two candidates are checked AGAINST EACH OTHER as they are accepted -
       the newcomer is exactly the node that can be dropped in the middle of a
       chain, so s -> newcomer -> t on top of an existing t -> s is a loop
       that neither candidate shows on its own. */
    const accepted=[]
    for(const proposal of candidates){
        if(!reaches(graph,proposal.target,proposal.source,accepted)){
            accepted.push(proposal)
        }
    }
    return accepted
}
