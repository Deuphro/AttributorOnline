import {test} from "node:test"
import assert from "node:assert/strict"
import {readFileSync} from "node:fs"
import {methodBody} from "./sourceBody.mjs"

const plotSource=readFileSync(new URL("./nodes/SimpleXYPlotNode.js",import.meta.url),"utf8")
const attributionSource=readFileSync(new URL("./nodes/AttributionNode.js",import.meta.url),"utf8")
const eventTarget=new EventTarget()
globalThis.addEventListener=eventTarget.addEventListener.bind(eventTarget)
globalThis.removeEventListener=eventTarget.removeEventListener.bind(eventTarget)
globalThis.dispatchEvent=eventTarget.dispatchEvent.bind(eventTarget)

const plotOnPinChange=new Function("info",methodBody(plotSource,"onGraphPinChange"))
const plotCreateSelectedEvent=new Function("msg",methodBody(plotSource,"createPointSelectedEvent"))
const attributionHandlePointSelected=new Function("e",methodBody(attributionSource,"handlePointSelected"))
const attributionApplyPinSync=new Function("info",methodBody(attributionSource,"applyPinSync"))
const attributionHandlePinSync=new Function("e",methodBody(attributionSource,"handlePinSync"))

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

    const trace={id:"plot-1:0",title:"Sample",wave:{metadata:{sourceWave:"Sample"}}}
    const plot={
        graph:{traces:[trace]},
        events:{broadcast:{pinSync(info){
            return new CustomEvent("pinSync",{detail:{msg:info,emitter:plot}})
        }}},
        createPointSelectedEvent:plotCreateSelectedEvent
    }
    try{
        plotOnPinChange.call(plot,{traceId:trace.id,tracePoint:3,x:123.456789,y:17,added:true})
        plotOnPinChange.call(plot,{traceId:trace.id,tracePoint:3,x:123.456789,y:17,added:false})
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