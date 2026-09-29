/* -------------------------------------------------------------------------
    Test — node scripts/sessionStore.test.mjs

    What is tested is the SHAPE and the refusals, because those are the two ways
    this file can quietly hurt someone: a skeleton carrying a field nobody meant
    to store, and a corrupted entry that stops the app from starting. Both are
    invisible in a screenshot and obvious here.

    The storage is a Map, so none of this needs a browser.
   ------------------------------------------------------------------------- */
import {
    PREFERENCES_KEY,
    SKELETON_KEY,
    SKELETON_VERSION,
    buildSkeleton,
    clearSession,
    debounce,
    exportSkeleton,
    importOptions,
    parseSkeleton,
    readPreferences,
    readSession,
    reparseRestoredSource,
    savePreferences,
    writeSession
} from "./sessionStore.js"

let passed=0
const failures=[]
const test=(name,fn)=>{
    try{ fn(); passed++; console.log(`  ok   ${name}`) }
    catch(e){ failures.push(name); console.log(`  FAIL ${name}\n       ${e.message}`) }
}
const eq=(a,b,msg)=>{ if(a!==b) throw new Error(`${msg??`${a} != ${b}`}`) }
const ok=(value,msg)=>{ if(!value) throw new Error(msg??"expected a truthy value") }
const isNull=v=>v===null||v===undefined

/* --- a stand-in for the app, with the shape buildSkeleton reads -------- */

/* Faithful on the two details the skeleton depends on, because a fake that gets
   them wrong tests nothing: the type is read from constructor.name (a real class
   name, not a field), and the registration name lives under events, which is
   where Channel.register puts it. */
let counter=0
const makeNode=(over={})=>{
    counter++
    const type=over.type??`Node${counter}`
    const slots=over.slots??{}
    const node={
        title:over.title??type,
        status:over.status??"floating",
        events:{registrationId:`channel-${counter}`,registrationName:`reg-${counter}`,label:over.title??type},
        parameters:{
            position:{x:over.x??10,y:over.y??20},
            pinned:!!over.pinned,
            source:over.source
        },
        //a slot holds traces, and the skeleton keeps the COUNT of them, never
        //what was in them
        inputs:Array.from({length:slots.inputs??1},()=>[]),
        outputs:Array.from({length:slots.outputs??1},()=>[]),
        serializeState:()=>over.state??null
    }
    Object.setPrototypeOf(node,{constructor:{name:type}})
    return node
}
const makeApp=(nodes,links=[])=>({
    parameters:{
        topContent:{folded:false,height:125},
        leftContent:{folded:false,width:250}
    },
    channel:{casters:new Map([
        ["flow",{
            title:"mainFlow",
            events:{registrationName:"mainFlow",label:"mainFlow"},
            parameters:{
                field:{drawn:true,node:[],links:{stiffness:75}},
                layout:{columnGap:80,rowGap:14}
            },
            nodeSet:new Set(nodes),
            linkList:links
        }]
    ])}
})
const link=(a,b)=>({
    inputNode:a, inputAnchor:{id:"0"},
    outputNode:b, outputAnchor:{id:"0"}
})
const memoryStorage=()=>{
    const map=new Map()
    return {
        map,
        getItem:k=>map.has(k)?map.get(k):null,
        setItem:(k,v)=>map.set(k,String(v)),
        removeItem:k=>map.delete(k)
    }
}

console.log("the skeleton is a list, not a copy of whatever the node holds")
{
    const node=makeNode({
        type:"TrimmerNode",
        state:{method:"madResidual",lowBound:12,highBound:3400,logY:true},
        pinned:true,
        x:250,y:20
    })
    const skeleton=buildSkeleton(makeApp([node]))
    const saved=skeleton.flows[0].nodes[0]
    test("the node's own state travels",()=>{
        eq(JSON.stringify(saved.state),JSON.stringify({method:"madResidual",lowBound:12,highBound:3400,logY:true}))
    })
    test("and so do its place and its pin",()=>{
        eq(saved.position.x,250)
        eq(saved.pinned,true)
        eq(saved.type,"TrimmerNode")
        eq(saved.registrationName,node.events.registrationName)
    })
    test("a node with no state of its own writes null, not an empty object",()=>{
        const bare=buildSkeleton(makeApp([makeNode({type:"Node"})])).flows[0].nodes[0]
        if(!isNull(bare.state)) throw new Error(`state was ${JSON.stringify(bare.state)}`)
    })
    test("the flow's knobs travel but its drawing flags do not",()=>{
        const flow=skeleton.flows[0]
        ok(flow.parameters.layout,"the layout is a setting and must travel")
        ok(!("field" in flow.parameters),"field is a drawing flag, rebuilt by the constructor")
    })
    test("the panel geometry travels too",()=>{
        eq(skeleton.app.parameters.topContent.height,125)
    })
    test("a node's shape travels as a COUNT, never as what was in it",()=>{
        const plot=buildSkeleton(makeApp([makeNode({type:"SimpleXYPlotNode",slots:{inputs:1,outputs:1}})]))
        const saved=plot.flows[0].nodes[0]
        eq(saved.inputCount,1)
        eq(saved.outputCount,1)
        ok(!("inputs" in saved)&&!("outputs" in saved),"the slots themselves must not be written")
    })
    test("a node with no slots at all comes back with none",()=>{
        const bare=buildSkeleton(makeApp([makeNode({type:"NodeWithRightAccordionGraph",slots:{inputs:0,outputs:0}})]))
        eq(bare.flows[0].nodes[0].inputCount,0)
        eq(bare.flows[0].nodes[0].outputCount,0)
    })
    test("three outputs stay three outputs, so a link by index still lands",()=>{
        const wide=buildSkeleton(makeApp([makeNode({slots:{inputs:2,outputs:3}})]))
        eq(wide.flows[0].nodes[0].outputCount,3)
    })
}{
    //the whole point: a loaded file's PAIRS must not be stored, only its text
    const source={
        fileName:"a.txt",labels:["x","y"],
        lineSeparator:"\\r\\n|\\r|\\n",columnSeparator:"\\t|,|\\s",
        raw:"1\t2\n3\t4",
        pairs:[[1,2],[3,4]]
    }
    const skeleton=buildSkeleton(makeApp([makeNode({source})]))
    const saved=skeleton.flows[0].nodes[0].source
    test("the file text travels",()=>{
        eq(saved.raw,"1\t2\n3\t4")
        eq(saved.fileName,"a.txt")
    })
    test("the PARSED pairs do not - they are rebuildable from the text",()=>{
        ok(!("pairs" in saved),`pairs leaked into the skeleton: ${JSON.stringify(saved)}`)
    })
    test("and nothing else of the source sneaks in",()=>{
        eq(Object.keys(saved).sort().join(","),"columnSeparator,fileName,labels,lineSeparator,raw")
    })
    test("a node whose state ALSO carries the source does not store it twice",()=>{
        //DelimitedTextNode.serializeState returns {source, status} for the
        //exported FILE, where the source belongs. Keeping that copy here would
        //put the raw text in twice and the pairs in on top
        const node=makeNode({source,state:{source:{...source},status:"resolved"}})
        const savedState=buildSkeleton(makeApp([node])).flows[0].nodes[0].state
        ok(!("source" in savedState),`the state's own source leaked: ${JSON.stringify(savedState)}`)
        eq(savedState.status,"resolved","the rest of the state must survive")
    })
    test("a state that was ONLY a source collapses to nothing rather than lying",()=>{
        const node=makeNode({source,state:{source:{...source}}})
        const savedState=buildSkeleton(makeApp([node])).flows[0].nodes[0].state
        eq(Object.keys(savedState).length,0)
    })
}

console.log("links are written by the channel's own key, never by its name")
{
    const a=makeNode({type:"DelimitedTextNode"})
    const b=makeNode({type:"PeakPickingNode"})
    const skeleton=buildSkeleton(makeApp([a,b],[link(a,b)]))
    const cable=skeleton.flows[0].links[0]
    test("both ends are the registrationId, which is what sessions.js looks up",()=>{
        eq(cable.inputNode,a.events.registrationId)
        eq(cable.outputNode,b.events.registrationId)
        eq(cable.inputIndex,0)
        eq(cable.outputIndex,0)
    })
    test("a node carries the id its links will be resolved through",()=>{
        eq(skeleton.flows[0].nodes[0].id,a.events.registrationId)
    })
    test("the readable name is kept too, for a human reading the JSON",()=>{
        eq(skeleton.flows[0].nodes[0].registrationName,a.events.registrationName)
    })
    test("a folded node comes back folded",()=>{
        a.accordion={parameters:{folded:true}}
        eq(buildSkeleton(makeApp([a])).flows[0].nodes[0].folded,true)
        a.accordion.parameters.folded=false
        eq(buildSkeleton(makeApp([a])).flows[0].nodes[0].folded,false)
    })
    test("a node with no accordion at all is simply not folded",()=>{
        eq(buildSkeleton(makeApp([b])).flows[0].nodes[0].folded,false)
    })
    test("a dangling draft link is not written",()=>{
        const draft=buildSkeleton(makeApp([a],[{inputNode:a,inputAnchor:{id:"0"},outputNode:null,outputAnchor:null}])).flows[0].links
        eq(draft.length,0)
    })
}

console.log("a skeleton is its own document, versioned apart from the file")
{
    const text=exportSkeleton(makeApp([makeNode()]))
    test("it declares the shared format and its own shape version",()=>{
        const document=parseSkeleton(text)
        eq(document.format,"attributor-session")
        eq(document.version,1)
        eq(document.skeletonVersion,SKELETON_VERSION)
    })
    test("it is JSON, so a support answer can read it",()=>{
        ok(()=>JSON.parse(text))
    })
}

console.log("anything unreadable means an empty app, never an exception")
{
    const bad=[
        ["", "an empty string"],
        ["{not json", "a half-written entry"],
        ["null", "a null document"],
        ["[1,2,3]", "an array"],
        [JSON.stringify({format:"something-else"}), "a foreign format"],
        [JSON.stringify({format:"attributor-session",flows:[]}), "a shape version from another build"]
    ]
    for(const [text,why] of bad){
        test(`${why} reads as "no saved session"`,()=>{
            if(!isNull(parseSkeleton(text))) throw new Error("it parsed anyway")
        })
    }
    test("the version check really is what rejects a foreign shape",()=>{
        const document=JSON.parse(exportSkeleton(makeApp([makeNode()])))
        document.skeletonVersion=SKELETON_VERSION+1
        if(!isNull(parseSkeleton(JSON.stringify(document)))) throw new Error("a future shape was accepted")
    })
    test("a skeleton with no flows at all is refused rather than half-applied",()=>{
        const document=JSON.parse(exportSkeleton(makeApp([makeNode()])))
        document.flows={}
        if(!isNull(parseSkeleton(JSON.stringify(document)))) throw new Error("a non-array flows was accepted")
    })
}
console.log("the store: a key, a round trip, and a clean slate")
{
    const storage=memoryStorage()
    const app=makeApp([makeNode({state:{method:"passthrough"}})])
    test("write then read gives the same skeleton back",()=>{
        writeSession(app,storage)
        const document=readSession(storage)
        eq(document.flows[0].nodes[0].state.method,"passthrough")
    })
    test("nothing written reads as a first visit",()=>{
        if(!isNull(readSession(memoryStorage()))) throw new Error("an empty store produced a session")
    })
    test("a storage that refuses the write does not throw out of the module",()=>{
        const full={
            getItem:()=>null,
            setItem:()=>{const e=new Error("quota");e.name="QuotaExceededError";throw e},
            removeItem:()=>{}
        }
        //writeSession lets the error out - it is the caller's debounce that
        //catches it - but nothing here may hide it
        let raised=false
        try{ writeSession(app,full) }catch{ raised=true }
        ok(raised,"a QuotaExceededError must reach the caller, not be swallowed")
    })
    test("New session clears it, and the entry is really gone",()=>{
        clearSession(storage)
        ok(!storage.map.has(SKELETON_KEY))
        if(!isNull(readSession(storage))) throw new Error("the skeleton survived the reset")
    })
    test("preferences live under their own key",()=>{
        savePreferences(app,storage)
        ok(storage.map.has(PREFERENCES_KEY),"the preferences were not written")
        ok(!storage.map.has(SKELETON_KEY),"a session was written by mistake")
        eq(readPreferences(storage).leftContent.width,250)
    })
    test("clearing the session leaves the preferences alone",()=>{
        clearSession(storage)
        eq(readPreferences(storage).topContent.height,125)
    })
}
console.log("the debounced writer coalesces, and a failure never escapes")
{
    const sleep=ms=>new Promise(r=>setTimeout(r,ms))
    test("twenty calls in a row write once",async()=>{
        const storage=memoryStorage()
        let writes=0
        const save=debounce(()=>{writes++},{wait:30,storage,name:"test"})
        for(let k=0;k<20;k++){
            save(k)
        }
        eq(writes,0,"it wrote before the delay elapsed")
        await sleep(90)
        eq(writes,1)
    })
    test("a throwing write is reported, not propagated",async()=>{
        let logged=0
        const original=console.warn
        console.warn=()=>{logged++}
        const save=debounce(()=>{throw new Error("quota")},{wait:20,name:"test"})
        try{
            save()
            await sleep(80)
        }finally{
            console.warn=original
        }
        eq(logged,1)
    })
    test("a forced write happens at once, and swallows a failure like the delayed one",async()=>{
        let writes=0
        const save=debounce(()=>{writes++},{wait:10000})
        save()
        save.flush()
        eq(writes,1,"flush must not wait for the delay")
        //and the pending timer is gone: it must not write a second time
        await sleep(60)
        eq(writes,1)
    })
    test("a forced write that throws is reported, not propagated",()=>{
        let logged=0
        const original=console.warn
        console.warn=()=>{logged++}
        try{
            debounce(()=>{throw new Error("quota")},{name:"test"}).flush()
        }finally{
            console.warn=original
        }
        eq(logged,1)
    })
    test("cancel drops the pending write entirely",async()=>{
        let writes=0
        const save=debounce(()=>{writes++},{wait:20})
        save()
        save.cancel()
        await sleep(80)
        eq(writes,0,"a cancelled save must not come back: that is what makes New session stick")
    })
}

console.log("booting: options are built from the skeleton, and only from a real one")
{
    const document=parseSkeleton(exportSkeleton(makeApp([makeNode()])))
    test("a first visit builds no options at all",()=>{
        if(importOptions(null,{createApp:()=>({})})!==null){
            throw new Error("options were built for an empty app")
        }
    })
    test("a real skeleton builds a factory and no flow factory",()=>{
        const options=importOptions(document,{createApp:()=>({}),buildNode:()=>({})})
        ok(typeof options.createNode==="function")
        ok(typeof options.createLink==="function")
        eq(options.createFlow,undefined,"a skeleton never invents a flow")
    })
    test("the node factory is interface.js's, and it receives the shape counts",()=>{
        //the two-signature trap: a skeleton that called a constructor itself
        //would land `destination` on undefined and take the whole app down
        const options=importOptions(document,{
            createApp:()=>({}),
            buildNode:data=>{
                called={type:data.type,inputs:data.inputCount,outputs:data.outputCount}
                return {parameters:{},restoreState(){}}
            }
        })
        let called=null
        const node=options.createNode({
            data:{type:"SimpleXYPlotNode",title:"plot",inputCount:2,outputCount:3},
            app:{},
            flow:{},
            channel:{register(){}}
        })
        eq(called.type,"SimpleXYPlotNode")
        eq(called.inputs,2)
        eq(called.outputs,3)
        ok(node!==null,"the node the hook built is the one that comes back")
    })
    test("no factory means no node, and no exception either",()=>{
        const options=importOptions(document,{createApp:()=>({})})
        const node=options.createNode({data:{type:"FromTheFuture",title:"x"},app:{},flow:{},channel:{register(){}}})
        if(node!==null) throw new Error(`a node came out of nothing: ${node}`)
    })
    test("pairs are rebuilt from the raw text, never restored",()=>{
        let parsed=0
        let resolved=0
        const node={
            parameters:{source:{raw:"1\t2\n3\t4",pairs:[]}},
            parseRaw:()=>{parsed++;return [[1,2],[3,4]]},
            startResolve:()=>{resolved++;return "resolved"}
        }
        eq(reparseRestoredSource(node),node)
        eq(parsed,1)
        eq(resolved,0,"the flow resolve runs the whole graph: doing it here too meant every node resolved twice")
        eq(node.parameters.source.pairs.length,2)
    })
    test("a node with no text is left alone",()=>{
        let called=false
        const node={
            parameters:{source:{raw:"",pairs:[[1,2]]}},
            parseRaw:()=>{called=true;return []}
        }
        eq(reparseRestoredSource(node),null)
        ok(!called,"it parsed an empty file")
    })
    test("a node that cannot parse is not an error",()=>{
        eq(reparseRestoredSource({parameters:{}}),null)
        eq(reparseRestoredSource(null),null)
    })
}

console.log(`\n${passed} passed, ${failures.length} failed`)
if(failures.length){
    process.exit(1)
}