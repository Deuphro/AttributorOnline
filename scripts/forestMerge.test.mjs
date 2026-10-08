import {test} from "node:test"
import assert from "node:assert/strict"
import {readFileSync} from "node:fs"
import {
    forestCompositionDiff,
    forestDiffIsEmpty,
    forestDiffNotation,
    forestFindBrick,
    forestMergeGraphs
} from "./forest.js"
import {Element} from "./chemistry.js"
import {buildPlan} from "./attribution.js"

const TABLE=Element.load(JSON.parse(
    readFileSync(new URL("../data/elements.json",import.meta.url),"utf8")))

const planFor=(combining,ionising=[{group:"[H+]",min:1,max:1,ratio:1}])=>buildPlan({
    combining,ionising,ratio:1,chargeMin:1,chargeMax:1,table:TABLE
})

test("the root diff is big minus small, isotope by isotope",()=>{
    const plan=planFor([{group:"CH4"},{group:"CH2"}])
    const byKey=new Map(plan.items.map(item=>[item.key,item.composition]))
    const ch4=byKey.get("12C 1H4")
    const ch2=byKey.get("12C 1H2")
    assert.ok(ch4&&ch2,"the plan must carry both compositions")
    const diff=forestCompositionDiff(ch4,ch2)
    assert.equal(forestDiffNotation(diff),"+1H2")
    assert.ok(!forestDiffIsEmpty(diff))
    const same=forestCompositionDiff(ch2,byKey.get("12C 1H2"))
    assert.ok(forestDiffIsEmpty(same),"same formula twice must give an empty diff")
})

test("a brick is found in either direction, or not at all",()=>{
    const plan=planFor([{group:"CH4"},{group:"CH2"}])
    const byKey=new Map(plan.items.map(item=>[item.key,item.composition]))
    const plus=forestCompositionDiff(byKey.get("12C 1H4"),byKey.get("12C 1H2"))
    const minus=forestCompositionDiff(byKey.get("12C 1H2"),byKey.get("12C 1H4"))
    assert.equal(forestFindBrick(plan.items,plus),-1)
    assert.equal(forestFindBrick(plan.items,minus),-1)
    const asIs=byKey.get("12C 1H2")
    assert.equal(forestFindBrick(plan.items,asIs),1)
    const negated=forestCompositionDiff(
        forestCompositionDiff(asIs,asIs),asIs)
    assert.equal(forestFindBrick(plan.items,negated),1,
        "-CH2 must match the CH2 brick: the link direction decides the sign")
})

test("merged graphs keep every vertex and link, plus the bridge",()=>{
    const g1={rank:0,size:2,rootIndex:0,weight:0.1,vertices:[
        {index:0,mass:100,intensity:1},{index:1,mass:114,intensity:2}],
        links:[{u:0,v:1,weight:0.1,standard:0,label:"CH2"}]}
    const g2={rank:1,size:1,rootIndex:5,weight:0,vertices:[
        {index:5,mass:128,intensity:3}],links:[]}
    const merged=forestMergeGraphs([g1,g2],[{u:1,v:5,weight:0.05,standard:0,label:"CH2"}])
    assert.equal(merged.size,3)
    assert.equal(merged.rootIndex,0,"the biggest tree keeps its root")
    assert.equal(merged.links.length,2)
    assert.deepEqual(merged.mergedFrom,[0,1])
    assert.equal(merged.totalIntensity,6)
    assert.ok(merged.vertices.every(v=>v.index!==undefined))
})
