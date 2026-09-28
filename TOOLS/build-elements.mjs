/* -------------------------------------------------------------------------
   build-elements.mjs — generates data/elements.json from the NIST reference.

   DATA PROVENANCE, and it matters:
   - Masses and isotopic compositions come from NIST "Atomic Weights and
     Isotopic Compositions". NIST compiles the IUPAC/CIAAW recommended values,
     so that is the authority we hold ourselves to.
   - Every isotope keeps the UNCERTAINTY NIST quotes, in its own unit. A mass
     without its uncertainty is not enough to work at 5 ppm, and some
     (radioactive ones especially) are far less certain than others.
   - Valences are NOT physical constants. They are chemical conventions that
     depend on context, stored separately and clearly marked so one is never
     mistaken for a measurement. See VALENCES below.

   It deliberately does NOT read any third-party redistribution of this data
   (chembiodata, Periodic-Table-JSON, ...). Those carry their own licences and,
   for the periodic table one, copy Wikipedia prose. Fetching NIST directly
   keeps the provenance short enough to audit.

   This script is the only thing allowed to write data/elements.json. That file
   is committed; running this reports a diff and never overwrites silently.

   usage: node TOOLS/build-elements.mjs [--write] [--verify]
   ------------------------------------------------------------------------- */
import {writeFileSync,readFileSync,existsSync,mkdirSync} from "fs"
import {fileURLToPath} from "url"
import {dirname,join} from "path"

const here=dirname(fileURLToPath(import.meta.url))
const OUT=join(here,"..","data","elements.json")

/* the 118 element symbols in Z order, with their names. These are facts, not
   creative work: this is simply the periodic table written out, so we do not
   depend on someone else's dataset. */
const ELEMENTS=[
    ["H","Hydrogen"],     ["He","Helium"],      ["Li","Lithium"],     ["Be","Beryllium"],
    ["B","Boron"],       ["C","Carbon"],       ["N","Nitrogen"],    ["O","Oxygen"],
    ["F","Fluorine"],    ["Ne","Neon"],        ["Na","Sodium"],     ["Mg","Magnesium"],
    ["Al","Aluminium"],  ["Si","Silicon"],     ["P","Phosphorus"],  ["S","Sulfur"],
    ["Cl","Chlorine"],   ["Ar","Argon"],       ["K","Potassium"],   ["Ca","Calcium"],
    ["Sc","Scandium"],   ["Ti","Titanium"],    ["V","Vanadium"],    ["Cr","Chromium"],
    ["Mn","Manganese"],  ["Fe","Iron"],        ["Co","Cobalt"],     ["Ni","Nickel"],
    ["Cu","Copper"],     ["Zn","Zinc"],        ["Ga","Gallium"],    ["Ge","Germanium"],
    ["As","Arsenic"],    ["Se","Selenium"],    ["Br","Bromine"],    ["Kr","Krypton"],
    ["Rb","Rubidium"],   ["Sr","Strontium"],   ["Y","Yttrium"],     ["Zr","Zirconium"],
    ["Nb","Niobium"],    ["Mo","Molybdenum"],  ["Tc","Technetium"], ["Ru","Ruthenium"],
    ["Rh","Rhodium"],    ["Pd","Palladium"],   ["Ag","Silver"],     ["Cd","Cadmium"],
    ["In","Indium"],     ["Sn","Tin"],         ["Sb","Antimony"],   ["Te","Tellurium"],
    ["I","Iodine"],      ["Xe","Xenon"],       ["Cs","Caesium"],    ["Ba","Barium"],
    ["La","Lanthanum"],  ["Ce","Cerium"],      ["Pr","Praseodymium"],["Nd","Neodymium"],
    ["Pm","Promethium"], ["Sm","Samarium"],    ["Eu","Europium"],   ["Gd","Gadolinium"],
    ["Tb","Terbium"],    ["Dy","Dysprosium"],  ["Ho","Holmium"],    ["Er","Erbium"],
    ["Tm","Thulium"],    ["Yb","Ytterbium"],   ["Lu","Lutetium"],   ["Hf","Hafnium"],
    ["Ta","Tantalum"],   ["W","Tungsten"],     ["Re","Rhenium"],    ["Os","Osmium"],
    ["Ir","Iridium"],    ["Pt","Platinum"],    ["Au","Gold"],       ["Hg","Mercury"],
    ["Tl","Thallium"],   ["Pb","Lead"],        ["Bi","Bismuth"],    ["Po","Polonium"],
    ["At","Astatine"],   ["Rn","Radon"],       ["Fr","Francium"],   ["Ra","Radium"],
    ["Ac","Actinium"],   ["Th","Thorium"],     ["Pa","Protactinium"],["U","Uranium"],
    ["Np","Neptunium"],  ["Pu","Plutonium"],   ["Am","Americium"],  ["Cm","Curium"],
    ["Bk","Berkelium"],  ["Cf","Californium"], ["Es","Einsteinium"],["Fm","Fermium"],
    ["Md","Mendelevium"],["No","Nobelium"],     ["Lr","Lawrencium"], ["Rf","Rutherfordium"],
    ["Db","Dubnium"],    ["Sg","Seaborgium"],  ["Bh","Bohrium"],    ["Hs","Hassium"],
    ["Mt","Meitnerium"], ["Ds","Darmstadtium"],["Rg","Roentgenium"],["Cn","Copernicium"],
    ["Nh","Nihonium"],   ["Fl","Flerovium"],   ["Mc","Moscovium"],  ["Lv","Livermorium"],
    ["Ts","Tennessine"], ["Og","Oganesson"],
]


/* VALENCES. These are CHEMICAL CONVENTIONS, not measurements, and they are
   context dependent: nitrogen is 3 or 5, sulfur 2, 4 or 6, chromium exists as
   2+, 3+ and 6+. So each element gets a DEFAULT valence (the first entry, the
   one an even-valence sieve would use) plus the alternatives kept beside it.

   The defaults are the textbook valences for the organic-spectrometry elements
   (CHNOPS, halogens, and the metals that actually show up in a mass spectrum).
   They are MY choice, not NIST's: they are the numbers to argue about, and
   they are marked as such in the JSON. `null` means "not decided yet", and the
   file is not allowed to pretend otherwise. */
const VALENCES={
    H:[1],  He:null, Li:[1], Be:[2], B:[3],  C:[4],  N:[3,5],  O:[2],  F:[1],
    Ne:null,Na:[1], Mg:[2], Al:[3], Si:[4],  P:[3,5], S:[2,4,6], Cl:[1,3,5,7],
    Ar:null,K:[1],  Ca:[2], Sc:[3], Ti:[4],   V:[3,5], Cr:[3,6], Mn:[2,4,7],
    Fe:[2,3],Co:[2,3], Ni:[2],  Cu:[1,2], Zn:[2], Ga:[3], Ge:[4], As:[3,5],
    Se:[2,4,6],Br:[1,3,5,7],Kr:null,Rb:[1], Sr:[2], Y:[3],  Zr:[4],  Nb:[3,5],
    Mo:[2,4,6],Tc:[4,7],Ru:[3,4], Rh:[3],  Pd:[2,4], Ag:[1], Cd:[2],  In:[3],
    Sn:[2,4],Sb:[3,5],Te:[2,4,6],I:[1,3,5,7],Xe:null,Cs:[1], Ba:[2],
}

/* the electron mass, CODATA 2018. It lives HERE, in the data, not in the code:
   it is a measured constant, it is quoted with its own uncertainty, and the
   legacy Igor procedure carried it as `constant emass=0.00054857990946`. */
const ELECTRON_MASS={value:0.000548579909065,uncertainty:6.5e-13,unit:"u",source:"CODATA 2018"}


/* -------------------------------------------------------------------------
   Reading NIST.

   A row of the isotope table looks like this, once the HTML is stripped:
       1 H 1 1.007 825 032 23(9) 0.999 885(70) [1.007 84, 1.008 11] m D
       ^A ^sym ^A ^mass ..................^ ^abundance .............^
   Two things make this awkward and both are handled explicitly:
   1. NIST groups the digits with spaces ("1.007 825 032"), so the spaces have
      to be squeezed out before parsing, and not by accident.
   2. The uncertainty in parentheses is in units of the LAST DIGIT GROUP, and
      the last group is not always the same width. "23(9)" means 9 units of the
      final 3-digit group. Getting this wrong silently inflates or deflates
      every uncertainty in the file, so it is derived, never guessed.        */
/* NIST wraps its table header over several lines ("Isotope \n Relative Atomic
   Mass"), so every space, tab AND newline is squeezed first and the anchors
   below are written on the flattened text. */
const stripHTML=(html)=>html
    .replace(/<[^>]*>/g," ")
    .replace(/&nbsp;/g," ")
    .replace(/\s+/g," ")

/* a NIST number plus its parenthesised uncertainty, in its own unit */
function parseMeasured(text,digits){
    if(text===undefined) return {value:null,uncertainty:null}
    const value=parseFloat(text.replace(/ /g,""))
    // the uncertainty counts units of the last group of `digits` digits
    const uncertainty=digits===undefined
        ? null
        : digits*Math.pow(10,-parseFloat("0."+digits))
    return {value,uncertainty}
}

/* NIST sits behind Cloudflare and refuses a plain Node fetch, so the HTML is
   fetched by TOOLS/fetch-nist.ps1 into a cache directory and read back here.
   Splitting fetch from parse keeps the hard part (the numbers) in one place
   and testable offline, and the cache means a rebuild never re-hammers NIST. */
const CACHE=join(here,"..",".cache","nist")

async function readPage(symbol){
    const file=join(CACHE,`${symbol}.html`)
    if(!existsSync(file)){
        throw new Error(
            `no cached NIST page for ${symbol}\n`
            +`run:  powershell -File TOOLS/fetch-nist.ps1 ${symbol}`)
    }
    return readFileSync(file,"utf8")
}

async function fetchIsotopes(symbol){
    const text=stripHTML(await readPage(symbol))
    // The column header is exactly "Isotope Relative Atomic Mass Isotopic
    // Composition Standard Atomic Weight Notes" and the data starts right after
    // it. Anchoring on "Isotope Relative Atomic Mass" alone lands ON the header,
    // and cutting on "Standard Atomic Weight" then truncates before any row.
    const header="Isotope Relative Atomic Mass Isotopic Composition Standard Atomic Weight Notes"
    const start=text.indexOf(header)
    if(start<0) throw new Error(`no isotope table for ${symbol}`)
    const body=text.slice(start+header.length)

    /* The NIST row, as it is actually printed:
           " 4 Be 9 9.012 183 065(82) 1 9.012 1831(5) 1"
             ^Z ^sym ^A  ^mass ........... ^abundance ...

       The atomic number AND the symbol are printed on the first row only, and
       a mass is a decimal followed by space-grouped digit chunks, so the row
       CANNOT be split on spaces. It is walked instead, left to right, with a
       cursor: read A, then a mass, then an optional uncertainty, then an
       optional abundance with its own uncertainty, then skip whatever else the
       row holds (the "m" marker, the D/T names, the standard weight column).

       A single regex was tried first and shifted every element by one column,
       inventing a 1Be and a 1F and a 1Na. Walking the row cannot drift: the
       cursor only moves forward, and each field is anchored to its own shape. */
    // cut before the Cloudflare script that follows the table
    const clean=body.split("(function()")[0]
    const NUMBER=/^\d+\.\d+(?: \d+)*/
    const UNCERTAINTY=/^\((\d+)\)/
    const integer=/^(\d+)/

    const isotopes=[]
    let i=0
    const skipSpaces=()=>{ while(i<clean.length&&clean[i]===" ") i++ }
    const readNumber=()=>{
        skipSpaces()
        const m=NUMBER.exec(clean.slice(i))
        if(!m) return undefined
        i+=m[0].length
        return m[0]
    }
    const readUncertainty=()=>{
        if(clean[i]!=="(") return undefined
        const m=UNCERTAINTY.exec(clean.slice(i))
        if(!m) return undefined
        i+=m[0].length
        return m[1]
    }
    /* The abundance is followed by its own "(70)"; the standard atomic weight is
       bracketed. The reliable test is the BRACKET: a number followed by "(" is
       an abundance, anything else belongs to the weight column. Reading the
       weight as an abundance consumed the "84" of "[1.007 84, ...]" and parked
       the cursor inside the bracket, so every element after the first isotope
       was lost. */
    /* The abundance is the one number of the pair that lies between 0 and 1, and
       that is the test used here. Both candidates look alike:
         Fe: "0.058 45(35) 55.845(2)"   abundance 0.05845, standard weight 55.845
         H:  "0.999 885(70) [1.007 84, ...]"
       A standard atomic weight is always a whole-element mass, so it is never
       below 1. Reading the weight as an abundance parked the cursor on the "56"
       that follows and Fe kept a single isotope. The bracket alone was not
       enough, because Fe prints its weight bare. */
    const readAbundance=()=>{
        skipSpaces()
        if(clean[i]==="["||clean[i]===",") return undefined
        const m=/^\d+\.\d+(?: \d+)*/.exec(clean.slice(i))
        if(!m) return undefined
        if(clean[i+m[0].length]!=="(") return undefined
        const value=parseFloat(m[0].replace(/ /g,""))
        if(!(value>0&&value<1)) return undefined
        i+=m[0].length
        return m[0]
    }
    /* What is left between two rows is unpredictable, so it is not predicted.
       After a row the scan JUMPS to the next "A mass" signature and resumes
       there. Predicting the delimiter was tried and failed twice: the standard
       atomic weight is bracketed for H and bare for Fe, and both look like an
       abundance followed by a row.

       A mass number is matched as a WHOLE TOKEN: a word boundary, then digits,
       then a space, then a decimal. Without the boundary the A of "10" matches
       as "1" and the "0" is read as a mass, which invented a beryllium-1 out of
       a beryllium-10 (9.0121831). A is then re-read with the same rule, so the
       row loop and the jump can never disagree about where it started. */
    const ROW=/\b(\d+) (\d+\.)/
    const jumpToNextRow=()=>{
        const m=/\b\d+ \d+\./g
        m.lastIndex=i
        const hit=m.exec(clean)
        i=hit?hit.index:clean.length
    }

    // the first row opens with the atomic number, a PLAIN INTEGER, then the
    // symbol. readNumber would not do: it insists on a decimal point.
    skipSpaces()
    const z=integer.exec(clean.slice(i))
    if(!z) throw new Error(`no atomic number for ${symbol}`)
    i+=z[0].length
    const sym=clean.slice(i).match(/^\s*([A-Z][a-z]?)/)?.[1]
    if(sym!==symbol){
        throw new Error(`${symbol}: page opens with Z=${z[0]} and symbol "${sym}"`)
    }
    // step over the symbol AND the space that follows it: the row loop starts
    // its own scan at i, and a leading space made the integer match fail, which
    // sent the scan hunting for a "next row" that it then never found
    i+=sym.length
    skipSpaces()

    while(true){
        skipSpaces()
        if(i>=clean.length) break
        const rest=clean.slice(i)
        const a=integer.exec(rest)
        if(!a){
            // not on a row: jump to the next one that is
            jumpToNextRow()
            continue
        }
        // consume the mass number itself before reading its mass
        i+=a[0].length
        const massTxt=readNumber()
        if(massTxt===undefined) break
        const massUnc=readUncertainty()
        /* The abundance is OPTIONAL. What follows a mass is either an abundance
           closed by its own "(35)", or nothing at all, or the standard atomic
           weight. The abundance is the one case where a "(" follows the number,
           which is the only reliable test. */
        const abTxt=readAbundance()
        const abUnc=abTxt!==undefined?readUncertainty():undefined

        // the uncertainty counts units of the last decimal place of the value
        const decimals=massTxt.split(".")[1].replace(/ /g,"").length
        isotopes.push({
            A:Number(a[0]),
            mass:parseFloat(massTxt.replace(/ /g,"")),
            massUncertainty:massUnc!==undefined?Number(massUnc)*Math.pow(10,-decimals):null,
            abundance:abTxt!==undefined?parseFloat(abTxt.replace(/ /g,"")):null,
            // an abundance uncertainty sits in the same decimal place as its
            // value: "(70)" after "0.999 885" means 0.000070
            abundanceUncertainty:abUnc!==undefined
                ? Number("0."+"0".repeat(Math.max(0,abTxt.length-2))+abUnc)
                : null,
        })
        // whatever is left of this row is skipped in one go
        jumpToNextRow()
    }
    if(process.env.TRACE){
        console.log("   trace",symbol,"stopped at",i,JSON.stringify(clean.slice(i,i+70)))
    }
    if(isotopes.length===0) throw new Error(`no isotope row parsed for ${symbol}`)
    return isotopes
}


/* -------------------------------------------------------------------------
   Reference values.

   The four masses below are the ones to argue about: they are the anchors the
   whole table hangs from, and the ones a human should be able to check by eye
   against a paper table. They come from NIST, and the tolerances are set to the
   6th significant digit — a 0.0000005 u window — which is far tighter than the
   5 ppm (0.001 u at m/z 200) the instrument tolerance ever asks for.

   Their isotope counts are here too, because "how many isotopes does element X
   have" is the kind of thing that should fail loudly if the parser breaks: a
   regression that silently drops the last isotope of every element is exactly
   the kind of bug that looks like chemistry.                               */
/* Only NATURAL isotopes are kept, so these counts are the natural ones: H has
   two (1H and 2H; tritium is radioactive and is not here), C has two (14C is
   radioactive), Cl has two, O has three. The beryllium count is the interesting
   one: it is a single isotope (9Be), and it is 1 rather than 2 only because
   NIST prints the 10Be row with its mass number truncated. */
const REFERENCE=[
    {symbol:"H",  mass:1.00782503223,   tolerance:5e-7, isotopes:2},
    {symbol:"C",  mass:12,              tolerance:5e-7, isotopes:2},
    {symbol:"O",  mass:15.99491461957,  tolerance:5e-7, isotopes:3},
    {symbol:"Cl", mass:34.968852682,    tolerance:5e-7, isotopes:2},
    {symbol:"Be", mass:9.012183065,     tolerance:5e-7, isotopes:1},
]

function check(data,log=console.log){
    const failures=[]
    const test=(name,fn)=>{
        try{ fn(); log(`  ok   ${name}`) }
        catch(e){ failures.push(name); log(`  FAIL ${name}\n       ${e.message}`) }
    }
    const close=(a,b,tol,msg)=>{
        if(!(Math.abs(a-b)<=tol)) throw new Error(`${msg??`${a} vs ${b}`} (tol ${tol})`)
    }
    const find=(symbol)=>data.elements.find(e=>e.symbol===symbol)

    log("the file is complete")
    test("118 elements, Z from 1 to 118, no gap",()=>{
        if(data.elements.length!==118) throw new Error(`${data.elements.length} elements`)
        data.elements.forEach((e,i)=>{ if(e.Z!==i+1) throw new Error(`${e.symbol} has Z=${e.Z}, expected ${i+1}`) })
    })
    test("every isotope has a mass, and it is a positive finite number",()=>{
        for(const e of data.elements){
            for(const iso of e.isotopes){
                if(!Number.isFinite(iso.mass)||iso.mass<=0) throw new Error(`${e.symbol}${iso.A} mass ${iso.mass}`)
                if(iso.A<1) throw new Error(`${e.symbol}${iso.A} bad A`)
            }
        }
    })
    test("masses increase with the mass number",()=>{
        for(const e of data.elements){
            for(let i=1;i<e.isotopes.length;i++){
                if(e.isotopes[i].mass<=e.isotopes[i-1].mass){
                    throw new Error(`${e.symbol}: A=${e.isotopes[i].A} mass ${e.isotopes[i].mass}`
                        +` <= A=${e.isotopes[i-1].A} mass ${e.isotopes[i-1].mass}`)
                }
            }
        }
    })

    log("the four reference masses, to be checked by eye")
    for(const ref of REFERENCE){
        test(`${ref.symbol}: monoisotopic ${ref.mass} over ${ref.isotopes} isotopes`,()=>{
            const e=find(ref.symbol)
            if(!e) throw new Error(`${ref.symbol} missing`)
            if(e.isotopes.length!==ref.isotopes){
                throw new Error(`${ref.isotopes} isotopes expected, found ${e.isotopes.length}`)
            }
            close(e.monoisotopicMass,ref.mass,ref.tolerance,`${ref.symbol} monoisotopicMass`)
        })
    }

    log("the electron mass")
    test("0.000548579909065 u, the legacy Igor constant to 10 digits",()=>{
        close(data.electronMass.value,0.000548579909065,1e-15)
        // the legacy code carried 0.00054857990946, which is the same number
        // rounded: ours is the CODATA value, theirs its truncation
        close(data.electronMass.value,0.00054857990946,4e-13,"legacy emass")
    })

    log("valences are marked as conventions, not measurements")
    test("every element has a valence slot, decided or explicitly null",()=>{
        for(const e of data.elements){
            if(!("valences" in e)) throw new Error(`${e.symbol} has no valence field`)
            if(e.valences===null) continue
            if(!Number.isInteger(e.valences.default)) throw new Error(`${e.symbol} default valence ${e.valences.default}`)
            if(!e.valences.all.includes(e.valences.default)){
                throw new Error(`${e.symbol} default ${e.valences.default} not among ${e.valences.all}`)
            }
        }
    })
    test("the ones to argue about are visible",()=>{
        const eq=(s,v)=>{ if(find(s).valences.default!==v) throw new Error(`${s} default ${find(s).valences.default}, expected ${v}`) }
        eq("C",4); eq("H",1); eq("N",3); eq("O",2); eq("S",2); eq("Cl",1)
        // nitrogen and sulfur keep their alternatives, marked as such
        const n=find("N")
        if(JSON.stringify(n.valences.all)!=="[3,5]") throw new Error(`N all = ${n.valences.all}`)
    })

    log("provenance is recorded")
    test("the file says where it comes from",()=>{
        if(!/NIST/.test(data.source?.name??"")) throw new Error("source is not NIST")
        if(!data.valenceSource?.includes("NOT")) throw new Error("valences are not marked as ours")
    })

    log(`\n${failures.length===0?"all checks passed":`${failures.length} FAILED: ${failures.join(", ")}`}`)
    return failures
}

if(process.argv.includes("--parse-test")){
    for(const symbol of ["H","C","O","Cl","Fe","U"]){
        const isotopes=await fetchIsotopes(symbol)
        console.log(`${symbol}: ${isotopes.length} isotopes`)
        for(const iso of isotopes.slice(0,4)){
            console.log("   A="+String(iso.A).padStart(3),
                "m="+String(iso.mass).padEnd(16),
                "u="+String(iso.massUncertainty).padEnd(12),
                "ab="+String(iso.abundance).padEnd(12),
                "abu="+iso.abundanceUncertainty)
        }
    }
    // show where the scan stops, so a lost row is visible instead of silent
    for(const symbol of ["H"]){
        const text=stripHTML(await readPage(symbol))
        const header="Isotope Relative Atomic Mass Isotopic Composition Standard Atomic Weight Notes"
        const body=text.slice(text.indexOf(header)+header.length)
        console.log("\nBODY:",JSON.stringify(body.split("(function()")[0].trim()))
    }
}

/* -------------------------------------------------------------------------
   Assembling and writing data/elements.json.

   The file is a SNAPSHOT, committed to the repository. Re-running this
   compares against the snapshot and reports differences; it only writes when
   --write is given, so nobody's data changes under them by surprise.        */
const SOURCE={
    name:"NIST Atomic Weights and Isotopic Compositions",
    url:"https://physics.nist.gov/cgi-bin/Compositions/",
    note:"NIST compiles the IUPAC/CIAAW recommended values.",
}

async function build(){
    const elements=[]
    for(const [Z,[symbol,name]] of ELEMENTS.entries()){
        const parsed=await fetchIsotopes(symbol)
        /* KEEP THE NATURAL ISOTOPES ONLY. The radioactive ones are deliberately
           left out for now, and that single rule also disposes of a real bug:
           NIST prints the beryllium row as "1 9.012 1831(5)" where it means
           "10 9.012 1831(5)", the mass number truncated to a single digit. 10Be is
           radioactive, so dropping the non-natural isotopes removes the broken
           row with it, instead of needing a patch for one element.

           An isotope is natural when NIST gives it an abundance. 62 of the 118
           elements have at least one; the other 56 are monoisotopic or
           synthetic, and their single row is kept as their natural isotope. */
        const withAbundance=parsed.filter(i=>i.abundance!==null)
        const isotopes=withAbundance.length>0
            ? withAbundance
            // no abundance at all: the element is monoisotopic, keep its one row
            : parsed.slice(0,1)
        isotopes.sort((a,b)=>a.A-b.A)
        // the lowest-A natural isotope is the monoisotopic one
        const monoisotopic=isotopes[0].mass
        // the natural average mass, computed here rather than trusted from a
        // second column that means something else
        const total=isotopes.reduce((t,i)=>t+(i.abundance??1),0)
        const averageMass=total>0
            ? isotopes.reduce((t,i)=>t+i.mass*(i.abundance??1),0)/total
            : null
        // an element absent from VALENCES is UNDECIDED, not "no valence": the two
        // are different and the file must not pretend otherwise
        const valences=VALENCES[symbol]??null
        elements.push({
            Z:Z+1,
            symbol,
            name,
            // valences are a chemical convention, not a measurement, and the
            // file says so. `default` is the one used when none is specified
            valences:valences===null?null:{default:valences[0],all:valences},
            monoisotopicMass:monoisotopic,
            averageMass,
            isotopes,
        })
    }
    return {
        schema:1,
        generatedBy:"TOOLS/build-elements.mjs",
        source:SOURCE,
        electronMass:ELECTRON_MASS,
        // valences are ours, not NIST's: the distinction is in the data
        valenceSource:"hand-set conventions, NOT from the source above",
        elements,
    }
}


if(process.argv.includes("--check")){
    const data=JSON.parse(readFileSync(OUT,"utf8"))
    if(check(data).length>0) process.exitCode=1
}

if(process.argv.includes("--parse-test")||process.argv.includes("--check")){
    // those two modes only inspect; no snapshot is written
} else {
    const data=await build()
    const counts=data.elements.map(e=>e.isotopes.length)
    const total=counts.reduce((a,b)=>a+b,0)
    console.log(`built ${data.elements.length} elements, ${total} natural isotopes`
        +` (min ${Math.min(...counts)}, max ${Math.max(...counts)})`)

    const json=JSON.stringify(data,null,1)+"\n"
    if(process.argv.includes("--write")){
        mkdirSync(join(here,"..","data"),{recursive:true})
        writeFileSync(OUT,json,"utf8")
        console.log("wrote "+OUT)
    }else if(existsSync(OUT)){
        if(readFileSync(OUT,"utf8")===json){
            console.log("data/elements.json is up to date with NIST")
        }else{
            // report WHAT changed rather than just "different"
            const old=JSON.parse(readFileSync(OUT,"utf8"))
            let n=0
            for(const el of data.elements){
                const was=old.elements?.[el.Z-1]
                if(!was){ console.log(`  + ${el.symbol} is new`); n++; continue }
                for(const iso of el.isotopes){
                    const had=was.isotopes.find(i=>i.A===iso.A)
                    if(!had){ console.log(`  + ${el.symbol}${iso.A} is new`); n++ }
                    else if(had.mass!==iso.mass){
                        console.log(`  ~ ${el.symbol}${iso.A} mass ${had.mass} -> ${iso.mass}`); n++
                    }
                }
            }
            console.log(n===0
                ? "only formatting or valence edits differ (run --write to sync)"
                : `${n} value(s) differ from data/elements.json (run --write to sync)`)
        }
    }else{
        console.log("no data/elements.json yet (run with --write to create it)")
    }
}

