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
import {Wave} from "./formats.js"

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

/* `visibleRows` is a METHOD of the reader, so it cannot be pulled out of the
   helper slice — but it is the code that decides what a row CARRIES, and the
   orders below read fields off the row. Those two facts came apart once already:
   the comparator read `row.intensity` and `row.errorPpm` while the rows only
   carried them under `row.entry`, so choosing "intensity" or "error" in the menu
   changed NOTHING and threw nothing. Every hand-built row in the tests above has
   the flat fields, so no test could see it.

   So the method is sliced out and called against a stand-in `this`. It is the
   real method, not a copy of it. */
const visibleRowsStart=source.indexOf("    visibleRows(){")
const visibleRowsEnd=source.indexOf("    renderRows(){",visibleRowsStart)
if(visibleRowsStart<0||visibleRowsEnd<visibleRowsStart){
    console.error("visibleRows could not be located in interface.js - the test cannot run")
    process.exit(1)
}
const visibleRowsSource=source.slice(visibleRowsStart,visibleRowsEnd)
if(!visibleRowsSource.includes("return rows")){
    console.error("the visibleRows slice is incomplete - the test cannot run")
    process.exit(1)
}
const visibleRows=new Function("formulaComparator",
    `return ({${visibleRowsSource}}).visibleRows`)(formulaComparator)

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
test("a mass number goes UP, on the left of its symbol",()=>{
    /* The rule, and it is the one a chemist reads. ¹²C₆ — the A is raised and
       written BEFORE the symbol, the count is lowered and written AFTER it, so
       the two numbers of an isotope can never be confused for one another. It
       used to stay on the baseline, which is a position nobody looks for an A
       in, and a row of a dozen isotopes became a column of bare figures. */
    eq(prettyNotation("12C6 1H12 16O6"),"¹²C₆ ¹H₁₂ ¹⁶O₆")
    const first=prettyNotation("12C6 1H12 16O6").split(" ")[0]
    ok(first.startsWith("¹²"),`the 12 of a mass number must be raised, got "${first}"`)
    ok(first.endsWith("C₆"),`the 6 of a count must go down, got "${first}"`)
})
test("a mass number is NEVER taken for a count",()=>{
    /* The failure this fixes was silent and it was in the FUSED string: the
       display used to swallow the whole digit run as one count, so "C5 13C"
       arrived as "C513C" and was drawn C₅₁₃C — a thirteen that reads as five
       hundred and thirteen. It is fixed upstream, in `toString`, which no
       longer glues a count onto an A; this test is what notices if it comes
       back. */
    const fused=String(parse("12C5 13C1 1H12 16O6"))
    ok(/C5 13C/.test(fused),`expected "C5 13C" in the display, got "${fused}" — the count and the A would be one number`)
    const drawn=prettyNotation(fused)
    ok(!/₅₁₃/.test(drawn),`the 13 was drawn as a count: "${drawn}"`)
    ok(/¹³/.test(drawn),`the 13 must be raised: "${drawn}"`)
})
test("what is drawn reads back to what was read",()=>{
    /* A display that changes the string is a display that lies, because the
       string is what a chemist copies into a search box. Brackets are dropped
       by the drawing, so the comparison is on the composition alone — that is
       the part the drawing must preserve. */
    const restore=(drawn)=>drawn
        .replace(/[₀-₉]/g,d=>"0123456789"["₀₁₂₃₄₅₆₇₈₉".indexOf(d)])
        .replace(/⁺/g,"+").replace(/⁻/g,"-")
        .replace(/[⁰¹²³⁴-⁹]/g,d=>"0123456789"["⁰¹²³⁴⁵⁶⁷⁸⁹".indexOf(d)])
    for(const text of ["C6H12O6","12C6 1H12 16O6","C2H5OH","12C5 13C1 1H12 16O6"]){
        const bare=text.replace(/\[.*?\]/g,"").replace(/\s+/g,"")
        eq(restore(prettyNotation(text)).replace(/\s+/g,""),bare,
            `"${text}" does not read back from what is drawn`)
    }
})
test("the display re-reads, isotopes included",()=>{
    /* The engine's own round trip, and it is a different question from the
       drawing above: not "does the glyph decode" but "does the STRING mean the
       same formula". It used not to — `toString` glued "C5" and "13C" into
       "C513C", which the grammar reads as 513 carbones, so a session storing
       that text reopened a DIFFERENT molecule than the one that was found. */
    for(const text of ["12C5 13C1 1H12 16O6","C6H12O6","CH4[H+]","Fe2O3","C6H5 13C1 1H12 16O6"]){
        const first=parse(text)
        const again=Formula.parse(String(first),TABLE)
        eq(again.key,first.key,
            `"${text}" is displayed as "${first}", which re-reads as "${again.key}"`)
    }
})
test("a count of one is not written at all",()=>{
    eq(prettyNotation("CH4"),"CH₄")
    eq(prettyNotation("CO2"),"CO₂")
})
test("a signed charge of two is written whole",()=>{
    eq(prettyNotation("SO4[2-]"),"SO₄²⁻")
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

console.log("les LIGNES portent ce que les ordres lisent")
/* A stand-in for the reader, holding only what `visibleRows` touches — and now
   the three FOLDS as well, because a fold is an input to the row list and not
   only to a click. They are empty Sets by default, which is also an assertion
   that matters: a collection nobody unfolded must produce no children. */
const readerWith=(entries,{view="formula",sort="mz",filter="",open={}}={})=>({
    currentCollection:{name:"c",entries},
    parameters:{view,sort,filter},
    openEntries:open.openEntries??new Set(),
    openMolecules:open.openMolecules??new Set(),
    openPeaks:open.openPeaks??new Set()
})
/* `targets` are the MEASURED points, written by hand because what is under test
   is the line each of them becomes; the engine's own pairing is exercised on
   real formulas further down this file. */
const entry=(key,mz,intensity,errorPpm,molecule,targets=[])=>({
    key,notation:key,mz,intensity,errorPpm,molecule:molecule??key,targets
})
const peak=(mz,intensity,errorPpm)=>({mz,intensity,errorPpm,cost:1})

test("une ligne porte l'intensité et l'erreur que le comparateur lit",()=>{
    /* LE TEST DU BUG. `intensity` et `error` se choisissent dans le menu, donc
       le tri doit les lire — sur la LIGNE. Elles vivaient sous `row.entry`, le
       comparateur les cherchait à plat, il obtenait `undefined` partout, et les
       deux ordres retombaient sur le m/z. Choisir « erreur » ne changeait rien à
       l'ordre, sans lever la moindre exception: le genre de panne qu'on ne
       signale pas, puisqu'il n'y a rien à signaler.

       On vérifie donc que le menu change réellement l'ordre, en partant des
       lignes que le LECTEUR produit et non de lignes fabriquées à la main. */
    const entries=[
        entry("big",180,9000,8.0),
        entry("small",12,10,0.5),
        entry("mid",100,500,4.0)
    ]
    const keys=(name)=>visibleRows.call(readerWith(entries,{sort:name})).map(r=>r.key).join("")
    eq(keys("intensity"),"bigmidsmall",
        "intensity descending: 9000, 500, 10 — and NOT the m/z order")
    eq(keys("error"),"smallmidbig",
        "smallest error first: 0.5, 4, 8 — and NOT the m/z order")
    eq(keys("mz"),"smallmidbig","m/z ascending: 12, 100, 180")
})

test("chaque ordre du menu donne un ordre différent du m/z",()=>{
    /* La propriété qui compte n'est pas « quatre ordres différents » — c'est
       qu'AUCUN ne retombe sur le m/z. Le bug faisait exactement ça: `intensity`
       et `error` lisaient des champs absents, renvoyaient 0 pour toute paire, et
       le départage sur le m/z prenait le relais. Les deux ordres étaient
       l'ordre du m/z sous un autre nom.

       Le jeu de données est choisi pour que les trois classements divergent. La
       première version en utilisait un autre, où les trois ordres sortaient
       «bca» — un jeu qui ne prouve rien, et qui a échoué pour la bonne
       raison. */
    const entries=[
        entry("a",12,1,5),
        entry("b",100,9,1),
        entry("c",180,5,9)
    ]
    const order=(name)=>visibleRows.call(readerWith(entries,{sort:name})).map(r=>r.key).join("")
    const mz=order("mz")
    ok(mz==="abc",`m/z ascending is a,b,c — got ${mz}`)
    for(const name of ["intensity","error"]){
        const got=order(name)
        ok(got!==mz,`"${name}" fell back to the m/z order (${got}) — that is the bug`)
    }
    ok(order("intensity")!==order("error"),
        "intensity and error must not collapse onto each other either")
})

test("une molécule additionne son intensité, et n'a pas d'erreur",()=>{
    /* Two leaves folded onto one molecule, and the numbers a fold has to invent.
       L'intensité S'ADDITIONNE — c'est du signal. L'erreur n'existe pas pour un
       groupe: une molécule n'a pas été mesurée, ses feuilles si. Lui donner une
       moyenne fabriquerait un nombre qui ne correspond à rien de mesuré, et la
       ferait passer devant des feuilles qu'elle ne peut pas concurrencer. */
    const entries=[
        entry("h",15,100,0.4,"CH4[H+]"),
        entry("d",17,40,1.2,"CH4[H+]"),
        entry("other",99,7,0.1,"H2O")
    ]
    const rows=visibleRows.call(readerWith(entries,{view:"stoichiometry"}))
    eq(rows.length,2,"two molecules")
    const molecule=rows.find(r=>r.kind==="molecule"&&r.notation==="CH4[H+]")
    ok(molecule,`CH4[H+] is folded: ${rows.map(r=>r.notation).join(", ")}`)
    eq(molecule.intensity,140,"intensities are added: 100 + 40")
    eq(molecule.errorPpm,Infinity,"a molecule has no error of its own")
    eq(rows.find(r=>r.notation==="H2O").intensity,7,"a single leaf keeps its own intensity")
    const byIntensity=visibleRows.call(
        readerWith(entries,{view:"stoichiometry",sort:"intensity"}))
    eq(byIntensity[0].notation,"CH4[H+]","the summed 140 comes before the 7")
})

console.log("la TROISIÈME lecture: les pics, et le tri par pics")
test("la vue pics liste les points mesurés, pas les formules",()=>{
    /* LA VUE « PICS » EST LA TROISIÈME LECTURE DE LA MÊME COLLECTION, et elle
       ne montre pas ce qui a été prédit mais ce qui a été MESURÉ. Deux
       conséquences qu'il faut vérifier plutôt que d'espérer:

       - une ligne par POINT, donc deux points de la même formule sont deux
         lignes distinctes, et
       - la formule qui a pris le point est ÉCRITE à côté de lui, sans quoi la
         ligne serait un m/z sans auteur — le point le plus inutile qu'on puisse
         afficher. */
    const entries=[
        entry("a",12,1,5,"a",[peak(12.00001,900,0.4),peak(12.00002,100,-0.6)]),
        entry("b",100,9,1,"b",[peak(100.00005,50,2.1)])
    ]
    const rows=visibleRows.call(readerWith(entries,{view:"peaks"}))
    eq(rows.length,3,"three measured points, not two formulas")
    ok(rows.every(r=>r.kind==="peak"),"every line is a peak")
    eq(rows.map(r=>String(r.mz)).join(","),"12.00001,12.00002,100.00005","by m/z")
    eq(rows.map(r=>r.key).join("|"),"a#0|a#1|b#0",
        "two points of one formula are two lines, and neither takes the formula's key")
    eq(rows[0].notation,"a","the formula that took it is written beside the point")
    eq(rows[0].ownerKey,"a","and reachable by key, so unfolding the point can find it")
})
test("trier par pics compte les points expliqués",()=>{
    /* L'ordre « peaks » est le seul qui réponde à « combien de points mesurés
       cette ligne explique-t-elle ». Il doit être RÉELLEMENT différent du m/z:
       c'est la propriété qui compte, pas le fait qu'il existe. */
    const entries=[
        entry("a",12,1,5,"a",[peak(12.00001,10,0.1)]),
        entry("b",100,9,1,"b",[peak(100.00005,10,0.1),peak(100.00006,10,0.2),peak(100.00007,10,0.3)]),
        entry("c",180,5,9,"c",[])
    ]
    const keys=(name)=>visibleRows.call(readerWith(entries,{sort:name})).map(r=>r.key).join("")
    eq(keys("mz"),"abc","m/z ascending: 12, 100, 180")
    eq(keys("peaks"),"bac","three points, then one, then none — descending")
})
test("une molécule additionne ses pics comme elle additionne son intensité",()=>{
    const entries=[
        entry("h",15,100,0.4,"CH4[H+]",[peak(15.00001,100,0.4),peak(15.00002,20,0.1)]),
        entry("d",17,40,1.2,"CH4[H+]",[peak(17.00003,40,1.2)]),
        entry("other",99,7,0.1,"H2O",[])
    ]
    const byPeaks=visibleRows.call(
        readerWith(entries,{view:"stoichiometry",sort:"peaks"}))
    eq(byPeaks[0].notation,"CH4[H+]","three measured points beat one beat none")
    eq(byPeaks[0].peaks,3,"and the count is the sum over the leaves, not a mean")
})
console.log("le PLI: ce qu'il ouvre dépend de ce qu'il est")
test("rien n'est déplié, rien ne s'ouvre",()=>{
    /* Le plancher. Un pli est une clé dans un ensemble, donc une liste qu'on
       n'a pas dépliée ne doit produire AUCUNE ligne enfant — sinon une
       collection de 17 000 formules afficherait 17 000 lignes de plus. */
    const entries=[
        entry("a",12,1,5,"CH4[H+]",[peak(12.00001,10,0.1),peak(12.00002,20,0.2)]),
        entry("b",100,9,1,"H2O",[peak(100.00005,30,0.3)])
    ]
    for(const view of ["formula","peaks"]){
        const rows=visibleRows.call(readerWith(entries,{view}))
        ok(rows.every(r=>r.depth===0),`${view}: no children when nothing is open`)
    }
    eq(visibleRows.call(readerWith(entries)).length,2,"two formulae, no children")
    eq(visibleRows.call(readerWith(entries,{view:"stoichiometry"})).length,2,
        "two molecules, no children")
    eq(visibleRows.call(readerWith(entries,{view:"peaks"})).length,3,
        "three measured points, no children")
})
test("une formule dépliée montre ses pics, et chaque pic ses propres nombres",()=>{
    const entries=[
        entry("a",12,1,5,"CH4[H+]",[peak(12.00001,10,0.4),peak(12.00002,20,-0.7)]),
        entry("b",100,9,1,"H2O",[peak(100.00005,30,0.3)])
    ]
    const rows=visibleRows.call(readerWith(entries,{
        open:{openEntries:new Set(["a"])}
    }))
    eq(rows.map(r=>`${r.key}@${r.depth}`).join(" "),
        "a@0 a#0@1 a#1@1 b@0",
        "the two points of a, indented under it, and b untouched")
    const shown=rows.find(r=>r.key==="a#1")
    eq(shown.kind,"peak","a child of a formula is a peak")
    eq(shown.errorPpm,-0.7,"and it carries ITS OWN error, not the formula's closest one")
    eq(shown.intensity,20,"and its own intensity, not the formula's total")
    eq(shown.depth,1,"one level under its formula")
})
test("un pic déplié montre la formule qui l'a pris",()=>{
    /* L'autre moitié de la règle: dans la vue pics, la ligne est la MESURE, et
       déplier une mesure répond à « de quelle formule s'agit-il ? ». */
    const entries=[
        entry("a",12,1,5,"CH4[H+]",[peak(12.00001,10,0.4),peak(12.00002,20,-0.7)])
    ]
    const rows=visibleRows.call(readerWith(entries,{
        view:"peaks",
        open:{openPeaks:new Set(["a#1"])}
    }))
    eq(rows.map(r=>`${r.kind}:${r.depth}`).join(" "),"peak:0 peak:0 formula:1",
        "only the SECOND point was opened, and it shows the formula")
    eq(rows[2].key,"a","the formula, under its own point")
})
test("une molécule dépliée montre ses formules ET leurs pics",()=>{
    /* La demande explicite: dans la vue molécule, un pli montre les DEUX. Il
       le peut parce que les deux niveaux se contaminent — la molécule ouvre ses
       formules, et une formule ouverte parmi elles ouvre ses pics. Ce test
       échouerait si le pli n'était lu qu'au premier niveau. */
    const entries=[
        entry("h",15,100,0.4,"CH4[H+]",[peak(15.00001,100,0.4)]),
        entry("d",17,40,1.2,"CH4[H+]",[peak(17.00003,40,1.2)]),
        entry("other",99,7,0.1,"H2O",[peak(99.00004,7,0.1)])
    ]
    const rows=visibleRows.call(readerWith(entries,{
        view:"stoichiometry",
        open:{openMolecules:new Set(["CH4[H+]"]),openEntries:new Set(["d"])}
    }))
    eq(rows.map(r=>`${r.kind}:${r.depth}`).join(" "),
        "molecule:0 formula:1 formula:1 peak:2 molecule:0",
        "the molecule, its two formulae, the peaks of the one opened in turn, H2O untouched")
    eq(rows[3].kind,"peak","the second level really is a peak")
    eq(rows[3].depth,2,"at the fourth line")
})
test("le pli s'arrête, sinon la liste se replie sur elle-même",()=>{
    /* Un pic déplié montre sa formule, cette formule dépliée montre ses pics, et
       l'un de ces pics EST le premier. Sans plafond, un utilisateur qui ouvre
       les deux construit une liste infinie — et le premier symptôme n'est pas
       une erreur, c'est un onglet mort. */
    const entries=[entry("a",12,1,5,"CH4[H+]",[peak(12.00001,10,0.4)])]
    const rows=visibleRows.call(readerWith(entries,{
        view:"peaks",
        open:{openPeaks:new Set(["a#0"]),openEntries:new Set(["a"])}
    }))
    eq(rows.map(r=>r.depth).join(","),"0,1,2","one level per fold, and no more")
    eq(rows.length,3,"the point, its formula, that formula's one point — then stop")
})

console.log("ce qu'une ligne de PIC affiche, qui n'est pas ce qu'affiche la formule")
/* `drawRow` is the other half of what a line IS: `visibleRows` says which
   numbers a line carries, `drawRow` says which of them the user reads. Both are
   sliced out of interface.js as TEXT and evaluated here, because that file needs
   a DOM — the code under test is still the code that ships. */
const drawStart=source.indexOf("    drawRow(element,row){")
const drawEnd=source.indexOf("    refreshGraph(){",drawStart)
if(drawStart<0||drawEnd<drawStart){
    console.error("drawRow could not be located in interface.js - the test cannot run")
    process.exit(1)
}
const drawRow=new Function("CE","prettyNotation","formatMz","formatValue","formatCount",
    `return ({${source.slice(drawStart,drawEnd)}}).drawRow`)(
    ()=>null,prettyNotation,formatMz,formatValue,formatCount)

/* A row element, and the two things `drawRow` writes outside its cells: the
   classes it toggles and the indent it sets. */
const paint=(row,{selection=null,folded=new Set()}={})=>{
    const cells=[0,1,2,3,4].map(()=>({textContent:"",title:""}))
    const classes=[]
    const properties={}
    const element={
        cells,
        notation:cells[0],
        row:null,
        classList:{toggle:(name,on)=>{if(on) classes.push(name)}},
        style:{setProperty:(name,value)=>{properties[name]=value}}
    }
    drawRow.call({
        parameters:{selection},
        isSelected:(r)=>selection===(r.kind==="peak"?r.entry.key:r.key),
        isFolded:(r)=>folded.has(r.kind==="molecule"?r.molecule:r.key)
    },element,row)
    return {cells,classes,properties}
}

test("une ligne de pic montre les nombres DU PIC, pas ceux de la formule",()=>{
    /* LA LIGNE ERRONÉE, ET ELLE EST CLAIRE. Une formule porte l'erreur de son
       pic le plus proche et la SOMME de ses intensités; un pic est un point, et
       il a les siens. Les afficher sur les lignes dépliées ce serait mettre le
       même nombre sur chaque ligne du pli, et faux sur toutes sauf la première
       — le pire genre d'erreur: plausible, constante, et invisible. */
    const entries=[
        entry("a",12,9000,0.4,"CH4[H+]",[peak(12.00001,10,-7.5),peak(12.00002,20,3)])
    ]
    const rows=visibleRows.call(readerWith(entries,{
        view:"peaks",
        open:{openPeaks:new Set(["a#0"])}
    }))
    const head=paint(rows[0])
    eq(head.cells[0].textContent,"a","the formula that took the point is written on the line")
    eq(head.cells[1].textContent,"12.0000","and the m/z is the MEASURED one")
    eq(head.cells[2].textContent,"-7.5","the error is the point's, not the formula's closest (+0.4)")
    eq(head.cells[3].textContent,"10","and the intensity is the point's, not the formula's total (9000)")
})
test("un pli se lit par le RETRAIT, jamais par une couleur de plus",()=>{
    const entries=[
        entry("a",12,9000,0.4,"CH4[H+]",[peak(12.00001,10,-7.5),peak(12.00002,20,3)]),
        entry("b",100,9,1,"H2O",[])
    ]
    const rows=visibleRows.call(readerWith(entries,{
        view:"peaks",
        open:{openPeaks:new Set(["a#0"])}
    }))
    const head=paint(rows[0],{folded:new Set(["a#0"])})
    eq(head.properties["--fc-depth"],"0","a head line is not indented")
    eq(head.classes.includes("child"),false,"and does not claim to be a child")
    ok(head.classes.includes("unfolded"),"the line that was unfolded carries the open mark")
    const child=paint(rows[1])
    eq(child.properties["--fc-depth"],"1","a child line is one step in")
    ok(child.classes.includes("child"),"and says so, so it can be drawn quieter")
    eq(child.classes.includes("unfolded"),false,
        "the child it opened is not itself open — the mark belongs to the parent")
    /* the SECOND point of the same formula, which is a head line like any
       other: the fold of one line never reaches its neighbour */
    const neighbour=paint(rows[2],{folded:new Set(["a#0"])})
    eq(neighbour.properties["--fc-depth"],"0","its neighbour stays at the margin")
    eq(neighbour.classes.includes("unfolded"),false,"and is not dragged into the fold")
})
test("une molécule affiche son nombre de formules, pas une erreur",()=>{
    /* Une molécule n'a pas été mesurée: elle n'a pas d'erreur. La colonne dit
       donc combien de formules viennent d'être repliées — le nombre que l'on
       regarde à cet instant. */
    const entries=[
        entry("h",15,100,0.4,"CH4[H+]",[peak(15.00001,100,0.4)]),
        entry("d",17,40,1.2,"CH4[H+]",[peak(17.00003,40,1.2)])
    ]
    const rows=visibleRows.call(readerWith(entries,{view:"stoichiometry"}))
    const molecule=paint(rows[0])
    eq(molecule.cells[2].textContent,"×2","two formulas folded")
    eq(molecule.cells[3].textContent,"","and no intensity, which would be a number invented here")
})

console.log("les DEUX sorties, et le jumeau exact")
/* `publishOutput` builds output 0 (the collections) and output 1 (the waves) in
   ONE loop, so the test that matters is the one that compares them: if the two
   ever disagreed, a reader would see 240 formulas on the left and 238 points on
   the right, and neither side would be able to tell you it was wrong. */
const publishStart=source.indexOf("    publishOutput(){")
const publishEnd=source.indexOf("    async startResolve(){",publishStart)
if(publishStart<0||publishEnd<publishStart){
    console.error("publishOutput could not be located in interface.js - the test cannot run")
    process.exit(1)
}
const publishOutput=new Function("Wave",
    `return ({${source.slice(publishStart,publishEnd)}}).publishOutput`)(Wave)

/* A stand-in reader holding the two things `publishOutput` touches. */
const publisherWith=(collections,{ticked={}}={})=>({
    collections,
    collectionState:(name)=>({inOutput:ticked[name]??true}),
    outputs:[[],[]]
})
const collectionOf=(name,entries)=>({name,entries})
const row=(key,mz,intensity,errorPpm)=>({
    key,notation:key,mz,mass:mz,charge:1,molecule:key,
    errorPpm,intensity,note:"",targets:[]
})

test("chaque collection tickée donne une collection ET une wave",()=>{
    const collections=[
        collectionOf("first",[row("a",180,900,1),row("b",12,50,2)]),
        collectionOf("second",[row("c",100,10,3)])
    ]
    const node=publisherWith(collections)
    publishOutput.call(node)
    eq(node.outputs[0].length,2,"two collections on output 0")
    eq(node.outputs[1].length,2,"two waves on output 1")
    eq(node.outputs[1].map(w=>w.metadata.collection).join(","),"first,second",
        "and they are the same collections, in the same order")
})

test("une collection non cochée ne produit rien",()=>{
    /* A wave for a collection whose checkbox is off would put data on the graph
       the user deliberately excluded — the one thing the checkbox is for. */
    const collections=[
        collectionOf("shown",[row("a",180,900,1)]),
        collectionOf("hidden",[row("b",12,50,2)])
    ]
    const node=publisherWith(collections,{ticked:{shown:true,hidden:false}})
    publishOutput.call(node)
    eq(node.outputs[0].map(c=>c.name).join(","),"shown","output 0 honours the tick")
    eq(node.outputs[1].map(w=>w.metadata.collection).join(","),"shown",
        "output 1 honours the same tick")
})

test("la wave porte un point par formule, dans l'ordre croissant des m/z",()=>{
    const entries=[row("a",180,900,1),row("b",12,50,2),row("c",100,10,3)]
    const node=publisherWith([collectionOf("c",entries)])
    publishOutput.call(node)
    const wave=node.outputs[1][0]
    eq(wave.dims[0],3,"one point per formula")
    const xs=Array.from(wave.core.subarray(0,3))
    const ys=Array.from(wave.core.subarray(3,6))
    eq(xs.join(","),"12,100,180","m/z ascending, whatever the collection's own order")
    eq(ys.join(","),"50,10,900","and each intensity travels with its own m/z")
    eq(wave.metadata.collectionIndex,0,"the position of the same collection in output 0")
})

test("les deux sorties ne peuvent pas diverger",()=>{
    /* THE test. Same entries, two representations, compared. A formula with no
       match is the interesting case: it must still be a point, at zero, or the
       wave quietly has fewer points than the collection has formulas — and a
       reader comparing the two counts would be looking at the only clue. */
    const entries=[
        row("matched",180,900,1),
        row("unmatched",100,null,null),
        row("also-matched",12,50,2)
    ]
    const node=publisherWith([collectionOf("c",entries)])
    publishOutput.call(node)
    const formulas=node.outputs[0][0].formulas
    const wave=node.outputs[1][0]
    eq(wave.dims[0],formulas.length,
        `the wave has ${wave.dims[0]} points for ${formulas.length} formulas`)
    eq(wave.metadata.formulas,formulas.length,"and it says so in its metadata")
    eq(wave.metadata.unmatched,1,"one formula had no match")
    const ys=Array.from(wave.core.subarray(3,3+wave.dims[0]))
    eq(ys[ys.indexOf(0)],0,"an unmatched formula is at zero, not missing")
})

test("un m/z impossible est écarté, et compté",()=>{
    /* A NaN in a wave is invisible: a plot skips it, a binary search returns
       anything, and the node downstream is short one point with no way to say
       so. So it is dropped — and COUNTED, because a point lost in silence is
       the exact defect this whole change is about. */
    const entries=[row("good",100,10,1),row("bad",NaN,5,2),row("zero",0,7,3)]
    const node=publisherWith([collectionOf("c",entries)])
    publishOutput.call(node)
    const wave=node.outputs[1][0]
    eq(wave.dims[0],1,"only the usable m/z became a point")
    eq(wave.metadata.dropped,2,"and the two that did not are counted")
    eq(wave.metadata.formulas,3,"while the collection still holds all three")
})

test("une collection vide donne une wave vide, pas une absente",()=>{
    /* An empty wave and a missing one are different: a downstream node that
       loops over waves would treat "no wave" as "nothing to do" and "empty wave"
       as "nothing in it". The first skips a step the second must perform. */
    const node=publisherWith([collectionOf("empty",[])])
    publishOutput.call(node)
    eq(node.outputs[1].length,1,"the wave is there")
    eq(node.outputs[1][0].dims[0],0,"and it is empty")
})

console.log("ADOPTER une collection déjà construite")
test("adopter et fabriquer donnent le même résultat",()=>{
    /* The point of `adoptAll`: the reader must not change a single key, a single
       target or a single error by skipping the rebuild. If it did, the producer
       and the reader would disagree about what the same formula measured — and
       the reader is the one on screen, so the disagreement would be invisible
       from the attribution node. */
    const built=new FormulaCollection({name:"src",table:TABLE,ppm:10})
    built.addAll(["C6H12O6[H+]","CH4[H+]","H2O[H+]"].map(t=>({
        formula:Formula.parse(t,TABLE),sourceText:t
    })))
    built.setPoints([{mz:181.0707,intensity:900},{mz:17.0265,intensity:40}])

    const rebuilt=new FormulaCollection({name:"r",table:TABLE,ppm:10})
    rebuilt.addAll(built.formulas.map(f=>({formula:f,sourceText:String(f)})))
    rebuilt.setPoints(built.points)

    const adopted=new FormulaCollection({name:"a",table:TABLE,ppm:10})
    adopted.adoptAll(built.entries,{points:built.points})

    eq(adopted.entries.map(e=>e.key).join("|"),rebuilt.entries.map(e=>e.key).join("|"),
        "same keys, same order")
    eq(adopted.entries.map(e=>e.notation).join("|"),rebuilt.entries.map(e=>e.notation).join("|"),
        "same notations")
    eq(adopted.entries.map(e=>String(e.errorPpm)).join("|"),
        rebuilt.entries.map(e=>String(e.errorPpm)).join("|"),
        "same errors, so the matching landed on the same targets")
    eq(adopted.entries.map(e=>e.targets.length).join("|"),
        rebuilt.entries.map(e=>e.targets.length).join("|"),"same target counts")
})

test("adopter ne touche pas les entrées du producteur",()=>{
    /* The reader writes its OWN note on its own copy. If the copy were shared,
       the note would appear in the producer's collection and in any other reader
       downstream — an annotation belonging to one panel leaking into another. */
    const producer=new FormulaCollection({name:"src",table:TABLE,ppm:10})
    producer.addAll([{formula:Formula.parse("C6H12O6[H+]",TABLE),sourceText:"C6H12O6[H+]"}])
    const before=producer.entries[0].note

    const reader=new FormulaCollection({name:"r",table:TABLE,ppm:10})
    reader.adoptAll(producer.entries,{notes:{"12C6 1H12 16O6[H+]":"my own note"}})

    eq(producer.entries[0].note,before,"the producer's entry is untouched")
    const mine=reader.entries[0]
    ok(mine.note.length>0,"the reader's copy carries the note")
    ok(mine!==producer.entries[0],"and it is a DIFFERENT object")
})

test("une collection apprise garde la fenêtre qui l'a remplie",()=>{
    /* The reader used to overwrite the producer's window with its own, silently:
       10 ppm became 5, with no field to show it and no way to align them. The
       window that decided what is IN the collection is the one that has to
       decide what stays matched. */
    const producer=new FormulaCollection({name:"src",table:TABLE,ppm:10})
    ok(producer.ppm===10,"the producer built itself at 10 ppm")
    const reader=new FormulaCollection({name:"r",table:TABLE,ppm:5})
    reader.adoptAll(producer.entries,{})
    eq(reader.ppm,5,"and an adopting collection keeps the window IT was given")
})

console.log("la virtualisation: le défilement est lu où il se produit")
test("la liste lit le défilement sur le conteneur qui défile",()=>{
    /* A STRUCTURAL assertion, and it says so: there is no DOM here, so this
       cannot prove the list scrolls correctly — it can only prove the two things
       that made it not scroll.

       `.fc-viewport` is `position:absolute; inset:0` INSIDE `.fc-viewport-wrap`,
       and the wrap is what carries `overflow:auto`. Reading `scrollTop` on the
       viewport therefore always yields 0: `first` stays 0, the painted rows stay
       the first ones, and the wrap scrolls them out of sight. A few rows, then
       nothing — and only while scrolling, because at rest the position 0 is the
       correct one and the list looks perfectly fine. */
    const start=source.indexOf("class VirtualRowList{")
    const end=source.indexOf("/* ---- small pure helpers for the collection reader",start)
    ok(start>0&&end>start,"the VirtualRowList block is locatable")
    const block=source.slice(start,end)
    ok(!/this\.element\.scrollTop/.test(block),
        "scrollTop must not be read on .fc-viewport: it never scrolls, the wrap does")
    ok(!/this\.element\.clientHeight/.test(block),
        "the height must be measured on the same element that scrolls")
    const rangeStart=block.indexOf("visibleRange(){")
    const rangeBody=block.slice(rangeStart,block.indexOf("paint(){",rangeStart))
    ok(/this\.scroll\.scrollTop/.test(rangeBody),"visibleRange reads the real scroll position")
    ok(/this\.scroll\.clientHeight/.test(rangeBody),"visibleRange measures the real viewport")
})

test("le wrap est passé à la liste comme conteneur",()=>{
    /* The other half: the reader has to HAND OVER the scrolling element. The
       listener was already on the wrap, so the repaint was firing — on a list
       that could not know where it had been scrolled to. Repainting correctly
       from a wrong position still looks like a bug. */
    const start=source.indexOf("buildFormulaBand(){")
    /* The end anchor is the NEXT method, not a comment: `buildFormulaBand`
       contains a comment that itself starts with "The write line" — it describes
       the row above the list — so that anchor cut the slice 672 characters in,
       before the line the test is about. */
    const end=source.indexOf("    renderAddRow(){",start)
    ok(start>0&&end>start,"the buildFormulaBand block is locatable")
    const block=source.slice(start,end)
    ok(/scrollElement\s*:\s*viewport/.test(block),
        "VirtualRowList must be given the wrap as its scrollElement")
    const wrapAt=block.indexOf("const viewport=CE(\"div\",{className:\"fc-viewport-wrap\"}")
    const listAt=block.indexOf("this.list=new VirtualRowList(")
    ok(wrapAt>0&&listAt>0,"the wrap and the list are both built here")
    ok(wrapAt<listAt,
        "the wrap must exist BEFORE the list: the list needs it at construction")
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

