/* -------------------------------------------------------------------------
    Test — node scripts/layout.js

    The layout is the part nobody can check by looking: a drawing can be
    readable and still have a cable running through a node. So what is tested
    here are the PROPERTIES the Flow relies on, never a set of coordinates:
    no two nodes overlap, a node is always right of its parents, a pinned node
    stays where the user put it, and a newcomer is only wired in when the
    answer is unique.
   ------------------------------------------------------------------------- */
import {
    LAYOUT_DEFAULTS,
    autoLinkPlan,
    buildGraph,
    countCrossings,
    freePorts,
    layoutFlow,
    rectsOverlap
} from "./layout.js"

let passed=0
const failures=[]
const test=(name,fn)=>{
    try{ fn(); passed++; console.log(`  ok   ${name}`) }
    catch(e){ failures.push(name); console.log(`  FAIL ${name}\n       ${e.message}`) }
}
const eq=(a,b,msg)=>{ if(a!==b) throw new Error(`${msg??`${a} != ${b}`}`) }
const ok=(value,msg)=>{ if(!value) throw new Error(msg??"expected a truthy value") }

let counter=0
const node=(over={})=>{
    counter++
    return {
        id:`n${counter}`,
        width:150,
        height:34,
        inputCount:1,
        outputCount:1,
        x:0,
        y:0,
        ...over
    }
}
const link=(source,target,over={})=>({source:source.id,target:target.id,sourcePort:0,targetPort:0,...over})

const rectsOf=(nodes,result)=>nodes.map(n=>({
    id:n.id,
    x:result.positions.get(n.id).x,
    y:result.positions.get(n.id).y,
    width:n.width,
    height:n.height
}))
const overlapsOf=(nodes,result)=>{
    const rects=rectsOf(nodes,result)
    const found=[]
    for(let i=0;i<rects.length;i++){
        for(let k=i+1;k<rects.length;k++){
            if(rectsOverlap(rects[i],rects[k],-0.5)){
                found.push(`${rects[i].id}/${rects[k].id}`)
            }
        }
    }
    return found
}

console.log("a straight chain goes strictly left to right, once per column")
{
    const a=node(), b=node(), c=node()
    const nodes=[a,b,c]
    const links=[link(a,b),link(b,c)]
    const result=layoutFlow({nodes,links})
    test("three nodes, three columns",()=>{
        eq(result.layers.length,3)
        eq(result.layers[0][0],a.id)
        eq(result.layers[1][0],b.id)
        eq(result.layers[2][0],c.id)
    })
    test("x grows along the flow, y is free",()=>{
        ok(result.positions.get(a.id).x<result.positions.get(b.id).x,"a must be left of b")
        ok(result.positions.get(b.id).x<result.positions.get(c.id).x,"b must be left of c")
    })
    test("a chain has nothing to cross",()=>{
        eq(result.crossings,0)
    })
    test("a child sits at the height of its parent",()=>{
        eq(result.positions.get(a.id).y,result.positions.get(b.id).y)
        eq(result.positions.get(b.id).y,result.positions.get(c.id).y)
    })
    test("the drawing is bigger than its widest node and never empty",()=>{
        ok(result.bounds.width>nodes[0].width)
        ok(result.bounds.height>=LAYOUT_DEFAULTS.margin)
    })
}

console.log("no two nodes ever share the same pixels")
{
    //a star with wide and tall nodes: the second column has to stack them
    const source=node()
    const children=[0,1,2,3].map(k=>node({height:30+k*20,width:120+k*30}))
    const nodes=[source,...children]
    const links=children.map(child=>link(source,child))
    const result=layoutFlow({nodes,links})
    test("four children of the same parent do not overlap",()=>{
        eq(overlapsOf(nodes,result).join(","),"")
    })
    test("they are all one column",()=>{
        eq(result.layers.length,2)
    })
    test("the column is stacked in the order of the flow, top to bottom",()=>{
        const ys=result.layers[1].map(id=>result.positions.get(id).y)
        for(let k=1;k<ys.length;k++){
            ok(ys[k]>ys[k-1],`${ys[k]} must be below ${ys[k-1]}`)
        }
    })
    test("a fan of cables leaves the parent on the same height",()=>{
        const ys=result.layers[1].map(id=>result.positions.get(id).y)
        for(const y of ys){
            ok(Math.abs(y-result.positions.get(source.id).y)<400,"a child flew away")
        }
    })
}
{
    //a dense flow, built without Math.random so a failure is a failure and
    //not a bad day
    const nodes=[]
    for(let k=0;k<40;k++){
        nodes.push(node({width:120+(k%5)*25,height:28+(k%4)*14,inputCount:1+(k%3),outputCount:1+(k%2)}))
    }
    const links=[]
    for(let k=1;k<nodes.length;k++){
        //five chains of eight: dense enough to force crossings, shallow
        //enough to stay a DAG
        links.push(link(nodes[Math.floor((k-1)/8)*8+(k-1)%8],nodes[k]))
    }
    const result=layoutFlow({nodes,links})
    test("40 chained nodes: no overlap at all",()=>{
        eq(overlapsOf(nodes,result).join(","),"")
    })
    test("every node is drawn right of every one of its parents",()=>{
        for(const edge of links){
            ok(
                result.positions.get(edge.source).x<result.positions.get(edge.target).x,
                `${edge.source} must be left of ${edge.target}`
            )
        }
    })
    test("the drawing stays inside its own bounds",()=>{
        for(const rect of rectsOf(nodes,result)){
            ok(rect.x+rect.width<=result.bounds.width+0.5,`${rect.id} sticks out to the right`)
            ok(rect.y+rect.height<=result.bounds.height+0.5,`${rect.id} sticks out at the bottom`)
            ok(rect.x>=0&&rect.y>=0,`${rect.id} starts outside the field`)
        }
    })
    test("no coordinate is ever NaN",()=>{
        for(const rect of rectsOf(nodes,result)){
            ok(Number.isFinite(rect.x)&&Number.isFinite(rect.y),`${rect.id} is at ${rect.x},${rect.y}`)
        }
    })
    test("the order found is no worse than the order it started from",()=>{
        const graph=buildGraph({nodes,links})
        const byDepth=new Map()
        for(const id of graph.order){
            const depth=result.layer.get(id)
            if(!byDepth.has(depth)){
                byDepth.set(depth,[])
            }
            byDepth.get(depth).push(id)
        }
        const columns=[...byDepth.entries()].sort((a,b)=>a[0]-b[0]).map(([,ids])=>ids)
        const before=countCrossings(graph,columns)
        ok(result.crossings<=before,`${result.crossings} crossings vs ${before} before`)
    })
    test("the drawing is as wide as its columns need, and no wider",()=>{
        const widest=Math.max(...nodes.map(n=>n.width))
        ok(result.bounds.width<=nodes.length*(widest+LAYOUT_DEFAULTS.columnGap)+LAYOUT_DEFAULTS.margin,
            "the layout is wasting horizontal space")
    })
}

console.log("a node the user moved stays where the user put it")
{
    const a=node(), b=node(), c=node()
    const pinned=node({pinned:true,x:900,y:640})
    const result=layoutFlow({nodes:[a,b,c,pinned],links:[link(a,b),link(b,c)]})
    test("a pinned node does not move",()=>{
        eq(result.positions.get(pinned.id).x,900)
        eq(result.positions.get(pinned.id).y,640)
    })
    test("and nothing is drawn on top of it",()=>{
        eq(overlapsOf([a,b,c,pinned],result).join(","),"")
    })
    test("the rest of the flow is still laid out by column",()=>{
        ok(result.positions.get(a.id).x<result.positions.get(b.id).x)
        ok(result.positions.get(b.id).x<result.positions.get(c.id).x)
    })
    test("a node dragged out of the field is brought back into it",()=>{
        const lost=node({pinned:true,x:-400,y:-260})
        const drawn=layoutFlow({nodes:[a,b,c,lost],links:[link(a,b),link(b,c)]})
        for(const rect of rectsOf([a,b,c,lost],drawn)){
            ok(rect.x>=0&&rect.y>=0,`${rect.id} is still outside the field`)
        }
    })
}

console.log("a loop does not hang the layout")
{
    const a=node(), b=node(), c=node()
    const nodes=[a,b,c]
    const links=[link(a,b),link(b,c),link(c,a)]
    let result=null
    test("a cycle still produces a position for every node",()=>{
        result=layoutFlow({nodes,links})
        for(const n of nodes){
            ok(Number.isFinite(result.positions.get(n.id).x),`${n.id} has no x`)
            ok(Number.isFinite(result.positions.get(n.id).y),`${n.id} has no y`)
        }
    })
    test("and none of them overlap",()=>{
        eq(overlapsOf(nodes,result).join(","),"")
    })
}

console.log("a newcomer is wired in only when the answer is unique")
{
    //a source whose output is free, and a sink whose input is free: one of
    //each, so a node with a free input AND a free output lands in between
    const source=node({inputCount:0})
    const sink=node({outputCount:0})
    const newcomer=node()
    const graph=buildGraph({nodes:[source,sink,newcomer],links:[]})
    test("one dangling output and one dangling input: both sides are wired",()=>{
        const plan=autoLinkPlan(graph,newcomer.id)
        eq(plan.length,2)
        eq(plan[0].source,source.id)
        eq(plan[0].target,newcomer.id)
        eq(plan[1].source,newcomer.id)
        eq(plan[1].target,sink.id)
    })
    test("the newcomer lands in the middle, not at the end",()=>{
        const drawn=layoutFlow({
            nodes:[source,sink,newcomer],
            links:[
                {source:source.id,target:newcomer.id,sourcePort:0,targetPort:0},
                {source:newcomer.id,target:sink.id,sourcePort:0,targetPort:0}
            ]
        })
        eq(drawn.layers.length,3)
    })
}
{
    //two sources, both outputs free: which one? nobody can say, so nobody does
    const a=node({inputCount:0}), b=node({inputCount:0})
    const newcomer=node()
    const graph=buildGraph({nodes:[a,b,newcomer],links:[]})
    test("two dangling outputs: nothing is guessed on the input side",()=>{
        const plan=autoLinkPlan(graph,newcomer.id)
        eq(plan.filter(p=>p.target===newcomer.id).length,0)
    })
    test("but the output side is still decided when it is unique",()=>{
        const c=node({outputCount:0})
        const plan=autoLinkPlan(buildGraph({nodes:[a,b,c,newcomer],links:[]}),newcomer.id)
        eq(plan.length,1)
        eq(plan[0].target,c.id)
    })
    test("a node with two free outputs is ambiguous too",()=>{
        const twin=node({outputCount:2,inputCount:0})
        const sink=node({outputCount:0})
        const plan=autoLinkPlan(buildGraph({nodes:[a,b,twin,sink,newcomer],links:[]}),newcomer.id)
        eq(plan.length,1,"only the sink's input is free, so only that side is decided")
        eq(plan[0].target,sink.id)
    })
}
{
    const source=node({inputCount:0,outputCount:1})
    const newcomer=node({inputCount:0})
    test("a node with no free input gets nothing on that side",()=>{
        eq(autoLinkPlan(buildGraph({nodes:[source,newcomer],links:[]}),newcomer.id).length,0)
    })
    test("a node with no free output gets nothing on that side either",()=>{
        //sink.in1 is the only free input in the flow, and the newcomer has
        //nothing to give it: the one rule that could fire cannot
        const sink=node({inputCount:2,outputCount:0})
        const closed=node({inputCount:0,outputCount:0})
        const graph=buildGraph({
            nodes:[source,sink,closed],
            links:[link(source,sink,{targetPort:0})]
        })
        eq(autoLinkPlan(graph,closed.id).length,0)
    })
}
{
    //t already feeds s, and wiring the newcomer on BOTH sides would close
    //t -> s -> newcomer -> t
    const s=node({inputCount:1,outputCount:2})
    const t=node({inputCount:2,outputCount:1})
    const x=node({inputCount:0,outputCount:1})
    const y=node({inputCount:1,outputCount:0})
    const newcomer=node()
    const graph=buildGraph({
        nodes:[s,t,x,y,newcomer],
        links:[
            link(t,s),
            link(s,y),
            link(x,t)
        ]
    })
    test("both sides are never wired when together they would close a loop",()=>{
        const plan=autoLinkPlan(graph,newcomer.id)
        eq(plan.length,1)
    })
    test("and the side that is kept is the one the rule asked for first",()=>{
        const plan=autoLinkPlan(graph,newcomer.id)
        eq(plan[0].source,s.id)
        eq(plan[0].target,newcomer.id)
    })
}
{
    const a=node({inputCount:2,outputCount:1})
    const newcomer=node({inputCount:1})
    test("freePorts reports the ports no cable uses, in order",()=>{
        const graph=buildGraph({nodes:[a,newcomer],links:[]})
        eq(freePorts(graph,a.id,"input").join(","),"0,1")
        eq(freePorts(graph,newcomer.id,"output").join(","),"0")
    })
    test("a cable takes exactly one port on each of its two ends",()=>{
        const used=buildGraph({
            nodes:[a,newcomer],
            links:[link(a,newcomer,{sourcePort:0,targetPort:0})]
        })
        eq(freePorts(used,a.id,"output").join(","),"")
        eq(freePorts(used,a.id,"input").join(","),"0,1")
        eq(freePorts(used,newcomer.id,"input").join(","),"")
    })
    test("a node that is not in the graph has no free port at all",()=>{
        eq(freePorts(buildGraph({nodes:[a],links:[]}),"nowhere","input").join(","),"")
    })
}

console.log(`\n${passed} passed, ${failures.length} failed`)
if(failures.length){
    process.exit(1)
}
