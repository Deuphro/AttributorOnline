import {readFileSync} from "node:fs"
import {fileURLToPath} from "node:url"
import {dirname,join} from "node:path"
import {Wave} from "./formats.js"
import {methodBody} from "./sourceBody.mjs"

const here=dirname(fileURLToPath(import.meta.url))
const source=readFileSync(join(here,"nodes/StoichiometricAnalysisNode.js"),"utf8")
const waveForBody=methodBody(source,"waveFor")
const waveFor=new Function("Wave",`return function(points,axes,labels,constants=[0,0,0]){${waveForBody}}`)(Wave)
const points=[
    {values:[6,12,6]},
    {values:[2,4,1]},
    {values:[10,8,2]}
]
const wave=waveFor.call({},points,[0,1,2],["C","H","O"])

for(let pointIndex=0;pointIndex<points.length;pointIndex++){
    const actual=[0,1,2].map(axis=>wave.core[wave.index(pointIndex,0,axis)])
    const expected=points[pointIndex].values
    if(actual.join(",")!==expected.join(",")){
        throw new Error(`point ${pointIndex}: expected ${expected}, got ${actual}`)
    }
}

console.log("3 stoichiometric formula vectors preserve their exact 3D coordinates")
