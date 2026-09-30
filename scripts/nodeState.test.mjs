/* -------------------------------------------------------------------------
    Test — node scripts/nodeState.test.mjs

    A Command holds CLOSURES, so the undo stack can never be written anywhere:
    the history dies with the tab whatever we do. `serializeState` is therefore
    the ONLY durable record of what a node was set to, and a node that forgets
    to define it loses its settings silently - on export, on import, and on any
    future reload. TrimmerNode had no serializeState at all: an exported session
    came back as a pass-through with no window, and nothing said so.

    This test cannot run the node classes (they need d3 and a real DOM), so it
    reads interface.js as TEXT and checks the contract instead: a class that can
    be rebuilt from a session must define BOTH halves. It is a cheap guard
    against the whole family of bug, not a replacement for exercising a node.
   ------------------------------------------------------------------------- */
import {readFileSync} from "fs"

const source=readFileSync(new URL("./interface.js",import.meta.url),"utf8")

let passed=0
const failures=[]
const test=(name,fn)=>{
    try{ fn(); passed++; console.log(`  ok   ${name}`) }
    catch(e){ failures.push(name); console.log(`  FAIL ${name}\n       ${e.message}`) }
}
const ok=(value,msg)=>{ if(!value) throw new Error(msg??"expected a truthy value") }
const eq=(a,b,msg)=>{ if(a!==b) throw new Error(`${msg??`${a} != ${b}`}`) }

/* One block per class: from `class X ...{` to the next class (or the end of the
   file). Anchored on ^ and on the brace, so a class mentioned in a comment
   never becomes a block of its own. */
function classBlocks(text){
    const starts=[...text.matchAll(/^class\s+(\w+)(?:\s+extends\s+(\w+))?[^{]*\{/gm)]
    return starts.map((match,index)=>({
        name:match[1],
        parent:match[2]??null,
        body:text.slice(match.index,starts[index+1]?.index??text.length)
    }))
}
const blocks=new Map(classBlocks(source).map(block=>[block.name,block.body]))
const parents=new Map(classBlocks(source).map(block=>[block.name,block.parent]))
//a DEFINITION, not a mention: four spaces, then the name, then the parens. A
//comment line cannot look like that, so a comment naming serializeState cannot
//make a class look like it implements it.
const defines=(body,name)=>new RegExp(`^ {4}${name}\\(`,`m`).test(body??"")
/* A node type is often a thin subclass that inherits its state - SimpleXYPlotNode
   keeps its axes through NodeWithRightAccordionGraph - so "does this class save
   anything" is a question about the WHOLE chain, not about one body. */
function reaches(name,method,seen=new Set()){
    if(seen.has(name)) return false
    seen.add(name)
    if(defines(blocks.get(name),method)) return true
    const parent=parents.get(name)
    return parent?reaches(parent,method,seen):false
}

console.log("the file still parses into the classes this test knows about")
test("every class in interface.js was found",()=>{
    for(const name of ["Node","TrimmerNode","FKMDNode","PeakPickingNode","DelimitedTextNode","Flow","App"]){
        ok(blocks.has(name),`class ${name} not found - the parser is broken`)
    }
})
test("the parser did not swallow the whole file in one block",()=>{
    ok(blocks.size>20,`only ${blocks.size} classes found`)
})
test("inheritance is read, not guessed",()=>{
    eq(parents.get("SimpleXYPlotNode"),"NodeWithRightAccordionGraph")
    eq(parents.get("NodeWithAccordion"),"Node")
    eq(parents.get("Node"),null)
})

console.log("a node with settings of its own saves them")
/* The list mirrors createNodeForHistory's switch - a type missing from it
   cannot be rebuilt by an undo, so a state for it would be write-only. */
const RESTORABLE=[
    "DelimitedTextNode",
    "SimpleXYPlotNode",
    "NodeWithAccordionGraph",
    "NodeWithRightAccordionGraph",
    "PeakPickingNode",
    "TrimmerNode",
    "FKMDNode",
    //the collection reader keeps its view, its filters and its annotations: all
    //three are choices no resolve can reconstruct, so all three must travel
    "FormulaCollectionNode"
]
for(const name of RESTORABLE){
    test(`${name} saves what it was set to`,()=>{
        ok(reaches(name,"serializeState"),`${name} has no serializeState: its settings are lost on every save`)
    })
    test(`${name} can read that state back`,()=>{
        ok(reaches(name,"restoreState"),`${name} saves a state it cannot read back`)
    })
}

console.log("and no class does HALF of it")
for(const name of blocks.keys()){
    if(!reaches(name,"serializeState")&&!reaches(name,"restoreState")){
        continue
    }
    test(`${name} does not save without being able to read back`,()=>{
        eq(reaches(name,"serializeState"),reaches(name,"restoreState"),
            `${name} defines only one half of the pair`)
    })
}

console.log("a node with nothing to save says so, and needs no state")
/* Node is the base: it owns position and pinned, and the session format already
   carries both as fields of their own (serializeNode), so a serializeState here
   would be an empty object pretending to be a safety net. Operation and
   NodeWithAccordion add no setting of their own either. Saying this out loud is
   the point: an empty serializeState added to "satisfy" a linter would hide the
   fact that nothing needs saving. */
for(const name of ["Node","Operation","NodeWithAccordion"]){
    test(`${name} has no state, and that is correct`,()=>{
        ok(!reaches(name,"serializeState"),`${name} grew a state it has no setting for`)
        ok(!reaches(name,"restoreState"),`${name} grew a restore for a state it does not have`)
    })
}

console.log(`\n${passed} passed, ${failures.length} failed`)
if(failures.length){
    process.exit(1)
}
