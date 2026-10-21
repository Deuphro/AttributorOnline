import {test} from "node:test"
import assert from "node:assert/strict"
import {readFileSync} from "node:fs"
import {methodBody} from "./sourceBody.mjs"

const plotSource=readFileSync(new URL("./nodes/SimpleXYPlotNode.js",import.meta.url),"utf8")
const fkmdSource=readFileSync(new URL("./nodes/FKMDNode.js",import.meta.url),"utf8")
const eventTarget=new EventTarget()
globalThis.addEventListener=eventTarget.addEventListener.bind(eventTarget)
globalThis.removeEventListener=eventTarget.removeEventListener.bind(eventTarget)
globalThis.dispatchEvent=eventTarget.dispatchEvent.bind(eventTarget)
const methods={}
for(const [name,parameters] of Object.entries({
    findSyncTrace:["traceId","traceTitle","sourceWaveTitle"],
    matchesCriteria:["msg","trace"],
    applyPointSelection:["msg"],
    handlePointSelected:["e"],
    onGraphPinChange:["info"],
    createPointSelectedEvent:["msg"]
})){
    methods[name]=new Function(...parameters,methodBody(plotSource,name))
}

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
            addPickPin(pin){
                this.pickPins.push({traceId:pin.trace.id,tracePoint:pin.tracePoint})
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
    return {id,title,wave:{dims:[3],metadata}}
}

function relay(source, receiver, pointIndex){
    const listener=event=>receiver.handlePointSelected(event)
    globalThis.addEventListener("POINT_SELECTED",listener)
    try{
        source.onGraphPinChange({traceId:source.graph.traces[0].id,tracePoint:pointIndex,added:true})
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

    relay(source,receiver,0)

    assert.deepEqual(receiver.graph.pickPins,[{traceId:"channel-2:0",tracePoint:0}])
})

test("an FKMD trace selection matches the direct trace by source title",()=>{
    const source=makePlot("FKMD plot",makeTrace("channel-2:0","Sample -> FKMD (F-KMD)",{sourceWave:"Sample"}))
    const receiver=makePlot("source plot",makeTrace("channel-1:0","Sample"),{title:"Sample"})

    relay(source,receiver,2)

    assert.deepEqual(receiver.graph.pickPins,[{traceId:"channel-1:0",tracePoint:2}])
})