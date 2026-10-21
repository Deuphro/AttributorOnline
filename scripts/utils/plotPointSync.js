export function traceSourceInfo(trace, tracePoint){
    const metadata=trace?.wave?.metadata??{}
    const sourcePointIndices=metadata.sourcePointIndices
    const sourcePoint=Array.isArray(sourcePointIndices)
        ?sourcePointIndices[tracePoint]
        :tracePoint
    const sourcePointList=Array.isArray(sourcePoint)
        ?sourcePoint.filter(Number.isInteger)
        :Number.isInteger(sourcePoint)?[sourcePoint]:[]
    return {
        sourceWaveTitle:metadata.sourceWave??metadata.title??metadata.collection??trace?.title,
        ...(sourcePointList.length===1?{sourcePointIndex:sourcePointList[0]}:{}),
        ...(sourcePointList.length>1?{sourcePointIndices:sourcePointList}:{}),
        formulaKey:metadata.formulaKeys?.[tracePoint]
    }
}

export function matchingTracePoints(traces, info){
    const matches=[]
    const sourcePointSet=new Set([
        ...(Number.isInteger(info.sourcePointIndex)?[info.sourcePointIndex]:[]),
        ...(Array.isArray(info.sourcePointIndices)?info.sourcePointIndices.filter(Number.isInteger):[])
    ])
    if(typeof info.sourceWaveTitle==="string"&&sourcePointSet.size){
        for(const trace of traces??[]){
            const metadata=trace.wave?.metadata??{}
            const sourceTitle=metadata.sourceWave??metadata.title??metadata.collection??trace.title
            if(sourceTitle!==info.sourceWaveTitle) continue
            const sourcePointIndices=metadata.sourcePointIndices
            if(Array.isArray(sourcePointIndices)){
                for(let pointIndex=0;pointIndex<sourcePointIndices.length;pointIndex++){
                    const pointSource=Array.isArray(sourcePointIndices[pointIndex])
                        ?sourcePointIndices[pointIndex]
                        :[sourcePointIndices[pointIndex]]
                    if(pointSource.some(index=>sourcePointSet.has(index))){
                        matches.push({trace,pointIndex})
                    }
                }
            }else{
                for(const pointIndex of sourcePointSet){
                    if(pointIndex>=0&&pointIndex<(trace.wave?.dims?.[0]??0)){
                        matches.push({trace,pointIndex})
                    }
                }
            }
        }
    }
    if(typeof info.formulaKey==="string"){
        for(const trace of traces??[]){
            const metadata=trace.wave?.metadata??{}
            const sourceTitle=metadata.sourceWave??metadata.title??metadata.collection??trace.title
            if(typeof info.sourceWaveTitle==="string"&&sourceTitle!==info.sourceWaveTitle) continue
            const formulaKeys=metadata.formulaKeys
            if(!Array.isArray(formulaKeys)) continue
            for(let pointIndex=0;pointIndex<formulaKeys.length;pointIndex++){
                if(formulaKeys[pointIndex]===info.formulaKey
                    &&!matches.some(match=>match.trace===trace&&match.pointIndex===pointIndex)){
                    matches.push({trace,pointIndex})
                }
            }
        }
    }
    if(matches.length) return matches
    const trace=traces?.find(candidate=>candidate.id===info.traceId)
    const pointIndex=info.tracePoint??info.pointIndex
    if(trace&&Number.isInteger(pointIndex)&&pointIndex>=0&&pointIndex<(trace.wave?.dims?.[0]??0)){
        return [{trace,pointIndex}]
    }
    return []
}

export function syncGraphPin(graph, info){
    if(!graph) return
    for(const {trace,pointIndex} of matchingTracePoints(graph.traces,info)){
        const existing=graph.pickPins.find(pin=>pin.traceId===trace.id&&pin.tracePoint===pointIndex)
        if(info.added){
            if(!existing){
                graph.addPickPin({trace,tracePoint:pointIndex,x:info.x,y:info.y,px:0,py:0})
            }
        }else if(existing){
            graph.removePickPin(existing)
        }
    }
    graph.drawGraph?.()
}

export function isMassXAxis(trace){
    const label=String(trace?.wave?.labels?.[0]??"").trim().toLowerCase()
    return ["m/z","mz","mass","mass (da)","mass (m/z)"].includes(label)
}
