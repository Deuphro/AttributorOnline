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

test("a SUBSTITUTION links two roots, like any other difference",()=>{
    /* Une substitution, c'est un ï¿½lï¿½ment retirï¿½ ET un ï¿½lï¿½ment ajoutï¿½. C'est un
       lien aussi lï¿½gitime qu'un ajout pur ï¿½ et la recherche de brique ne pouvait
       pas la trouver: elle comparait le diff SIGNï¿½ ï¿½ des compositions POSITIVES,
       et il aurait fallu une brique portant un compte nï¿½gatif pour que
       `-C-H+N-O` corresponde. Le diff est donc comparï¿½ en magnitude; la masse,
       elle, reste positive par construction, et c'est elle qui dï¿½cide de la
       direction. */
const plan=planFor([{group:"CHNO"},{group:"H2"}])
    const byKey=new Map(plan.items.map(item=>[item.key,item.composition]))
    const chno=byKey.get("12C 1H 14N 16O")
    const h2=byKey.get("1H2")
    assert.ok(chno&&h2,"the plan must carry both compositions")
    // CHNO minus H2 is -1H +12C +14N +16O: one hydrogen removed, the rest added.
    // |diff| is CHNO, which IS a brick of the plan â€” so this substitution must
    // be found where the old signed comparison could not have found it.
    const diff=forestCompositionDiff(chno,h2)
    assert.ok(!forestDiffIsEmpty(diff))
    assert.ok(forestDiffNotation(diff).includes("-"),"the diff must stay signed")
    assert.ok(forestDiffNotation(diff).includes("+"),"and it must mix both signs")
    const found=forestFindBrick(plan.items,diff)
    assert.ok(found>=0,
        `a substitution must match a brick, got -1 for ${forestDiffNotation(diff)}`)
})
test("a CHAIN of merges keeps every absorbed rank consumed",()=>{
    /* Le bug : `mergedFrom` ne portait que les rangs REÇUS. Après #0+#1 puis
       (fusionné)+#2, la provenance valait [0,2] — le rang 1, déjà absorbé, en
       disparaissait, et l'arbre #1 RÉAPPARAISSAIT dans la liste. L'utilisateur le
       voyait ressurgir et fusionnait ensuite le mauvais couple. */
    const tree=rank=>({rank,size:1,rootIndex:rank*10,weight:0,vertices:[
        {index:rank*10,mass:100+rank,intensity:1}],links:[]})
    const g0=tree(0), g1=tree(1), g2=tree(2)
    const first=forestMergeGraphs([g0,g1],[])
    assert.deepEqual(first.mergedFrom,[0,1],"a first merge absorbs both")
    // the first merge is drawn, then the user selects it with #2
    const second=forestMergeGraphs([first,g2],[])
    assert.deepEqual(second.mergedFrom,[0,1,2],
        "a chained merge must carry the ranks its input had already absorbed")
    assert.ok(second.mergedFrom.includes(1),
        "an absorbed rank must never fall out of the provenance")
})