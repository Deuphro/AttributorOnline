import {test} from "node:test"
import assert from "node:assert/strict"
import {readFileSync} from "node:fs"
import {methodBody} from "./sourceBody.mjs"
import {matchingTracePoints,syncGraphPin,traceSourceInfo,isMassXAxis} from "./utils/plotPointSync.js"

const simpleSource=readFileSync(new URL("./nodes/SimpleXYPlotNode.js",import.meta.url),"utf8")
const collectionSource=readFileSync(new URL("./nodes/FormulaCollectionNode.js",import.meta.url),"utf8")
const simpleApplyPinSync=new Function("matchingTracePoints",`return function(info){${methodBody(simpleSource,"applyPinSync")}}`)(matchingTracePoints)
const collectionApplyPinSync=new Function("syncGraphPin",`return function(info){${methodBody(collectionSource,"applyPinSync")}}`)(syncGraphPin)

function trace(id,title,metadata,labels=["m/z","intensity"],count=3){
    return {id,title,wave:{dims:[count],labels,metadata}}
}

function graph(traces){
    return {
        traces,
        pickPins:[],
        addPickPin({trace:target,tracePoint}){
            this.pickPins.push({traceId:target.id,tracePoint})
        },
        removePickPin(pin){
            this.pickPins=this.pickPins.filter(candidate=>candidate!==pin)
        },
        drawGraph(){}
    }
}

test("a source peak pins all matching targets and unpins them in reverse",()=>{
    const collectionTrace=trace("collection:cluster0","Sample — cluster 1",{
        sourceWave:"Sample",
        sourcePointIndices:[0,2,0]
    })
    const targetGraph=graph([collectionTrace])
    const selected={sourceWaveTitle:"Sample",sourcePointIndex:0,added:true}

    assert.deepEqual(matchingTracePoints(targetGraph.traces,selected).map(point=>point.pointIndex),[0,2])
    syncGraphPin(targetGraph,selected)
    assert.deepEqual(targetGraph.pickPins,[
        {traceId:"collection:cluster0",tracePoint:0},
        {traceId:"collection:cluster0",tracePoint:2}
    ])
    syncGraphPin(targetGraph,{...selected,added:false})
    assert.deepEqual(targetGraph.pickPins,[])
})

test("a FormulaCollection formula point maps back to its source peak indices",()=>{
    const formulaTrace=trace("collection:vankrevelen","collection — van Krevelen",{
        sourceWave:"Sample",
        sourcePointIndices:[[1,2]],
        formulaKeys:["C2H4O"]
    },["O/C","H/C"],1)
    const selected=traceSourceInfo(formulaTrace,0)
    const simpleTrace=trace("simple:0","Sample",{},["m/z","intensity"])

    assert.deepEqual(selected.sourcePointIndices,[1,2])
    assert.equal(selected.formulaKey,"C2H4O")
    assert.deepEqual(matchingTracePoints([simpleTrace],selected).map(point=>point.pointIndex),[1,2])
})

test("FormulaCollection points match by formula key when graph modes differ",()=>{
    const errorTrace=trace("collection:error","collection — error",{
        sourceWave:"Sample",sourcePointIndices:[3],formulaKeys:["C2H4O"]
    },["m/z","error (ppm)"],1)
    const vkTrace=trace("collection:vankrevelen","collection — van Krevelen",{
        sourceWave:"Sample",formulaKeys:["C2H4O","C3H6O"]
    },["O/C","H/C"],2)

    assert.deepEqual(matchingTracePoints([vkTrace],traceSourceInfo(errorTrace,0)),[
        {trace:vkTrace,pointIndex:0}
    ])
})

test("SimpleXYPlot and FormulaCollection pin each other by source peak",()=>{
    const rawTrace=trace("channel-1:0","Sample",{},["m/z","intensity"])
    const collectionTrace=trace("collection:error","Sample — error",{
        sourceWave:"Sample",sourcePointIndices:[2,0,2],formulaKeys:["A","B","C"]
    },["m/z","error (ppm)"])
    const rawGraph=graph([rawTrace])
    const collectionGraph=graph([collectionTrace])
    const simplePlot={
        graph:rawGraph,
        matchesCriteria(){return true}
    }
    const collectionPlot={graph:collectionGraph}

    simpleApplyPinSync.call(simplePlot,{...traceSourceInfo(collectionTrace,0),added:true})
    assert.deepEqual(rawGraph.pickPins,[{traceId:"channel-1:0",tracePoint:2}])

    collectionApplyPinSync.call(collectionPlot,{
        sourceWaveTitle:"Sample",sourcePointIndex:2,added:true
    })
    assert.deepEqual(collectionGraph.pickPins,[
        {traceId:"collection:error",tracePoint:0},
        {traceId:"collection:error",tracePoint:2}
    ])
})

test("only explicitly mass-labelled x axes qualify as a mass",()=>{
    assert.equal(isMassXAxis(trace("mz","mass",{},["m/z","intensity"])),true)
    assert.equal(isMassXAxis(trace("ratio","ratio",{},["O/C","H/C"])),false)
    assert.equal(isMassXAxis(trace("unknown","unknown",{},["x","y"])),false)
})
