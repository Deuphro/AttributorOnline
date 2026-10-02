/* -------------------------------------------------------------------------
   diag3.mjs — POURQUOI « 13C » NE PRODUIT JAMAIS DE 13C.

   On lit ce que `readCombining` fait d'un groupe dont la NOTATION porte déjà
   l'isotope: il appelle `root.isotopologues(...)`, qui repart du plus probable
   et ne connaît plus le 13C que l'utilisateur a écrit.
   ------------------------------------------------------------------------- */
import {readFileSync} from "fs"
import {Element,Formula} from "../scripts/chemistry.js"
import {buildPlan} from "../scripts/attribution.js"

const TABLE=Element.load(JSON.parse(
    readFileSync(new URL("../data/elements.json",import.meta.url),"utf8")))

console.log("A. ce que la RACINE contient, et ce que isotopologues en fait")
for(const written of ["13C","C","13CH2","CH2"]){
    const root=Formula.parse(written,TABLE,"mostProbable")
    const comp=[]
    for(const [element,byA] of root.composition)
        for(const [A,n] of byA) comp.push(`${element.symbol}${A}x${n}`)
    const states=[...root.isotopologues({ratio:1,limit:Infinity})]
    console.log(`   ${written.padEnd(6)} racine=[${comp.join(",")}]`+
        `  isotopologues(ratio 1)=[${states.map(s=>s.notation).join(" ")}]`)
}

console.log("\nB. le plan lit donc une AUTRE brique que celle écrite")
const forced=buildPlan({
    combining:[{group:"13C",min:1,max:1,ratio:1}],
    ionising:[{group:"[H+]",min:1,max:1,ratio:1}],
    ratio:1,chargeMax:1,table:TABLE,chargeAuto:true
})
for(const brick of forced.combinables){
    console.log(`   demandé "13C" -> brique "${brick.notation}" `+
        `(${brick.key}) masse ${brick.atomicMass.toFixed(4)}`)
}
const expected=13.00336
const got=forced.combinables[0].atomicMass
console.log(`\n   masse attendue ${expected}, obtenue ${got.toFixed(4)},`+
    ` écart ${(got-expected).toFixed(4)} Da`)
console.log(`   -> l'isotope ÉCRIT est perdu: le germe d'isotopologues est le plus probable`)

console.log("\nC. et le groupe ne peut donc pas être distingue d'un « C »")
const plain=buildPlan({
    combining:[{group:"C",min:1,max:1,ratio:1}],
    ionising:[{group:"[H+]",min:1,max:1,ratio:1}],
    ratio:1,chargeMax:1,table:TABLE,chargeAuto:true
})
console.log(`   "13C" et "C" donnent-ils la même masse ? `+
    `${forced.combinables[0].atomicMass===plain.combinables[0].atomicMass}`)

console.log("\nD. avec un ratio large, le 13C REVIENT — parce qu'il est ré-énuméré")
const open=buildPlan({
    combining:[{group:"13C",min:1,max:1,ratio:0}],
    ionising:[{group:"[H+]",min:1,max:1,ratio:1}],
    ratio:1,chargeMax:1,table:TABLE,chargeAuto:true
})
console.log(`   ratio 0 -> ${open.combinables.map(b=>b.notation+" "+b.atomicMass.toFixed(4)).join("  |  ")}`)
console.log("   -> la liste contient bien 13C, mais AUPRÈS de 12C: l'ordre est")
console.log("      l'abondance, pas ce que l'utilisateur a écrit.")