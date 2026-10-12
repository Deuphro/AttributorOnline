/* -------------------------------------------------------------------------
   Test â€” node scripts/nodeWiring.test.mjs

   Every node type has to be named in FOUR places, and this file exists because
   the codebase already got that wrong once: the comment above
   NODE_CONSTRUCTORS says so â€” "a type added to one and forgotten in the other
   would come back as a bare Node with no inputs at all, silently".

   It cannot RUN the node classes â€” they need d3 and a real DOM â€” so it reads
   them as TEXT, exactly as nodeState.test.mjs does, and checks the contract
   instead. That is a cheap guard against the whole family of bug; it is not a
   replacement for clicking the thing.

   It used to read interface.js. The refactor split that file and deleted it,
   which killed this test on ENOENT â€” so did the guards inside it. The modules
   that replaced it are read through scripts/nodeSource.mjs now.
   ------------------------------------------------------------------------- */
import {readFileSync} from "fs"
import {fileURLToPath} from "url"
import {dirname, join} from "path"
import {blocks,parents,source,balancedObject,stripComments,defines,reaches} from "./nodeSource.mjs"

const here=dirname(fileURLToPath(import.meta.url))
const config=readFileSync(join(here,"../resources/config.js"),"utf8")
const css=readFileSync(join(here,"../styles/main.css"),"utf8")

let passed=0
const failures=[]
const test=(name,fn)=>{
    try{ fn(); passed++; console.log(`  ok   ${name}`) }
    catch(e){ failures.push(name); console.log(`  FAIL ${name}\n       ${e.message}`) }
}
const ok=(value,msg)=>{ if(!value) throw new Error(msg??"expected a truthy value") }

/* constBlock, stripComments, defines and reaches all live in nodeSource.mjs
   now: nodeState.test.mjs needed the same four, and two copies of a bracket
   counter is two chances for one of them to be the wrong one. */

/* The two registration lists, read as sets rather than as prose.

   BOTH SHAPES, because the code does not use one: NODE_CONSTRUCTORS is filled
   with Object.assign over a plain object literal (it carries the legacy
   aliases) while SELF_SHAPED_NODES is filled from an array literal.

   BOTH ARE FILLED IN registerNodeTypes.js, not declared there. utils/index.js
   only owns the two empty containers, because the node classes import the core
   and the core imports buildNode: putting the classes in the same file would be
   a cycle. Reading the declarations therefore found `{}` and `new Set([])` —
   an empty list passes "every creatable node class is registered" without
   checking one — and the test then failed for the opposite reason, claiming
   ChatNode was missing. The list that is actually consulted is read here. */
const REGISTERED=readFileSync(join(here,"app/registerNodeTypes.js"),"utf8")
const constructors=bracketedAfter(REGISTERED,"NODE_CONSTRUCTORS")??""
const selfShaped=bracketedAfter(REGISTERED,"SELF_SHAPED_NODES")??""

function bracketedAfter(text,name){
    /* TWO SHAPES, and neither one is `const NAME = { … }`.

       NODE_CONSTRUCTORS is filled IN PLACE:
           Object.assign(NODE_CONSTRUCTORS,{ … })
       The name is the target and the block follows it, so a forward walk finds
       the list on the first try.

       SELF_SHAPED_NODES is filled from a list declared ABOVE the call:
           for(const NodeType of [ … ]) SELF_SHAPED_NODES.add(NodeType)
       The name is the DESTINATION, and there is no bracket after it anywhere —
       the walk forward runs into the `)` of add( and gives up. That is why this
       check spent three passes reporting ChatNode as unregistered while it is
       plainly on the line above the call.

       So the list is found by walking BACK from the call to the `]` that closes
       it, then matching that bracket to its opener. */
    const at=text.lastIndexOf(name)
    const call=text.indexOf(`${name}.add(`,at)
    const close=call<0?-1:text.lastIndexOf("]",call)
    const opener=close<0?-1:matchingOpener(text,close)
    if(opener>=0){
        const block=text.slice(opener,close+1)
        /* A registration list that lost its entries to a mis-aimed walk looks
           exactly like one that was never written, and an empty list makes
           "every name is a real class" pass while checking nothing. So emptiness
           is reported rather than accepted. */
        return /^\s*\[\s*\]\s*$/.test(block)?null:block
    }
    /* In-place fill. The LAST mention of the name, not the first: the first is
       in the import statement, whose `{` opens BEFORE the name, and a forward
       scan from there crosses the end of the import and stops on the `{` of
       `export function registerNodeTypes(){` — returning the whole function body
       and reading the NODE_CONSTRUCTORS entries out of the loop below it. */
    let forward=-1
    for(let i=at;i<text.length;i++){
        if(text[i]==="{"||text[i]==="["){ forward=i; break }
        if(text[i]===")"||text[i]===";") break
    }
    if(forward<0) return null
    return balancedObject(text,forward)
}

/* The index of the bracket that OPENS the one at `close`. A depth counter, so a
   nested array inside the list cannot be mistaken for its own boundary. */
function matchingOpener(text,close){
    let depth=0
    for(let i=close;i>=0;i--){
        if(text[i]==="]") depth++
        else if(text[i]==="["){
            depth--
            if(depth===0) return i
        }
    }
    return -1
}

/* Comments are stripped before any of this is read (stripComments lives in
   nodeSource.mjs).

   Not for tidiness: the comments in utils/index.js DISCUSS these very names
   ("a node that builds its own inputs and outputs takes..."), so a naive word
   scan finds `builds`, `listens` and half the English language in the
   declaration it is trying to check. A test that reads prose as code is worse
   than no test, because it fails for the wrong reason and gets deleted.

   ONLY block comments are stripped, and that is a deliberate limit rather than
   an oversight. A `//` stripper is tempting and wrong here: ChatNode and Dialog
   hold "ws://" and "http://" inside string literals, and a line-comment regex
   runs to the end of the line from the first "//" it sees — which silently
   deleted the whole `this.DOMelt.handler=CE(...)` line and made the tiler look
   absent from a class that plainly carries it.

   Telling a `//` in a string from a real line comment needs a real parser.
   What is left is one honest limitation, stated rather than hidden: a `//`
   comment standing between a declaration and the code it describes can hide
   that code from this test. The tests below therefore also assert on the RAW
   text wherever a `//` comment could plausibly sit in between. */
const constructorsCode=stripComments(constructors)
const selfShapedCode=stripComments(selfShaped)

const isNodeClass=(name)=>{
    let current=name
    const seen=new Set()
    while(current&&!seen.has(current)){
        if(current==="Node") return true
        seen.add(current)
        current=parents.get(current)
    }
    return false
}
//the abstract bases, which the menu never instantiates
const BASES=new Set([
    "Node","Operation","NodeWithAccordion",
    "NodeWithAccordionGraph","NodeWithRightAccordionGraph"
])
const creatable=[...blocks.keys()].filter(n=>isNodeClass(n)&&!BASES.has(n))

console.log("every node class is a name a session can restore")
test("NODE_CONSTRUCTORS lists every creatable node class",()=>{
    for(const name of creatable){
        /* Word-boundary, not a substring: `includes("Node")` would be satisfied
           by NodeWithAccordion, so a class dropped from the list would still
           "pass" whenever a longer name containing it remained. */
        ok(new RegExp(`\\b${name}\\b`).test(constructorsCode),
            `${name} is not in NODE_CONSTRUCTORS: a reload would make it a bare Node`)
    }
})
test("NODE_CONSTRUCTORS names nothing that does not exist",()=>{
    //a stale entry is a name that can never be built, and it hides the fact
    //that the class it used to refer to has been renamed
    for(const match of constructorsCode.matchAll(/"([A-Za-z]\w*)":\s*(\w+)/g)){
        ok(blocks.has(match[2]),`NODE_CONSTRUCTORS maps "${match[1]}" to ${match[2]}, which is not a class`)
    }
})

console.log("a self-shaped node is declared as one")
test("SELF_SHAPED_NODES covers every self-shaped class",()=>{
    /* The rule the file states: a node that builds its own inputs and outputs
       takes (title, app, flow, position) and MUST be in the set. Detecting
       that from text is hard, so the check runs the other way: every NAME in
       the set must be a real class, and ChatNode must be in it.

       The names are taken from the STARTS OF LINES, not from every word. A
       word scan reads the `//` comments inside the declaration — "a node that
       BUILDS its own inputs" — and reports `builds` as a class that does not
       exist, which is a failure about the test's own reading, not about the
       file. Only the entries are on their own lines. */
    /* `\r` is stripped along with the whitespace. The files are checked out
       with CRLF on Windows, and `String.trim()` DOES remove it — but the filter
       runs on the trimmed line, so that part was fine; what broke it was
       splitting on "\n" and testing `^\w+$` against a line that still carried
       the carriage return, which matched nothing. The list came back EMPTY, and
       an empty list makes "every name is a real class" pass while
       `entries.includes("ChatNode")` correctly fails — so the test did notice,
       but it blamed ChatNode rather than the line ending. */
    const entries=selfShapedCode
        .split(/\r?\n/)
        .map(line=>line.trim().replace(/,$/,"").replace(/^\/\/.*$/,""))
        .filter(line=>/^\w+$/.test(line))
    for(const name of entries){
        if(["new","Set"].includes(name)) continue
        ok(blocks.has(name),`SELF_SHAPED_NODES lists ${name}, which is not a class`)
    }
    ok(entries.includes("ChatNode"),
        "ChatNode is self-shaped and must be in SELF_SHAPED_NODES")
})

console.log("the menu can build what it offers")
test("every node type in config.js has a case in createNode",()=>{
    /* config.js dispatches createNode with a "type"; MainFlowMenu switches on
       it. A type in one and not the other is a menu entry that silently does
       nothing â€” the worst kind of broken, because the menu still draws. */
    const types=[...config.matchAll(/type:'(\w+)'/g)].map(m=>m[1])
    ok(types.length>0,"no node types found in config.js")
    for(const type of types){
        ok(new RegExp(`case "${type}"`).test(source),
            `config.js offers type "${type}" but MainFlowMenu has no case for it`)
    }
})
test("the Tools category exists and holds the chat",()=>{
    ok(/"Tools":\{/.test(config),"the Tools category is missing from the flow menu")
    ok(/type:'chat'/.test(config),"the Tools category does not offer the chat")
})

console.log("the chat node is complete")
test("ChatNode exists and extends Node",()=>{
    ok(blocks.has("ChatNode"),"class ChatNode not found")
    ok(parents.get("ChatNode")==="Node",`ChatNode extends ${parents.get("ChatNode")}, expected Node`)
})
test("ChatNode carries no data, so it is never wired into a pipeline",()=>{
    const body=blocks.get("ChatNode")??""
    //no inputs, no outputs in its super() call: a chat that resolved to
    //something would be auto-wired between two filters
    ok(/super\(title,\[\],\[\],/.test(body),"ChatNode must take no inputs and no outputs")
    //and it must not define a startResolve that produces output
    ok(!defines(body,"startResolve"),"ChatNode must not resolve: it has nothing to compute")
})
test("ChatNode saves and restores its state, both halves",()=>{
    ok(reaches("ChatNode","serializeState"),"ChatNode has no serializeState")
    ok(reaches("ChatNode","restoreState"),"ChatNode has no restoreState")
})
test("ChatNode never stores a live socket in its state",()=>{
    const body=stripComments(blocks.get("ChatNode")??"")
    const start=body.indexOf("    serializeState(")
    ok(start>=0,"ChatNode has no serializeState")
    const block=body.slice(start,body.indexOf("\n    }",start))
    /* The comments are stripped FIRST, and that is the point: the method
       explains at length why it does not store the socket, and a raw scan for
       the word would match its own explanation. */
    ok(!/socket/.test(block),`serializeState would store the socket:\n${block}`)
})
test("ChatNode does not reconnect behind the user's back after a reload",()=>{
    /* restoreState fills the fields and stops. If it called connect(), every
       reload would open a socket to a server the user may not even be running,
       and the room list would be the first thing on screen. */
    const body=blocks.get("ChatNode")??""
    const start=body.indexOf("    restoreState(")
    ok(start>=0,"ChatNode has no restoreState")
    const block=body.slice(start,body.indexOf("\n    }",start))
    ok(!/this\.connect\(/.test(block),`restoreState must not connect:\n${block}`)
})
test("ChatNode clears its retry timer when it dies",()=>{
    const body=blocks.get("ChatNode")??""
    const start=body.indexOf("    suicide(")
    ok(start>=0,"ChatNode has no suicide")
    const block=body.slice(start,body.indexOf("super.suicide",start))
    ok(/disconnect\(\)/.test(block),
        "suicide must disconnect: a deleted node with a pending retry becomes a socket nobody can close")
})
test("chat messages are inserted as text, never as markup",()=>{
    /* The prototype uses innerHTML on server-provided text, which would let
       anyone in the room inject markup into this page. Every line drawn from
       the network must go in as a text node — and the comment explaining that
       is stripped first, or it would match the very word it forbids. */
    const body=stripComments(blocks.get("ChatNode")??"")
    const append=body.slice(body.indexOf("    append("),body.indexOf("    setStatus("))
    ok(/textContent=/.test(append),`append must use textContent:\n${append}`)
    ok(!/innerHTML/.test(append),`append must not use innerHTML:\n${append}`)
})

console.log("a field never hides a method")
/* `this.table = null` in a constructor, next to a method `table()`, is a plain
   TypeError waiting to happen: the assignment puts an OWN property on the
   instance that shadows the prototype method, so the next call throws
   "this.table is not a function". It cost a whole node once — and `node --check`
   is perfectly happy with it, because it is valid JavaScript.

   So it is checked as a CONTRACT over every class in the file, not as a memory
   of one incident. The scan is deliberately shallow — methods declared at four
   spaces, which is the file's own indentation for a class member — because a
   deeper walk would start matching object literals and say nothing useful. */
test("no class shadows one of its own methods with a field",()=>{
    for(const [name,body] of blocks){
        for(const match of body.matchAll(/^ {4}([a-zA-Z_$][\w$]*)\(/gm)){
            const method=match[1]
            if(method==="constructor") continue
            const assignment=new RegExp(`this\\.${method}\\s*=[^=]`).test(body)
            ok(!assignment,
                `${name}.${method}() is shadowed: the class also does "this.${method} = ..."`)
        }
    }
})

console.log("the dialog tiler is wired all the way through")
test("Dialog has a tiler between the folder and the dismisser",()=>{
    /* Read from the RAW class body, not the stripped one. The stripper cannot
       tell a `//` in a string from a line comment, and the Dialog constructor
       holds "ws://" further down — so stripping can eat the very line this
       test is about. The trade is accepted knowingly: block comments are NOT
       removed here, which is fine, because the check looks for code tokens
       and a comment that spelled out the whole array would be a bizarre way
       to satisfy it. */
    const raw=blocks.get("Dialog")??""
    const handler=raw.slice(raw.indexOf("this.DOMelt.handler=CE"))
    //the array literal is [label, folder, tiler, dismisser], so the three
    //buttons are comma-separated and the dismisser is the last one
    const at=(needle)=>handler.indexOf(needle)
    const folder=at("this.DOMelt.folder,")
    const tiler=at("this.DOMelt.tiler,")
    const close=at("this.DOMelt.dismisser]")
    ok(folder>=0&&tiler>=0&&close>=0,"the handler does not carry the three buttons")
    ok(folder<tiler&&tiler<close,
        "the yellow tiler must sit BETWEEN the green folder and the red dismisser")
})
test("the handler grid has room for the fourth button",()=>{
    const body=blocks.get("Dialog")??""
    ok(/"grid-template-columns":"1fr 1em 1em 1em"/.test(body),
        "the handler still has three columns: the tiler would overlap the title")
})
test("gridSiblings fills a row before the next",()=>{
    const body=blocks.get("Dialog")??""
    const method=body.slice(body.indexOf("    gridSiblings("))
    //column = index % columns is what makes it fill left to right
    ok(/index%columns/.test(method),"the tiler must advance within the row first")
    ok(/Math\.floor\(index\/columns\)/.test(method),"the tiler must then move down a row")
    //and it picks a squarish grid rather than one single line
    ok(/Math\.sqrt\(/.test(method),"the grid should be the closest thing to a square")
})

console.log("a node click opens its panels")
test("Node.reveal unwraps before it scrolls",()=>{
    const body=blocks.get("Node")??""
    const start=body.indexOf("    reveal(")
    ok(start>=0,"Node has no reveal")
    const method=body.slice(start,body.indexOf("    scrollPanelTo(",start))
    const unfold=method.indexOf("unfold()")
    const scroll=method.indexOf("scrollPanelTo(")
    ok(unfold>=0,"reveal does not unfold")
    ok(scroll>=0,"reveal does not scroll")
    /* unfold BEFORE scroll: the other way round measures a place that is not
       on screen yet, and scrolls to the wrong offset. */
    ok(unfold<scroll,`reveal must unfold before it scrolls (${unfold} vs ${scroll})`)
})
test("the node rect click calls reveal",()=>{
    ok(/\.reveal\(\)/.test(blocks.get("Node")??""),
        "clicking a node does not reveal its panels")
})
test("a selected node keeps its class when the status changes",()=>{
    /* `status` removes its four classes and re-adds one. If `selected` were in
       that list, a node would blink out of the selection every time it
       resolved â€” exactly when the user is looking at it. */
    const body=blocks.get("Node")??""
    const setter=body.slice(body.indexOf("    set status("),body.indexOf("    get status("))
    ok(!/possible=\[[^\]]*'selected'/.test(setter),
        "`selected` must not be one of the status classes")
})

console.log("the flow menu can grow its panel")
test("MainFlowMenu overrides afterToggle",()=>{
    ok(defines(blocks.get("MainFlowMenu")??"","afterToggle"),
        "MainFlowMenu does not override afterToggle")
})
test("the base Menu has an afterToggle to override",()=>{
    ok(defines(blocks.get("Menu")??"","afterToggle"),"Menu has no afterToggle to override")
})
test("the open menu is a body class, and the CSS listens for it",()=>{
    const body=blocks.get("MainFlowMenu")??""
    ok(/classList\.toggle\("menu-open"/.test(body),"the menu-open body class is never set")
    ok(/body\.menu-open/.test(css),"the CSS never reacts to body.menu-open")
})
test("closing the menu outside also gives the room back",()=>{
    /* Every path that closes a menu must undo what opening one did, or the
       top panel stays stretched and the graph stays clipped. */
    const body=blocks.get("Menu")??""
    const handler=body.slice(body.indexOf("this.windowClickHandler="))
    ok(/classList\.remove\("menu-open"\)/.test(handler),"a click outside does not clear menu-open")
    ok(/afterToggle\(\)/.test(handler),"a click outside does not restore the panel height")
})

console.log("the multi-selection is coherent")
test("Flow owns a selection set",()=>{
    const body=blocks.get("Flow")??""
    ok(/this\.selection=new Set\(\)/.test(body),"Flow has no selection set")
})
test("a deleted node leaves the selection, the others stay",()=>{
    /* Deleting one node out of ten is not a reason to lose the other nine, and
       a node that stays selected points at a detached element. */
    const body=blocks.get("Node")??""
    const block=body.slice(body.indexOf("    suicide("))
    ok(/flow\.selection\.delete\(this\)/.test(block),
        "suicide does not drop the dead node from the selection")
    ok(!/selection\.clear\(\)/.test(block),
        "suicide must not clear the whole selection: the other nodes survive")
})
test("a group move is ONE undoable command",()=>{
    /* Ten nodes that moved together must come back with one Ctrl+Z, or the
       gesture is not undoable in any way the user can hold in their head. */
    const body=blocks.get("Node")??""
    const drag=body.slice(body.indexOf("    drag("),body.indexOf("    /* Moves the node and nothing else"))
    ok(/Move \$\{moved\.length\} nodes/.test(drag),
        "dragging a group does not record a single command for the whole group")
})
test("the pattern is taken from the selection, and the menu asks for it",()=>{
    const flow=blocks.get("Flow")??""
    ok(/patternFromSelection\(/.test(flow),"Flow has no patternFromSelection")
    ok(/instantiatePattern\(/.test(flow),"Flow has no instantiatePattern")
    ok(/copySelectionAsPattern/.test(blocks.get("MainFlowMenu")??""),
        "the flow menu does not handle copySelectionAsPattern")
    ok(/pastePattern/.test(blocks.get("MainFlowMenu")??""),
        "the flow menu does not handle pastePattern")
    ok(/copySelectionAsPattern/.test(config),"config.js does not offer to save a pattern")
})
test("a pattern keeps the shape and drops the data",()=>{
    /* nodeRestoreData carries `state` (the settings) and not the resolved
       outputs â€” a pattern is a shape, and a pattern carrying the 2 MB spectrum
       would double the size of every session it was pasted into. */
    const flow=blocks.get("Flow")??""
    const method=flow.slice(flow.indexOf("    patternFromSelection("))
    ok(/nodeRestoreData\(/.test(method),"the pattern does not use nodeRestoreData")
    //the geometry is normalised, or two patterns pasted at the same spot
    //would sit on top of each other
    ok(/x:node\.parameters\.position\.x-minX/.test(method),
        "the pattern does not normalise its origin")
})
test("a pasted pattern is not pinned",()=>{
    /* The pins travel with nodes the user placed by hand. A pattern is being
       placed for the first time, so pinning it would freeze the layout around
       a position nobody chose. */
    const flow=blocks.get("Flow")??""
    const method=flow.slice(flow.indexOf("    instantiatePattern("))
    ok(/node\.parameters\.pinned=false/.test(method),"a pasted node is pinned")
})

console.log("the dialog tiler has a style, or it is invisible")
test("the tiler is not a copy of the dismisser",()=>{
    ok(/\.tiler\{/.test(css),"the .tiler button has no CSS: it would be an unstyled div")
    //and it must be its own colour: the dismisser already means "close"
    const block=css.slice(css.indexOf(".tiler{"),css.indexOf("}",css.indexOf(".tiler{")))
    ok(!/104, 34, 34/.test(block),"the tiler is the same colour as the dismisser")
})
test("the tiler is greyed out where tiling makes no sense",()=>{
    /* Only the CENTRAL panel's windows can be tiled together. A window opened on
       `main` would otherwise tile itself against every other window of the
       whole application, which is what "strange behaviour" was. */
    ok(/\.tiler\.disabled\{/.test(css),"the disabled tiler has no style: it would look clickable")
    ok(/not-allowed/.test(css),"a disabled tiler must not offer a pointer")
    const body=blocks.get("Dialog")??""
    ok(/classList\.add\("disabled"\)/.test(body),
        "the Dialog never disables its tiler")
    ok(/classList\.contains\("disabled"\)/.test(body),
        "a disabled tiler would still act on the click")
    /* and the test must find the central panel the same way the code does */
    ok(/classList\?\.contains\("center"\)/.test(body),
        "the tiler is not gated on the central panel")
})
test("the click is ignored when the tiler is disabled",()=>{
    /* A greyed button that still acts is worse than no button: the guard is in
       the click handler, not only in the class. */
    const body=blocks.get("Dialog")??""
    const handler=body.slice(body.indexOf("this.DOMelt.tiler.handleClick="))
    const grid=handler.indexOf("gridSiblings()")
    ok(grid>=0,"the tiler no longer calls gridSiblings")
    const guard=handler.indexOf('contains("disabled")')
    ok(guard>=0,"the tiler acts even when disabled")
    ok(guard<grid,`the guard must come BEFORE the action (${guard} vs ${grid})`)
})

console.log("")
if(failures.length){
    console.log(`${passed} passed, ${failures.length} failed`)
    process.exit(1)
}
console.log(`${passed} passed, 0 failed`)


