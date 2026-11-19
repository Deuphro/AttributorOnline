import {readFileSync} from "node:fs"
import {fileURLToPath} from "node:url"
import {dirname,join} from "node:path"
import {Wave} from "./formats.js"
import {Element,Formula} from "./chemistry.js"
import {methodBody} from "./sourceBody.mjs"
import {columnLatticeBasis,quotientRepresentative} from "./math/integerLattice.js"

const here=dirname(fileURLToPath(import.meta.url))
const source=readFileSync(join(here,"nodes/StoichiometricAnalysisNode.js"),"utf8")
const table=Element.load(JSON.parse(readFileSync(join(here,"../data/elements.json"),"utf8")))
const waveForBody=methodBody(source,"waveFor")
const waveFor=new Function("Wave",`return function(points,axes,labels,constants=[0,0,0]){${waveForBody}}`)(Wave)
const addCollectionBody=methodBody(source,"addCollection")
const addCollection=new Function(`return function(name,rawFormulas,points,anchorIndex,source){${addCollectionBody}}`)()
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

const collectionContext={
    inputCollections:[],
    formulaFromEntry:raw=>raw.formula??null
}
addCollection.call(collectionContext,"sample",[{
    formula:{key:"C6H12O6",notation:"C6H12O6"},
    targets:[
        {mz:181.07,intensity:120,errorPpm:1.5,index:4},
        {mz:182.08,intensity:30,errorPpm:null,index:5}
    ]
}],[],0,"input")
const stored=collectionContext.inputCollections[0].records[0]
if(stored.intensity!==150){
    throw new Error(`expected target intensities to sum to 150, got ${stored.intensity}`)
}
if(stored.targets.length!==2||stored.targets[1].errorPpm===0){
    throw new Error("targets or their absent error metadata were not preserved")
}
console.log("formula records preserve extracted target intensities and target metadata")

const extractMethod=name=>methodBody(source,name)
const recomputeContext={
    loadedTable:table,
    parameters:{elements:["H","C","O"],patterns:["CH2","O"]},
    patternCache:new Map(),
    patternErrors:[],
    diagnostics:[],
    elements:new Function(`return function(){${extractMethod("elements")}}`)(),
    patterns:new Function(`return function(){${extractMethod("patterns")}}`)(),
    writtenElementCounts:new Function(`return function(formula){${extractMethod("writtenElementCounts")}}`)(),
    countElement:new Function(`return function(formula,symbol){${extractMethod("countElement")}}`)(),
    parsePattern:new Function("Formula",`return function(text){${extractMethod("parsePattern")}}`)(Formula),
    recompute:new Function("columnLatticeBasis","quotientRepresentative",
        `return function(){${extractMethod("recompute")}}`
    )(columnLatticeBasis,quotientRepresentative),
    inputCollections:[{
        name:"sample",
        records:["C6H12","C7H14","C6H12O"].map((notation,index)=>({
            formula:Formula.parse(notation,table),
            intensity:(index+1)*10,
            targets:[]
        }))
    }]
}
recomputeContext.recompute()
const firstLevel=recomputeContext.projectionLevels[0]
if(firstLevel.groups.length!==2||Math.max(...firstLevel.groups.map(group=>group.formulas.length))!==2){
    throw new Error("CH2 level did not group the two formulas differing by CH2")
}
if(firstLevel.groups[0].formulas.length!==2||firstLevel.groups[1].formulas.length!==1){
    throw new Error("groups are not sorted by descending formula count")
}
if(recomputeContext.projectionLevels[1].groups.length!==1||
   recomputeContext.projectionLevels[1].groups[0].formulas.length!==3){
    throw new Error("O level did not merge the formulas after O was added to the cumulative lattice")
}
console.log("the real recompute method builds nested CH2 then O formula groups")
