import {test} from "node:test"
import assert from "node:assert/strict"
import {readFileSync} from "node:fs"
import {methodBody} from "./sourceBody.mjs"
import {isMassXAxis,matchingTracePoints,pointCoordinates,traceSourceInfo} from "./utils/plotPointSync.js"

const plotSource=readFileSync(new URL("./nodes/SimpleXYPlotNode.js",import.meta.url),"utf8")
const fkmdSource=readFileSync(new URL("./nodes/FKMDNode.js",import.meta.url),"utf8")
const eventTarget=new EventTarget()
globalThis.addEventListener=eventTarget.addEventListener.bind(eventTarget)
globalThis.removeEventListener=eventTarget.removeEventListener.bind(eventTarget)
globalThis.dispatchEvent=eventTarget.dispatchEvent.bind(eventTarget)
const methods={}
for(const [name,parameters] of Object.entries({
    matchesCriteria:["msg","trace"],
    handlePointSelected:["e"],
    createPointSelectedEvent:["msg"]
})){
    methods[name]=new Function(...parameters,methodBody(plotSource,name))
}
    methods.applyPointSelection=new Function("matchingTracePoints","pointCoordinates",`return function(msg){${methodBody(plotSource,"applyPointSelection")}}`)(
        matchingTracePoints,pointCoordinates)
methods.applyPinSync=new Function("matchingTracePoints","pointCoordinates",`return function(info){${methodBody(plotSource,"applyPinSync")}}`)(
    matchingTracePoints,pointCoordinates)
methods.onGraphPinChange=new Function("traceSourceInfo","isMassXAxis",`return function(info){${methodBody(plotSource,"onGraphPinChange")}}`)(
    traceSourceInfo,isMassXAxis)

function makePlot(title, trace, filterCriteria=null){
    const plot={}
    Object.assign(plot,{
        title,
        filterCriteria,
        ...methods,
        events:{broadcast:{pinSync(info){
            return new CustomEvent("pinSync",{detail:{msg:info,emitter:plot}})
        }}},
        graph:{
            traces:[trace],
            pickPins:[],
            readPickValue(target,pointIndex){
                return target.wave.pointValues?.[pointIndex]??null
            },
            addPickPin(pin){
                this.pickPins.push({traceId:pin.trace.id,tracePoint:pin.tracePoint,x:pin.x,y:pin.y})
            },
            drawGraph(){},
            removePickPin(pin){
                this.pickPins=this.pickPins.filter(candidate=>candidate!==pin)
            }
        }
    })
    return plot
}

function makeTrace(id, title, metadata={}){
    return {id,title,wave:{dims:[3],labels:["m/z","intensity"],metadata}}
}

function relay(source, receiver, pointIndex, x=0, y=0){
    const listener=event=>receiver.handlePointSelected(event)
    globalThis.addEventListener("POINT_SELECTED",listener)
    try{
        source.onGraphPinChange({traceId:source.graph.traces[0].id,tracePoint:pointIndex,added:true,x,y})
    }finally{
        globalThis.removeEventListener("POINT_SELECTED",listener)
    }
}

test("a direct trace selection matches the FKMD output by source metadata",()=>{
    assert.match(plotSource,/this\.events\.listen\.POINT_SELECTED=this\.handlePointSelected\.bind\(this\)/)
    assert.match(fkmdSource,/title:`\$\{inputTitle\}.*F-KMD\)`/)
    assert.match(fkmdSource,/sourceWave:inputTitle/)
    const source=makePlot("source plot",makeTrace("channel-1:0","Sample"))
    const receiver=makePlot("FKMD plot",makeTrace("channel-2:0","Sample -> FKMD (F-KMD)",{sourceWave:"Sample"}),{
        title:"Sample",
        minPoints:3,
        maxPoints:3,
        pointIndex:0
    })

    relay(source,receiver,0,100,200)

    assert.deepEqual(receiver.graph.pickPins,[{traceId:"channel-2:0",tracePoint:0,x:100,y:200}])
})

test("an FKMD trace selection matches the direct trace by source title",()=>{
    const source=makePlot("FKMD plot",makeTrace("channel-2:0","Sample -> FKMD (F-KMD)",{sourceWave:"Sample"}))
    const receiver=makePlot("source plot",makeTrace("channel-1:0","Sample"),{title:"Sample"})

    relay(source,receiver,2,300,400)

    assert.deepEqual(receiver.graph.pickPins,[{traceId:"channel-1:0",tracePoint:2,x:300,y:400}])
})

test("a synchronized pin uses the receiver trace coordinates, not the emitter coordinates",()=>{
    const trace=makeTrace("channel-2:0","Sample -> FKMD (F-KMD)",{
        sourceWave:"Sample",
        sourceWaveId:"delimited-1"
    })
    trace.wave.pointValues=[{x:51.25,y:-0.375}]
    const receiver=makePlot("FKMD plot",trace)

    receiver.applyPinSync({
        sourceWaveId:"delimited-1",
        sourceWaveTitle:"Sample",
        sourcePointIndex:0,
        tracePoint:0,
        x:100,
        y:20,
        added:true
    })

    assert.deepEqual(receiver.graph.pickPins,[{
        traceId:"channel-2:0",tracePoint:0,x:51.25,y:-0.375
    }])
})

test("a selected pin does not spread to another trace with the same title",()=>{
    const intended=makeTrace("channel-2:0","Sample",{sourceWaveId:"delimited-2"})
    const unrelated=makeTrace("channel-3:0","Sample",{sourceWaveId:"delimited-3"})
    const receiver=makePlot("receiver",intended)
    receiver.graph.traces.push(unrelated)

    receiver.applyPinSync({
        sourceWaveId:"delimited-2",
        sourceWaveTitle:"Sample",
        sourcePointIndex:1,
        tracePoint:1,
        x:12,
        y:34,
        added:true
    })

    assert.deepEqual(receiver.graph.pickPins,[{
        traceId:"channel-2:0",tracePoint:1,x:12,y:34
    }])
})