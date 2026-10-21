import {test} from "node:test"
import assert from "node:assert/strict"
import {readFileSync} from "node:fs"
import {methodBody} from "./sourceBody.mjs"
import {isMassXAxis,traceSourceInfo} from "./utils/plotPointSync.js"

const plotSource=readFileSync(new URL("./nodes/SimpleXYPlotNode.js",import.meta.url),"utf8")
const attributionSource=readFileSync(new URL("./nodes/AttributionNode.js",import.meta.url),"utf8")
const collectionSource=readFileSync(new URL("./nodes/FormulaCollectionNode.js",import.meta.url),"utf8")
const eventTarget=new EventTarget()
globalThis.addEventListener=eventTarget.addEventListener.bind(eventTarget)
globalThis.removeEventListener=eventTarget.removeEventListener.bind(eventTarget)
globalThis.dispatchEvent=eventTarget.dispatchEvent.bind(eventTarget)

const plotOnPinChange=new Function("traceSourceInfo","isMassXAxis",`return function(info){${methodBody(plotSource,"onGraphPinChange")}}`)(
    traceSourceInfo,isMassXAxis)
const plotCreateSelectedEvent=new Function("msg",methodBody(plotSource,"createPointSelectedEvent"))
const attributionHandlePointSelected=new Function("e",methodBody(attributionSource,"handlePointSelected"))
const attributionApplyPinSync=new Function("info",methodBody(attributionSource,"applyPinSync"))
const attributionHandlePinSync=new Function("e",methodBody(attributionSource,"handlePinSync"))
const collectionOnGraphPinChange=new Function("traceSourceInfo","isMassXAxis",`return function(info){${methodBody(collectionSource,"onGraphPinChange")}}`)(
    traceSourceInfo,isMassXAxis)

test("a selected plot point updates Probe from its published mass exactly once",()=>{
    assert.match(attributionSource,/this\.events\.listen\.POINT_SELECTED=this\.handlePointSelected\.bind\(this\)/)

    let probeRuns=0
    const attribution={
        events:{broadcast:{},listen:{}},
        parameters:{},
        massInput:{value:""},
        probeMass(mass){probeRuns++;this.probedMass=mass},
        applyPinSync:attributionApplyPinSync,
        handlePointSelected:attributionHandlePointSelected,
        handlePinSync:attributionHandlePinSync
    }
    const pinSyncListener=event=>attribution.handlePinSync(event)
    const selectedListener=event=>attribution.handlePointSelected(event)
    globalThis.addEventListener("pinSync",pinSyncListener)
    globalThis.addEventListener("POINT_SELECTED",selectedListener)

    const trace={id:"plot-1:0",title:"Sample",wave:{labels:["m/z","intensity"],metadata:{sourceWave:"Sample"}}}
    const plot={
        graph:{traces:[trace]},
        events:{broadcast:{pinSync(info){
            return new CustomEvent("pinSync",{detail:{msg:info,emitter:plot}})
        }}},
        createPointSelectedEvent:plotCreateSelectedEvent
    }
    try{
        plotOnPinChange.call(plot,{traceId:trace.id,tracePoint:0,x:123.456789,y:17,added:true})
        plotOnPinChange.call(plot,{traceId:trace.id,tracePoint:0,x:123.456789,y:17,added:false})
    }finally{
        globalThis.removeEventListener("pinSync",pinSyncListener)
        globalThis.removeEventListener("POINT_SELECTED",selectedListener)
    }

    assert.equal(attribution.parameters.probeMass,123.456789)
    assert.equal(attribution.massInput.value,"123.45679")
    assert.equal(attribution.probedMass,123.456789)
    assert.equal(probeRuns,1)
})

test("non-positive or non-finite published masses are ignored",()=>{
    let probeRuns=0
    const attribution={
        events:{},parameters:{},massInput:{value:""},
        probeMass(){probeRuns++}
    }
    for(const mass of [0,-1,NaN,Infinity]){
        attributionHandlePointSelected.call(attribution,{
            detail:{emitter:{},msg:{mass}}
        })
    }
    assert.equal(probeRuns,0)
    assert.equal(attribution.parameters.probeMass,undefined)
})

test("a non-mass x axis does not publish a mass or trigger Probe",()=>{
    let probeRuns=0
    const attribution={parameters:{},massInput:{value:""},probeMass(){probeRuns++}}
    const listener=event=>attributionHandlePointSelected.call(attribution,event)
    globalThis.addEventListener("POINT_SELECTED",listener)
    const trace={id:"vk:trace",title:"van Krevelen",wave:{
        labels:["O/C","H/C"],
        metadata:{sourceWave:"Sample",sourcePointIndices:[[1,2]],formulaKeys:["C2H4O"]}
    }}
    const plot={
        graph:{traces:[trace]},
        events:{broadcast:{pinSync(info){
            return new CustomEvent("pinSync",{detail:{msg:info,emitter:plot}})
        }}},
        createPointSelectedEvent:plotCreateSelectedEvent
    }
    try{
        plotOnPinChange.call(plot,{traceId:trace.id,tracePoint:0,x:0.5,y:1.2,added:true})
    }finally{
        globalThis.removeEventListener("POINT_SELECTED",listener)
    }
    assert.equal(probeRuns,0)
    assert.equal(attribution.parameters.probeMass,undefined)
    assert.equal(attribution.massInput.value,"")
})

test("FormulaCollection publishes source-point identity without treating ratios as mass",()=>{
    let selectedMessage=null
    let pinMessage=null
    const selectedListener=event=>{selectedMessage=event.detail.msg}
    const pinListener=event=>{pinMessage=event.detail.msg}
    globalThis.addEventListener("POINT_SELECTED",selectedListener)
    globalThis.addEventListener("pinSync",pinListener)
    const trace={id:"collection:vk",title:"Sample — van Krevelen",wave:{
        labels:["O/C","H/C"],
        metadata:{sourceWave:"Sample",sourcePointIndices:[[2,5]],formulaKeys:["C2H4O"]}
    }}
    const node={
        graph:{traces:[trace]},
        events:{broadcast:{pinSync(info){
            return new CustomEvent("pinSync",{detail:{msg:info,emitter:node}})
        }}}
    }
    try{
        collectionOnGraphPinChange.call(node,{traceId:trace.id,tracePoint:0,x:0.5,y:1.2,added:true})
    }finally{
        globalThis.removeEventListener("POINT_SELECTED",selectedListener)
        globalThis.removeEventListener("pinSync",pinListener)
    }
    assert.equal(selectedMessage.isMass,false)
    assert.equal(selectedMessage.mass,undefined)
    assert.equal(pinMessage.sourceWaveTitle,"Sample")
    assert.deepEqual(pinMessage.sourcePointIndices,[2,5])
    assert.equal(pinMessage.formulaKey,"C2H4O")
})

test("a FormulaCollection m/z point still updates Probe",()=>{
    let probeRuns=0
    const attribution={
        parameters:{},
        massInput:{value:""},
        probeMass(mass){probeRuns++;this.probedMass=mass},
        handlePointSelected:attributionHandlePointSelected
    }
    const selectedListener=event=>attribution.handlePointSelected(event)
    globalThis.addEventListener("POINT_SELECTED",selectedListener)
    const trace={id:"collection:error",title:"Sample — error",wave:{
        labels:["m/z","error (ppm)"],
        metadata:{sourceWave:"Sample",sourcePointIndices:[4],formulaKeys:["C2H4O"]}
    }}
    const node={
        graph:{traces:[trace]},
        events:{broadcast:{pinSync(info){
            return new CustomEvent("pinSync",{detail:{msg:info,emitter:node}})
        }}}
    }
    try{
        collectionOnGraphPinChange.call(node,{traceId:trace.id,tracePoint:0,x:46.04186,y:-2.4,added:true})
    }finally{
        globalThis.removeEventListener("POINT_SELECTED",selectedListener)
    }
    assert.equal(attribution.parameters.probeMass,46.04186)
    assert.equal(attribution.massInput.value,"46.04186")
    assert.equal(attribution.probedMass,46.04186)
    assert.equal(probeRuns,1)
})