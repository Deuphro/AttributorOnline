/* -------------------------------------------------------------------------
   Test — node scripts/collectionReader.test.mjs

   The collection reader's decisions are PURE functions of a formula: how a
   notation is drawn, which molecule a formula belongs to, which formula a
   measured point belongs to. Those are the three places where being wrong is
   invisible — a subscripted mass number still looks like chemistry, a group
   that splits one molecule in two still lists every formula, and a point
   attached to the least-bad formula still shows a plausible error.

   So they are tested against the real engine, on the real classes, with the
   periodic table loaded from data/elements.json — the same oracle
   stoichiometry.test.mjs uses. The functions are read out of interface.js as
   TEXT and evaluated here, because that file needs a DOM and d3 to import;
   this way the code under test is the code that ships, not a copy of it.
   ------------------------------------------------------------------------- */
import {readFileSync} from "fs"
import {Element,Formula,FormulaCollection,nearestByMz,nearestTarget} from "./chemistry.js"

const TABLE=Element.load(JSON.parse(
    readFileSync(new URL("../data/elements.json",import.meta.url),"utf8")))

/* The DISPLAY helpers are lifted out of interface.js as TEXT.

   They cannot be imported — that file needs a DOM and d3 — but they are the
   code that ships, and a copy in a test is a copy that stops being true the
   first time the original changes. The slice runs between two anchors, and BOTH
   are verified: an anchor that silently fails to match would slice to the end
   of the file and hand `new Function` a module with an `export` in it.

   The start anchor is the COMMENT above the first helper, not the helper
   itself: formatCount, formatValue and formatMz are declared before
   SUBSCRIPTS, so starting the slice at the constants would leave them out and
   the evaluation would fail on a name that plainly exists in the file. */
const source=readFileSync(new URL("./interface.js",import.meta.url),"utf8")
const helpersStart=source.indexOf("//\"1 234 567\" — the counts here reach six digits")
const helpersEnd=source.indexOf("class FormulaCollectionNode extends NodeWithAccordionGraph")
if(helpersStart<0||helpersEnd<helpersStart){
    console.error("the helper block could not be located in interface.js - the test cannot run")
    process.exit(1)
}
const helpersSource=source.slice(helpersStart,helpersEnd)
if(!helpersSource.includes("function prettyNotation")){
    console.error("the helper slice is incomplete - the test cannot run")
    process.exit(1)
}
const helpers=new Function(`${helpersSource}
    return {prettyNotation,formatCount,formatValue,formatMz,FORMULA_SORTS,formulaComparator}`
)()
const {prettyNotation,formatCount,formatValue,formatMz,FORMULA_SORTS,formulaComparator}=helpers

/* moleculeKey is a GETTER on Stoichiometry now, not a free function in the
   interface: it is a fact about a formula, and a fact about a formula belongs
   to the class that holds formulas. The alias keeps the test bodies readable
   and makes the move visible in one place. */
const moleculeKey=(node)=>node.moleculeKey

let passed=0
const failures=[]
const test=(name,fn)=>{
    try{ fn(); passed++; console.log(`  ok   ${name}`) }
    catch(e){ failures.push(name); console.log(`  FAIL ${name}\n       ${e.message}`) }
}
const ok=(value,msg)=>{ if(!value) throw new Error(msg??`expected a truthy value, got ${value}`) }
const eq=(a,b,msg)=>{ if(a!==b) throw new Error(`${msg??`${a} != ${b}`}`) }
const close=(a,b,tol,msg)=>{ if(!(Math.abs(a-b)<=tol)) throw new Error(`${msg??`${a} vs ${b}`}`) }
const parse=(text)=>Formula.parse(text,TABLE)

console.log("the notation is drawn, not altered")
test("the counts go down and the charge goes up",()=>{
    eq(prettyNotation("C6H12O6"),"C₆H₁₂O₆")
    eq(prettyNotation("C6H12O6[H+]"),"C₆H₁₂O₆H⁺")
    eq(prettyNotation("C6H12O6[H-]"),"C₆H₁₂O₆H⁻")
})
test("a mass number stays on the baseline",()=>{
    /* The whole point of the rule. "12C6" written ₁₂C₆ would read as twelve
       atoms of a mass number, and the two notations would look alike while
       meaning different things. */
    eq(prettyNotation("12C6 1H12 16O6"),"12C₆ 1H₁₂ 16O₆")
    const first=prettyNotation("12C6 1H12 16O6").split(" ")[0]
    ok(first.startsWith("12"),`the 12 of a mass number must not be subscripted, got "${first}"`)
})
test("a count of one is not written at all",()=>{
    eq(prettyNotation("CH4"),"CH₄")
    eq(prettyNotation("CO2"),"CO₂")
})
test("a signed charge of two is written whole",()=>{
    eq(prettyNotation("SO4[2-]"),"SO₄²⁻")
})
test("the notation round-trips: what is drawn is what was read",()=>{
    /* A display that changes the string is a display that lies, because the
       string is what a chemist copies into a search box. Brackets are dropped
       by the drawing, so the comparison is on the composition alone — that is
       the part the drawing must preserve. */
    const restore=(drawn)=>drawn
        .replace(/[₀-₉]/g,d=>"0123456789"["₀₁₂₃₄₅₆₇₈₉".indexOf(d)])
        .replace(/⁺/g,"+").replace(/⁻/g,"-")
        .replace(/[⁰¹²³⁴-⁹]/g,d=>"0123456789"["⁰¹²³⁴⁵⁶⁷⁸⁹".indexOf(d)])
    for(const text of ["C6H12O6","12C6 1H12 16O6","C2H5OH"]){
        const bare=text.replace(/\[.*?\]/g,"").replace(/\s+/g,"")
        eq(restore(prettyNotation(text)).replace(/\s+/g,""),bare,
            `"${text}" does not read back from what is drawn`)
    }
})

console.log("a molecule is what a formula belongs to, isotopes forgotten")
test("two isotopologues share one molecule",()=>{
    const light=parse("12C6 1H12 16O6")
    const heavy=parse("12C5 13C 1H12 16O6")
    eq(moleculeKey(light),moleculeKey(heavy),
        "a 13C is the same molecule written differently")
})
test("a different molecule is a different key",()=>{
    ok(moleculeKey(parse("C6H12O6"))!==moleculeKey(parse("C5H10O5")),
        "two compositions must never share a key")
})
test("the order of the elements does not make a new molecule",()=>{
    eq(moleculeKey(parse("C2H5OH")),moleculeKey(parse("H6C2O")),
        "the same composition must give one spelling, whatever the input order")
})
test("the charge is part of the identity",()=>{
    /* C6H12O6[H+] and C6H12O6 are two different IONS, and folding them under
       one row would claim that the protonated and the neutral form were the
       same measured thing. */
    ok(moleculeKey(parse("C6H12O6[H+]"))!==moleculeKey(parse("C6H12O6")),
        "a charged and a neutral formula are not one molecule")
})
test("the key still separates them, and it is not what is grouped on",()=>{
    const light=parse("12C6 1H12 16O6")
    const heavy=parse("12C5 13C 1H12 16O6")
    ok(light.key!==heavy.key,"the keys must differ, that is their job")
    eq(moleculeKey(light),moleculeKey(heavy),"and yet they are one molecule")
})
test("a root groups the same way as a leaf",()=>{
    /* The engine's own graph: a leaf knows its root without being told, so the
       fold needs no parent pointer and no second table of families. */
    const leaf=parse("12C6 1H12 16O6").isotopologue("C",13)
    eq(moleculeKey(leaf.root),moleculeKey(leaf),
        "a leaf and its root must land in the same group")
})
test("a whole isotopologue family folds into ONE row",()=>{
    /* The promise of "fold to stoichiometry", measured: the 2548 leaves of
       glucose are 2548 formulas and ONE molecule. The family is enumerated
       rather than walked: `leaves()` follows parent links, and a parsed
       formula has none — it is a root with no children until something is
       derived from it. */
    const leaves=[...parse("C6H12O6").isotopologues({ratio:0,limit:Infinity})]
    eq(leaves.length,2548,"the oracle: glucose has 2548 isotopologues")
    eq(new Set(leaves.map(moleculeKey)).size,1,
        "and they must all fold under a single molecule")
})

console.log("a measured point belongs to the closest formula, or to none")
/* The pairing, on a table of real formulas. `sorted` is what the node passes:
   ascending by m/z, which is the precondition the binary search needs. */
const table=["C6H12O6","C5H10O5","C4H8O4","C3H6O3","C2H4O2"].map(parse)
const entries=[...table].sort((a,b)=>a.mz-b.mz).map(f=>({key:f.key,mz:f.mz}))
test("a point on a formula is given to that formula",()=>{
    for(const formula of table){
        eq(nearestByMz(entries,formula.mz,5).key,formula.key,
            `a point exactly on ${formula} found the wrong row`)
    }
})
test("a point slightly off stays with its formula",()=>{
    const glucose=table[0]
    const shifted=glucose.mz*(1+2e-6)   // 2 ppm, well inside the window
    eq(nearestByMz(entries,shifted,5).key,glucose.key)
})
test("a point far from everything is assigned to NOTHING",()=>{
    /* The failure this guards is the expensive one: attaching a stray point to
       the least-bad formula invents a measurement, and the row would then show
       an error and an intensity that nobody measured. */
    eq(nearestByMz(entries,table[0].mz+0.5,5),null,
        "a point 0.5 Da away must not be attached to any formula")
})
test("the window decides, and it is the user's to set",()=>{
    const shifted=table[0].mz*(1+2e-6)
    ok(nearestByMz(entries,shifted,5)!==null,"2 ppm is inside a 5 ppm window")
    eq(nearestByMz(entries,shifted,1),null,"and outside a 1 ppm one")
})
test("the closest wins, not the first one encountered",()=>{
    /* Two formulas a couple of ppm apart, and a point between them: the answer
       must not depend on the order of the array. */
    const pair=[{key:"a",mz:table[0].mz},{key:"b",mz:table[0].mz*1.000002}].sort((x,y)=>x.mz-y.mz)
    const point=(pair[0].mz+pair[1].mz)/2
    eq(nearestByMz(pair,point,5).key,nearestByMz([...pair].reverse(),point,5).key,
        "the pairing must not depend on the order of the array")
})
test("an empty collection matches nothing",()=>{
    eq(nearestByMz([],181.07,5),null)
})
test("the row shows the target closest in ppm",()=>{
    eq(nearestTarget([{errorPpm:12},{errorPpm:-0.4},{errorPpm:3}]).errorPpm,-0.4)
})
test("a formula with no target has none to show",()=>{
    eq(nearestTarget([]),null,"an unmeasured formula must not borrow a target")
})

console.log("the numbers are drawn at a width a column can hold")
test("the counts are grouped by thousands",()=>{
    eq(formatCount(1234567),"1 234 567")
    eq(formatCount(225),"225")
})
test("an intensity keeps six significant figures",()=>{
    eq(formatValue(41676.4),"41676.4")
    ok(formatValue(0.0000123).includes("e"),"a tiny intensity is written as an exponent")
    eq(formatValue(NaN),"—","and a missing one says so")
})
test("an m/z keeps four decimals",()=>{
    eq(formatMz(181.0706643),"181.0707")
    eq(formatMz(undefined),"—")
})
test("every order calls two identical rows equal",()=>{
    /* A comparator that never returns 0 makes the sort engine's tie-breakers
       unreachable, and the row under the cursor then moves between two paints
       of the very same list. */
    const row={mz:100,notation:"C",intensity:5,errorPpm:1}
    for(const [name,sort] of Object.entries(FORMULA_SORTS)){
        eq(sort.compare(row,{...row}),0,`${name} must call two identical rows equal`)
    }
})
test("the comparator is a FUNCTION, and it actually sorts",()=>{
    /* This is the test that was missing, and its absence is why a list stayed
       empty for two rounds of debugging. FORMULA_SORTS entries are OBJECTS
       ({label, compare}); calling one threw "sort is not a function", so the
       list never rendered and the exception only surfaced when a stale row was
       clicked. Checking that `compare` EXISTS is not the same as checking that
       the thing the list calls can be called. */
    const rows=[
        {key:"b",notation:"CH4",mz:16,mass:16,intensity:1,errorPpm:3},
        {key:"a",notation:"C6H12O6",mz:180,intensity:9,errorPpm:1},
        {key:"c",notation:"C",mz:12,intensity:5,errorPpm:9}
    ]
    for(const name of Object.keys(FORMULA_SORTS)){
        const comparator=formulaComparator(name)
        eq(typeof comparator,"function",`${name} must hand back a function`)
        const sorted=[...rows].sort(comparator)
        eq(sorted.length,3,`${name} must keep every row`)
    }
    /* b = CH4 @16, a = C6H12O6 @180, c = C @12.
       The expected orders are computed from those numbers, not written from
       memory — the first version of this test asserted "cab" for m/z and was
       wrong, which is the point of having it. */
    eq([...rows].sort(formulaComparator("mz")).map(r=>r.key).join(""),"cba",
        "m/z ascending: 12, 16, 180")
    eq([...rows].sort(formulaComparator("intensity")).map(r=>r.key).join(""),"acb",
        "intensity descending: 9, 5, 1")
    eq([...rows].sort(formulaComparator("error")).map(r=>r.key).join(""),"abc",
        "smallest error first: 1, 3, 9")
    eq([...rows].sort(formulaComparator("notation")).map(r=>r.key).join(""),"cab",
        "notation A-Z: \"C\" < \"C6H12O6\" < \"CH4\"")
})
test("an order this build does not know falls back to m/z",()=>{
    /* The order is a display choice that travels in a session file. A file
       written by another build must not be able to blank the list — and a name
       that happens to exist on Object.prototype must not hand back something
       callable that sorts by accident. */
    for(const name of ["","nope","constructor","toString",null,undefined,42]){
        const sorted=[...[
            {key:"b",notation:"CH4",mz:16,intensity:1,errorPpm:3},
            {key:"a",notation:"C6H12O6",mz:180,intensity:9,errorPpm:1}
        ]].sort(formulaComparator(name))
        eq(sorted.map(r=>r.key).join(""),"ba",`"${name}" must fall back to m/z, not throw`)
    }
})
test("rows of equal m/z keep a stable order, by key",()=>{
    /* Two isotopologues of nothing in particular at the same mass: without the
       key tail, their order would depend on the sort engine's internals and
       could change between two paints of the same list. */
    const tie=[{key:"z",notation:"A",mz:100},{key:"a",notation:"B",mz:100}]
    eq([...tie].sort(formulaComparator("notation")).map(r=>r.key).join(""),"za",
        "the chosen order wins first...")
    eq([...tie].sort(formulaComparator("mz")).map(r=>r.key).join(""),"az",
        "...and the key settles the tie")
})

console.log("la collection: une formule n'y entre qu'une fois")
const collection=()=>new FormulaCollection({name:"test",table:TABLE,ppm:5})
test("a string is read, and the same string twice is ONE formula",()=>{
    const c=collection()
    c.add("C6H12O6")
    c.add("C6H12O6")
    eq(c.size,1,"`key` is the identity, so a duplicate is not a second row")
})
test("a different writing of the same formula is still one formula",()=>{
    const c=collection()
    c.add("C6H12O6")
    c.add(parse("12C6 1H12 16O6"))
    eq(c.size,1,"`key` never abbreviates, so both writings have the same key")
})
test("an unreadable string is a diagnostic, and the rest survives",()=>{
    const c=collection()
    c.add("C6H12O6")
    c.add("Xx6H12O6")
    eq(c.size,1,"one typo must not take the collection down with it")
    ok(c.diagnostics.length>0,"and it must be said out loud")
})
test("no table means no reading, and it says so",()=>{
    const c=new FormulaCollection({name:"test"})
    eq(c.add("C6H12O6"),null)
    ok(c.diagnostics[0].includes("no table"),"the missing table must be named")
})
test("removing a formula removes exactly one",()=>{
    const c=collection()
    c.add("C6H12O6")
    c.add("C5H10O5")
    ok(c.remove(parse("C6H12O6").key))
    eq(c.size,1)
    ok(!c.remove("not a key"),"removing what is not there says so")
})

console.log("la collection: l'appariement, par la classe")
test("a point lands on its formula, and the error is in ppm",()=>{
    const c=collection()
    c.add("C6H12O6")
    const glucose=c.entries[0]
    const mz=glucose.mz*(1+3e-6)   // 3 ppm
    c.setPoints([{mz,intensity:41676.4}])
    eq(glucose.targets.length,1)
    close(glucose.errorPpm,3,0.01,"the error is measured on the m/z")
    eq(glucose.intensity,41676.4)
})
test("a point naming its formula is taken at its word",()=>{
    const c=collection()
    c.add("C6H12O6")
    c.add("C5H10O5")
    //far outside the window: proximity would refuse it, the explicit key does not
    c.setPoints([{key:parse("C5H10O5").key,mz:1000,intensity:1}])
    eq(c.entries[1].targets.length,1,"the named formula took it")
    eq(c.entries[0].targets.length,0,"and the other one did not")
})
test("a formula added AFTER the points still claims them",()=>{
    /* match() runs on every add, which is what makes the order of two
       operations stop deciding what the collection contains. */
    const c=collection()
    c.setPoints([{mz:parse("C6H12O6").mz,intensity:7}])
    const entry=c.add("C6H12O6")
    eq(entry.targets.length,1,"the late formula found the point that was waiting")
})
test("a point too far away is attributed to nobody",()=>{
    const c=collection()
    c.add("C6H12O6")
    c.setPoints([{mz:c.entries[0].mz+0.5,intensity:1}])
    eq(c.entries[0].targets.length,0,"a stray point must not be attached")
    ok(c.diagnostics.some(d=>d.includes("matches no formula")),"and it must be reported")
})
test("a family of 2548 isotopologues pairs in one pass",()=>{
    /* The shape the node actually has to survive: a real collection, big
       enough that a linear pairing would be felt.

       isotopologues() yields RECORDS (rank, mz, notation, logProbability), not
       Formula objects — they are the search results, not the graph. So each one
       is re-read through the parser, which is also what a producer node would
       have to do to publish them. */
    const c=collection()
    const records=[...parse("C6H12O6").isotopologues({ratio:0,limit:Infinity})]
    for(const record of records) c.add(record.notation)
    eq(c.size,2548)
    eq(new Set(c.entries.map(e=>e.molecule)).size,1,"one molecule")
    c.setPoints(c.entries.map(e=>({mz:e.mz,intensity:1})))
    eq(c.entries.filter(e=>e.targets.length).length,2548,"every one found its point")
})
test("the descriptor round-trips through the table",()=>{
    /* Two DIFFERENT formulas, on purpose: a 13C is a different composition,
       hence a different key, and the descriptor has to keep both apart. */
    const c=collection()
    c.add("C6H12O6")
    c.add("12C5 13C 1H12 16O6")
    const back=FormulaCollection.fromDescriptor(c.toDescriptor(),{table:TABLE})
    eq(back.size,2,"both formulas came back")
    /* Joined, not compared as arrays: `eq` is an identity test, and two arrays
       holding the same two strings are two different objects. A test that
       fails for that reason gets deleted instead of fixed, so it is compared
       the way it means. */
    eq(back.entries.map(e=>e.key).join(" | "),c.entries.map(e=>e.key).join(" | "),
        "with the very same keys")
    eq(back.entries[1].molecule,c.entries[0].molecule,
        "and they still fold under ONE molecule, which is the whole point of keeping the root")
})
test("a group adduct round-trips through the TEXT, not through the key",()=>{
    /* The engine defect this pins down. `key` for C6H12O6[H+] is
       12C6 1H13 16O6[H+]: the adduct's hydrogen is counted once in the
       composition and once in the brackets, so re-reading it yields H14. The
       collection therefore stores the text it was given, which does come back
       identical — and the fact that it works that way is recorded here so the
       day `key` is fixed, this test is the one that has to change. */
    const c=collection()
    c.add("C6H12O6 [H+]")
    const back=FormulaCollection.fromDescriptor(c.toDescriptor(),{table:TABLE})
    eq(back.size,1)
    eq(back.entries[0].key,c.entries[0].key,"the text round-trips exactly")
    eq(back.diagnostics.length,0,"and nothing is reported")
})
test("a key that does not read back is REPORTED, not swallowed",()=>{
    /* The guard stays, and it stays honest: a descriptor is DATA FROM
       ELSEWHERE, so a key it carries may not be a key this engine writes. When
       they disagree, the row would otherwise show the m/z of a different
       molecule with no word about it.

       Ce test utilisait autrefois la clé d'un adduit protoné, parce que cette
       clé ne se relisait pas — la clé était le défaut. La clé n'est plus le
       défaut, et le garde-fou doit être éprouvé avec une clé qui ne vient
       D'ICI: un nom de fantôme, que rien dans le moteur ne produit. */
    const descriptor={name:"t",formulas:[{key:"CH4;H+",notation:"C2H6"}]}
    const back=FormulaCollection.fromDescriptor(descriptor,{table:TABLE})
    ok(back.diagnostics.some(d=>d.includes("not re-readable")),
        `the mismatch must be named, got ${JSON.stringify(back.diagnostics)}`)
})
test("une clé SAINE ne déclenche aucun diagnostic",()=>{
    /* Le contre-pied du précédent: sans cela, un garde-fou qui hurle sur une
       clé parfaitement relisible finirait par être ignoré, et c'est justement
       le moment où il matteredait qu'on lise le message. */
    const c=collection()
    c.add("C6H12O6 [H+]")
    c.add("CH4;H+")
    c.add("C2H5OH")
    const back=FormulaCollection.fromDescriptor(c.toDescriptor(),{table:TABLE})
    eq(back.diagnostics.length,0,"a descriptor we wrote must come back clean")
    eq(back.size,c.size,"and every formula must have survived")
})
test("a descriptor without a table says so instead of lying",()=>{
    const c=collection()
    c.add("C6H12O6")
    const back=FormulaCollection.fromDescriptor(c.toDescriptor(),{table:null})
    eq(back.size,0,"nothing can be re-read without masses")
    ok(back.diagnostics.length>0,"and it must say why")
})
test("toPairs is sorted, which is what a stick plot needs",()=>{
    const c=collection()
    c.add("C5H10O5")
    c.add("C6H12O6")
    //1 ppm, INSIDE the 5 ppm window: at 100 ppm both points would match nothing
    c.setPoints(c.entries.map(e=>({mz:e.mz*(1+1e-6),intensity:2})))
    const pairs=c.toPairs()
    eq(pairs.length,2)
    ok(pairs[0][0]<pairs[1][0],"left to right, without a jump")
})

console.log("le chemin du nœud: des textes tapés vers une collection comptée")
/* The node does not store Formula objects, it stores the TEXTS the user typed
   and re-reads them at every resolve. This walks the same operations it walks,
   through the same class, so the count the user watches going from 0 to 1 is
   the count asserted on here. */
const buildLocals=(locals)=>locals.map(local=>{
    const c=new FormulaCollection({name:local.name,table:TABLE,ppm:5})
    c.local=true
    // `keys` is a getter on the class and the node keeps its own list beside
    // it — so the test does too, and reads the count off the class
    c.typed=local.keys
    for(const text of local.keys) c.add(text)
    return c
})
test("a typed formula lands, and the collection counts it",()=>{
    const locals=[{name:"Formules",keys:[]}]
    const collections=buildLocals(locals)
    eq(collections[0].size,0,"it starts empty")
    // exactly what the node does on Enter
    const typed="C"
    locals[0].keys.push(typed)
    const entry=collections[0].add(typed)
    ok(entry,"the formula was accepted")
    eq(collections[0].size,1,"and the count moved")
})
test("retyping the same formula does not inflate the count",()=>{
    const locals=[{name:"Formules",keys:["C"]}]
    const collections=buildLocals(locals)
    // the node answers "already in the list" BEFORE touching the collection
    const typed="C"
    if(!locals[0].keys.includes(typed)) locals[0].keys.push(typed)
    collections[0].add(typed)
    eq(collections[0].size,1,"one formula, one row")
})
test("a session of typed formulas survives a re-read",()=>{
    /* The restore path: keys in, formulas out, same count. This is the test
       that would have caught the double-counted adduct, and it is the one that
       matters for a session the user comes back to. */
    const locals=[{name:"Formules",keys:["C","CH4","C6H12O6","C6H12O6[H+]"]}]
    const collections=buildLocals(locals)
    eq(collections[0].size,4)
    const again=buildLocals(locals)
    eq(again[0].keys.join("|"),collections[0].keys.join("|"),
        "and the keys come back in the order they were typed")
    eq(again[0].size,4,"with the same count")
})

console.log(`\n${passed} passed, ${failures.length} failed`)
if(failures.length){
    process.exit(1)
}

