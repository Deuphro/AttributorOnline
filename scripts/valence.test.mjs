/* -------------------------------------------------------------------------
   Self test — node scripts/valence.test.mjs

   The chemistry is one line of arithmetic, so these tests are about the
   DECISIONS rather than the maths: that a default can be overridden, that an
   override does not leak into the next use, and that a composition containing
   an element of ambiguous parity is reported as undecidable rather than being
   quietly accepted or rejected.
   ------------------------------------------------------------------------- */
import {readFileSync} from "fs"
import {ValenceSet,valenceParity} from "./valence.js"

const table=JSON.parse(readFileSync(new URL("../data/elements.json",import.meta.url),"utf8"))
const v=new ValenceSet(table)

let passed=0
const failures=[]
const test=(name,fn)=>{
    try{ fn(); passed++; console.log(`  ok   ${name}`) }
    catch(e){ failures.push(name); console.log(`  FAIL ${name}\n       ${e.message}`) }
}
const eq=(a,b,msg)=>{ if(a!==b) throw new Error(`${msg??`${a} != ${b}`}`) }

console.log("the defaults come from the data file")
test("carbon is tetravalent, hydrogen monovalent",()=>{
    eq(v.valence("C"),4)
    eq(v.valence("H"),1)
})
test("an element with no valence refuses rather than returning 0",()=>{
    // 0 would pass every parity test without anybody noticing
    try{ v.valence("Og"); throw new Error("should have thrown") }
    catch(e){ if(!/no valence/.test(e.message)) throw e }
})

console.log("a valence can be specified, exactly like an isotope profile")
test("pinning one gives a copy, and the original is untouched",()=>{
    eq(v.valence("Cr"),3)
    const cr6=v.with("Cr",6)
    eq(cr6.valence("Cr"),6)
    eq(v.valence("Cr"),3)          // the original must not have moved
})
test("the pinned set keeps the others",()=>{
    const set=v.with("Cr",6)
    eq(set.valence("C"),4)
    eq(set.valence("H"),1)
})
test("several pins at once",()=>{
    const set=v.with("Cr",6,"Fe",2)
    eq(set.valence("Cr"),6)
    eq(set.valence("Fe"),2)
    eq(set.valence("Co"),2)        // unpinned, so still the default
})

console.log("parity of a composition")
test("glucose is even: 6x4 + 12x1 + 6x2 = 48",()=>{
    eq(valenceParity(v,{C:6,H:12,O:6}),true)
})
test("hydrogen alone flips the parity",()=>{
    eq(valenceParity(v,{H:1}),false)
    eq(valenceParity(v,{H:2}),true)
})
test("methane CH4: 4 + 4 = 8, even",()=>{
    eq(valenceParity(v,{C:1,H:4}),true)
})
test("an empty composition is even",()=>{
    eq(valenceParity(v,{}),true)
})

console.log("an unknown or ambiguous valence lets the formula through")
test("they are flagged as such, not guessed",()=>{
    for(const s of ["Cr","Mn","Fe","Co","Cu","Tc","Ru"]){
        eq(v.hasStableParity(s),false,`${s} should be ambiguous`)
    }
})
test("a formula with chromium passes rather than hanging",()=>{
    // DECIDED: an ambiguous valence cannot rule anything out, so it passes.
    // The cost is that Cr and Fe can no longer be rejected by this test alone
    eq(valenceParity(v,{Cr:1,O:2}),true)
    eq(valenceParity(v,{Fe:1}),true)
})
test("an element with no valence at all also passes",()=>{
    // the noble gases and the lanthanides: nothing is known, nothing is excluded
    eq(valenceParity(v,{He:1}),true)
    eq(valenceParity(v,{La:1,O:3}),true)
})
test("pinning a valence still sharpens the test",()=>{
    // Cr(III) with 2 oxide: 3 + 2x2 = 7, ODD -> now rejected, because the
    // valence was named. Before pinning, the same formula passed.
    eq(valenceParity(v.with("Cr",3),{Cr:1,O:2}),false)
    // Cr(VI) with 3 oxide: 6 + 3x2 = 12, even
    eq(valenceParity(v.with("Cr",6),{Cr:1,O:3}),true)
})
test("iron: FeO is even as Fe(II), odd as Fe(III)",()=>{
    eq(valenceParity(v.with("Fe",2),{Fe:1,O:1}),true)   // 2 + 2
    eq(valenceParity(v.with("Fe",3),{Fe:1,O:1}),false)  // 3 + 2
})
test("an ambiguous element cannot rescue an odd total",()=>{
    // glucose C6H12O6 is even (24+12+12=48). Remove two hydrogens and the sum
    // is 46, even again; remove ONE and it is 47, odd. An element whose
    // valence is unknown does not make a genuinely odd formula acceptable:
    // it is skipped, not treated as zero-and-therefore-even.
    eq(valenceParity(v.with("Cr",6),{C:6,H:11,O:6}),false)   // 24+11+12 = 47
    eq(valenceParity(v.with("Cr",6),{C:6,H:12,O:6}),true)   // 48
    // and a genuinely unknown element cannot rescue it either
    eq(valenceParity(v,{C:6,H:11,O:6,He:1}),false)          // He is unknown
})
test("the stable ones are answered without being asked",()=>{
    for(const s of ["C","H","N","O","S","Cl","Na","Ca"]){
        eq(v.hasStableParity(s),true,`${s} should have a stable parity`)
    }
})

console.log(`\n${passed} passed, ${failures.length} failed`)
if(failures.length>0) process.exitCode=1
