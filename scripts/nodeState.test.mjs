/* -------------------------------------------------------------------------
    Test — node scripts/nodeState.test.mjs

    A Command holds CLOSURES, so the undo stack can never be written anywhere:
    the history dies with the tab whatever we do. `serializeState` is therefore
    the ONLY durable record of what a node was set to, and a node that forgets
    to define it loses its settings silently - on export, on import, and on any
    future reload. TrimmerNode had no serializeState at all: an exported session
    came back as a pass-through with no window, and nothing said so.

    This test cannot run the node classes (they need d3 and a real DOM), so it
    reads them as TEXT and checks the contract instead: a class that can
    be rebuilt from a session must define BOTH halves. It is a cheap guard
    against the whole family of bug, not a replacement for exercising a node.

    It used to read interface.js. The refactor split that file into nodes/*.js,
    core/index.js and flow/*.js and deleted it, which killed this test outright
    — it died on ENOENT and the guard it was written for stopped existing.
    scripts/nodeSource.mjs now reads the modules that replaced it.
   ------------------------------------------------------------------------- */
import {readFileSync} from "fs"
import {blocks,parents,DUPLICATE_CLASSES,balancedObject,defines,reaches} from "./nodeSource.mjs"

let passed=0
const failures=[]
const test=(name,fn)=>{
    try{ fn(); passed++; console.log(`  ok   ${name}`) }
    catch(e){ failures.push(name); console.log(`  FAIL ${name}\n       ${e.message}`) }
}
const ok=(value,msg)=>{ if(!value) throw new Error(msg??"expected a truthy value") }
const eq=(a,b,msg)=>{ if(a!==b) throw new Error(`${msg??`${a} != ${b}`}`) }

console.log("the modules still parse into the classes this test knows about")
test("every class this test names was found",()=>{
    for(const name of ["Node","TrimmerNode","FKMDNode","PeakPickingNode","DelimitedTextNode","Flow"]){
        ok(blocks.has(name),`class ${name} not found - the parser is broken`)
    }
})
test("no class name is claimed by two modules",()=>{
    /* A duplicate would make the later block shadow the earlier one, and the
       inheritance walk would then answer from the wrong body — every assertion
       below would still run, and quietly describe the wrong class. */
    eq(DUPLICATE_CLASSES.length,0,
        `${DUPLICATE_CLASSES.join(", ")}: two modules define the same class, so one shadowed the other`)
})
test("the parser found every node module, not just the first",()=>{
    /* One file read and twenty ignored looks exactly like a passing test, so the
       count is asserted: the contract is "every node is covered", and a parser
       that quietly read one module would satisfy a per-class loop over one
       module's classes. */
    ok(blocks.size>20,`only ${blocks.size} classes found - is nodeSource.mjs listing every module?`)
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
/* Derived from the registration the menu itself uses, not written out here.

   An undo of a deletion rebuilds the node from nodeRestoreData +
   createNodeForHistory, so a type with no state is a type whose settings are
   written and never read back. This list used to be eight names typed by hand
   while nine node classes existed: AttributionNode, CalibrationNode,
   ThermoRawNode and ChatNode all implement the pair and none of them was
   checked, so the guard passed on the nodes it happened to remember. Reading
   the registration means a node added there cannot be forgotten here — which
   is the whole point of the comment above NODE_CONSTRUCTORS. */
const REGISTERED=readFileSync(new URL("./app/registerNodeTypes.js",import.meta.url),"utf8")
/* The registration is an Object.assign(NODE_CONSTRUCTORS, { … }) rather than a
   bare `const NODE_CONSTRUCTORS = { … }`, so the name appears inside a CALL.
   constBlock looks for the assignment shape and finds nothing here — which would
   leave the list empty, and an empty list passes every assertion in this section
   without checking a single node. The bracket walk still does the work, so it is
   pointed at the argument instead of the declaration. */
const registrationStart=REGISTERED.indexOf("NODE_CONSTRUCTORS")
ok(registrationStart>0,
    "registerNodeTypes.js does not fill NODE_CONSTRUCTORS: nothing to check, and the guard is inert")
const registrations=balancedObject(REGISTERED,REGISTERED.indexOf("{",registrationStart))
//shorthand entries (`TrimmerNode,`) and aliases (`AntiRadioNode:PeakPickingNode`)
//both name a real class; only the VALUE of an alias is ever instantiated, so the
//key is dropped and the class kept
/* Node owns position and pinned, and the session format already carries both as
   fields of their own, so a serializeState there would be an empty object
   pretending to be a safety net. Operation and NodeWithAccordion add no setting
   of their own either. They are REGISTERED — a session can name them — so they
   have to be excluded here explicitly rather than by being absent. */
const STATELESS=new Set(["Node","Operation","NodeWithAccordion"])
const RESTORABLE=[...new Set(
    [...registrations.matchAll(/^\s*"?([A-Za-z]\w*)"?\s*(?::\s*(\w+))?\s*,?\s*$/gm)]
        .map(match=>match[2]??match[1])
)]
    //the three that own no setting are checked separately, and CORRECTLY, below
    .filter(name=>!STATELESS.has(name))
    .filter(name=>blocks.has(name)).sort()
console.log(`  (${RESTORABLE.length} registered node classes: ${RESTORABLE.join(", ")})`)
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
/* Said out loud on purpose: an empty serializeState added to "satisfy" a linter
   would hide the fact that nothing needs saving. */
for(const name of STATELESS){
    test(`${name} has no state, and that is correct`,()=>{
        ok(!reaches(name,"serializeState"),`${name} grew a state it has no setting for`)
        ok(!reaches(name,"restoreState"),`${name} grew a restore for a state it does not have`)
    })
}

console.log(`\n${passed} passed, ${failures.length} failed`)
if(failures.length){
    process.exit(1)
}
