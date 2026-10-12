/* -------------------------------------------------------------------------
    Helper — scripts/nodeSource.mjs

    The tests below used to read `scripts/interface.js` as TEXT and slice class
    bodies out of it. The refactor that split interface.js into nodes/*.js,
    core/index.js, flow/Flow.js and ui/*.js deleted that file, and every one of
    those tests died on ENOENT — including the guard that catches a node missing
    a half of its serializeState/restoreState pair.

    The contract they check did not go anywhere: only the file moved. So this
    reads the modules the refactor actually produced and hands back the same two
    things the tests used to build for themselves.

    TWO SHAPES, and the difference matters:

      blocks / parents — parsed PER FILE. A class is bounded by the next class in
        its own module or by the END OF THAT MODULE. Concatenating first and
        parsing once would let the last class of nodes/ChatNode.js swallow the
        whole header of the next file, and `defines()` would then report methods
        a class does not have.

      source — every file concatenated, for the tests that grep prose rather
        than walk classes. A `case "TrimmerNode"` or a `const NODE_CONSTRUCTORS`
        has no class body to belong to.
   ------------------------------------------------------------------------- */
import {readFileSync} from "fs"
import {fileURLToPath} from "url"
import {dirname, join} from "path"

const here=dirname(fileURLToPath(import.meta.url))

/* Every module a node class or a node-facing helper can live in. Kept explicit
   rather than globbed: a glob would quietly widen the contract the moment
   somebody adds a file, and these tests exist precisely to fail when a place
   they did not think of starts mattering. */
export const NODE_SOURCE_FILES=[
    "core/index.js",
    "flow/Flow.js",
    "flow/MainFlowMenu.js",
    "flow/Menu.js",
    "ui/Dialog.js",
    "ui/Plot2D.js",
    "nodes/NodeWithAccordionGraph.js",
    "nodes/NodeWithRightAccordionGraph.js",
    "nodes/AttributionForestMethods.js",
    "nodes/DelimitedTextNode.js",
    "nodes/ThermoRawNode.js",
    "nodes/TrimmerNode.js",
    "nodes/FKMDNode.js",
    "nodes/AttributionNode.js",
    "nodes/PeakPickingNode.js",
    "nodes/CalibrationNode.js",
    "nodes/FormulaCollectionNode.js",
    "nodes/SimpleXYPlotNode.js",
    "nodes/ChatNode.js",
    "utils/index.js",
    "app/registerNodeTypes.js"
]

/* `export class X` and `class X` both count, and both carry an optional
   `extends Y`. Anchored on ^ so a class named in a comment never becomes a
   block of its own. */
function classStarts(text){
    return [...text.matchAll(/^(?:export\s+)?class\s+(\w+)(?:\s+extends\s+(\w+))?[^{]*\{/gm)]
}

/* The class body is bounded by its MATCHING brace, not by the next `class`
   keyword.

   This is not a detail. CalibrationNode.js:57 declares SimpleOrbitControls
   inside the body of a method — a class declaration in a block position is
   legal JavaScript, and the file is valid — so the naive "next class starts
   here" boundary cut CalibrationNode's own body off after 48 lines and
   reported that a node with serializeState had none. It is a parser artefact
   rather than a bug in the node, and brace counting is what tells the two
   apart.

   Braces inside strings and comments are not counted. These files hold
   template literals and regular expressions containing `{`, so a pure counter
   can land early; the count is therefore checked against the next real class
   start, and the earlier of the two boundaries wins. */
function classBody(text,start){
    let depth=0
    for(let i=start;i<text.length;i++){
        const character=text[i]
        /* Skip what is not code. These files hold "ws://" in string literals,
           template literals built from expressions, and regular expressions —
           and every one of them can carry a brace that a raw counter would
           count, landing the boundary early and cutting the class in half. A
           regex is told apart from division by what came before it; where that
           cannot be settled the character is counted, which is the same guess a
           bracket matcher makes and is wrong only on a `}` inside a regex. */
        if(character==="/"&&text[i+1]==="/"){
            i=text.indexOf("\n",i)
            if(i<0) break
            continue
        }
        if(character==="/"&&text[i+1]==="*"){
            i=text.indexOf("*/",i+2)
            if(i<0) break
            i++
            continue
        }
        if(character==="\""||character==="'"||character==="`"){
            i=skipString(text,i,character)
            continue
        }
        if(character==="{") depth++
        else if(character==="}"){
            depth--
            if(depth===0) return text.slice(start,i+1)
        }
    }
    return text.slice(start)
}

/* The index of the quote that CLOSES the one at `from`. Handles the escapes;
   a template literal's ${…} is walked by depth so a backtick nested inside an
   interpolation does not end the string early. */
function skipString(text,from,quote){
    let i=from+1
    while(i<text.length){
        const character=text[i]
        if(character==="\\"){
            i+=2
            continue
        }
        if(quote==="`"&&character==="$"&&text[i+1]==="{"){
            let depth=1
            i+=2
            while(i<text.length&&depth>0){
                if(text[i]==="{") depth++
                else if(text[i]==="}") depth--
                i++
            }
            continue
        }
        if(character===quote) return i
        i++
    }
    return i
}

function classBlocks(text){
    return classStarts(text).map(match=>({
        name:match[1],
        parent:match[2]??null,
        body:classBody(text,match.index)
    }))
}

function readHere(relative){
    return readFileSync(join(here,relative),"utf8")
}

const files=NODE_SOURCE_FILES.map(relative=>({relative,text:readHere(relative)}))

/* A class name appearing twice would be one of two bugs: a copy-pasted class,
   or a module listed twice above. Either way the later block would silently
   shadow the earlier one and the inheritance walk would answer from the wrong
   body. Counted here rather than left to the Map below, which would swallow it
   without a word. */
const declarations=files.flatMap(({relative,text})=>
    classBlocks(text).map(block=>block.name))
const declarationCounts=new Map()
for(const name of declarations){
    declarationCounts.set(name,(declarationCounts.get(name)??0)+1)
}
export const DUPLICATE_CLASSES=[...declarationCounts]
    .filter(([,count])=>count>1)
    .map(([name])=>name)

export const blocks=new Map()
export const parents=new Map()
for(const {relative,text} of files){
    for(const block of classBlocks(text)){
        blocks.set(block.name,block.body)
        parents.set(block.name,block.parent)
    }
}

/* Concatenated with a newline separator, so a regex anchored on ^ cannot match
   across the seam between two files. */
export const source=files.map(({text})=>text).join("\n")

/* The text from an opening bracket to the bracket MATCHING it. The depth counter
   is what makes the walk safe: it counts BOTH kinds of bracket, so a nested
   array inside an object literal (or a call inside a Set) cannot end the block
   early — which is how a walker that stops at the first balanced pair returned
   "[]" for a list that plainly had entries. */
export function balancedObject(text,open){
    if(open<0) return null
    let depth=0
    for(let i=open;i<text.length;i++){
        const character=text[i]
        if(character==="{"||character==="[") depth++
        else if(character==="}"||character==="]"){
            depth--
            if(depth===0) return text.slice(open,i+1)
        }
    }
    return null
}

/* The body of `const NAME = { … }` or `const NAME = new Set([ … ])`. */
export function constBlock(name,text=source){
    const start=text.search(new RegExp(`const\\s+${name}\\s*=`))
    if(start<0) return null
    const opener=text.indexOf("{",start)
    const bracket=text.indexOf("[",start)
    return balancedObject(text,(opener>=0&&(bracket<0||opener<bracket))?opener:bracket)
}

/* ONLY block comments are stripped, and that is a deliberate limit. A `//`
   stripper runs to the end of the line from the first "//" it sees, and these
   files hold "ws://" and "http://" inside string literals — it would delete the
   very declaration a test is looking for. Telling a `//` in a string from a
   line comment needs a real parser, so what is left is one honest limitation:
   a `//` comment between a declaration and its code can hide that code. */
export const stripComments=(text)=>text.replace(/\/\*[\s\S]*?\*\//g,"")

/* A DEFINITION, not a mention: four spaces, then the name, then the parens —
   the file's own indentation for a class member. A comment line cannot look
   like that, so a comment naming serializeState cannot make a class look like it
   implements it. */
export const defines=(body,name)=>new RegExp(`^ {4}${name}\\(`,"m").test(body??"")

/* A node type is often a thin subclass that inherits its state, so "does this
   class save anything" is a question about the WHOLE chain. */
export function reaches(name,method,seen=new Set()){
    if(seen.has(name)) return false
    seen.add(name)
    if(defines(blocks.get(name),method)) return true
    const parent=parents.get(name)
    return parent?reaches(parent,method,seen):false
}