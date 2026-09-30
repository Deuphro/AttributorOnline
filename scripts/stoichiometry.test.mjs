/* -------------------------------------------------------------------------
   Test — node scripts/stoichiometry.test.mjs

   Ce qui est vérifié ici, c'est le GRAPHE: une formule qui sait se dériver
   elle-même, se rattacher à sa racine, et ne pas s'agrandir indéfiniment.

   chemistry.test.mjs vérifie la GRAMMAIRE. Ces tests vérifient qu'une feuille
   engendre une feuille, pas une chaîne — et les pièges sont tous du même
   genre: un isotope fantôme, une Map partagée, une filiation perdue. Aucun
   n'aurait été vu par les tests existants.
   ------------------------------------------------------------------------- */
import {readFileSync} from "fs"
import {Element,Formula,Stoichiometry} from "./chemistry.js"
const TABLE=Element.load(JSON.parse(
    readFileSync(new URL("../data/elements.json",import.meta.url),"utf8")))
const parse=(text)=>Formula.parse(text,TABLE)

let passed=0
const failures=[]
const test=(name,fn)=>{
    try{ fn(); passed++; console.log(`  ok   ${name}`) }
    catch(e){ failures.push(name); console.log(`  FAIL ${name}\n       ${e.message}`) }
}
const ok=(value,msg)=>{ if(!value) throw new Error(msg??"expected a truthy value") }
const close=(a,b,tol,msg)=>{ if(!(Math.abs(a-b)<=tol)) throw new Error(`${msg??`${a} vs ${b}`}`) }

console.log("la hiérarchie: une formule EST une stœchiométrie")
test("Formula extends Stoichiometry",()=>{
    ok(parse("C6H12O6") instanceof Stoichiometry,"a Formula is not a Stoichiometry")
    ok(parse("C6H12O6") instanceof Formula,"a Formula is not a Formula")
})
test("Stoichiometry porte ce que Formula portait déjà",()=>{
    /* La refonte a MONTE composition, charge, masse et clé dans la base.
       Chacune est lue ici sur une Stoichiometry NUE, jamais sur une Formula:
       c'est le seul moyen de prouver qu'elle a vraiment été montée, et pas
       simplement laissée en place sur la sous-classe. */
    const root=new Stoichiometry({
        composition:Formula.parseComposition("C6H12O6",TABLE),
        table:TABLE
    })
    ok(root.counts.get(TABLE.find("C"))===6,`expected 6 C, got ${root.counts.get(TABLE.find("C"))}`)
    close(root.mass,parse("C6H12O6").mass,1e-9,"the root must weigh what the formula weighs")
    ok(typeof root.key==="string"&&root.key.length>0,"the root must have a key")
    ok(String(root).length>0,"the root must be displayable")
})

console.log("l'isotopologue: une formule se dérive elle-même")
test("12C6 donne 12C5 13C1",()=>{
    const base=parse("12C6 1H12 16O6")
    const heavy=base.isotopologue("C",13)
    /* "13C" et non "13C1": un compte de 1 s'omet à l'écriture, et la clé
       dit la même chose dans les deux cas. */
    ok(heavy.key==="12C5 13C 1H12 16O6",`expected 12C5 13C 1H12 16O6, got "${heavy.key}"`)
    close(heavy.mass-base.mass,1.003355,1e-4,"a 13C must add 1.003355")
})
test("le 13C revient en 12C: la décharge",()=>{
    /* Le cas du message: « j'ai le 13C1, je peux avoir le dchargé full 12C ».
       C'est le geste qui fixe la règle: demander 12C doit convertir LE 13C,
       sinon on FABRIQUE un 12C de plus et le 13C reste. */
    const heavy=parse("12C5 13C1 1H12 16O6")
    const back=heavy.isotopologue("C",12)
    ok(back.key==="12C6 1H12 16O6",`expected a plain 12C6, got "${back.key}"`)
    close(back.mass,parse("12C6 1H12 16O6").mass,1e-9,"back to the monoisotopic mass")
})
test("target nomme l'isotope à convertir",()=>{
    /* Sans target, "convertir en 12C" prend le 12C s'il est déjà là. Pour
       convertir un 13C précis en 12C en gardant les 12C, il faut le dire. */
    const mixed=parse("12C5 13C1 1H12")
    const stillHeavy=mixed.isotopologue("C",13,{target:12})
    ok(stillHeavy.key.includes("13C"),`the 13C should still be there: ${stillHeavy.key}`)
    const discharged=mixed.isotopologue("C",12,{target:13})
    ok(!discharged.key.includes("13C"),`the 13C should be gone: ${discharged.key}`)
})
test("le compte se déplace, il ne se duplique pas",()=>{
    const base=parse("12C6 1H12 16O6")
    const two=base.isotopologue("C",13,{count:2})
    ok(two.counts.get(TABLE.find("C"))===6,"the number of carbons must not change")
    close(two.mass-base.mass,2*1.003355,1e-4,"two 13C must add twice 1.003355")
})
test("une formule qui se dérive ne se modifie pas",()=>{
    /* La Map doit être COPIÉE. Si elle était partagée, la mère verrait son
       fils lui voler un carbone — le bug le plus silencieux du lot, parce que
       l'affichage de la mère resterait plausible. */
    const base=parse("12C6 1H12 16O6")
    const before=base.mass
    base.isotopologue("C",13)
    base.isotopologue("C",13)
    close(base.mass,before,0,"the parent must not change when a child is born")
    ok(!base.key.includes("13C"),`the parent kept a 13C: ${base.key}`)
})
test("l'ionisation survit au déplacement",()=>{
    const protonated=parse("12C6 1H12 16O6 [H+]")
    const heavy=protonated.isotopologue("C",13)
    ok(heavy.charge===1,`the charge must travel, got ${heavy.charge}`)
    ok(heavy.brackets==="[H+]",`the brackets must travel, got ${heavy.brackets}`)
})
test("un isotope inexistant est refusé, pas deviné",()=>{
    let raised=null
    try{ parse("12C6 1H12 16O6").isotopologue("C",99) }catch(e){ raised=e }
    ok(raised,"a carbon of mass 99 does not exist and must be refused")
    ok(raised.message.includes("99"),`the error must name the mass: ${raised.message}`)
})
test("un élément absent de la formule est refusé",()=>{
    let raised=null
    try{ parse("12C6 1H12 16O6").isotopologue("N",15) }catch(e){ raised=e }
    ok(raised,"there is no nitrogen in glucose")
})
test("on ne peut pas déplacer plus d'atomes qu'il n'y en a",()=>{
    let raised=null
    try{ parse("12C2 1H4").isotopologue("C",13,{count:5}) }catch(e){ raised=e }
    ok(raised,"2 carbons cannot place 5 of them")
    ok(raised.message.includes("2"),`the error must say what exists: ${raised.message}`)
})
test("un isotope identique ne crée pas de nœud fantôme",()=>{
    const base=parse("12C6 1H12 16O6")
    ok(base.isotopologue("C",12)===base,"moving 12C to 12C is the same formula, not a new node")
})
test("un compte nul ne reste pas dans la composition",()=>{
    /* 12C1 13C1 -> tout le 12C déplacé: il ne doit pas rester un « 12C0 »
       qui compterait dans counts, dans l'affichage et dans la clé. */
    const down=parse("12C1 13C1").isotopologue("C",12)
    ok(!/0/.test(down.key),`a zero count survived into the key: ${down.key}`)
})
// SPLIT


console.log("le graphe: la filiation se garde et se remonte")
test("l'enfant connaît son parent et sa racine",()=>{
    const base=parse("12C6 1H12 16O6")
    const child=base.isotopologue("C",13)
    ok(child.parent===base,"the child must point back at its parent")
    ok(child.root===base.root,"both must share one root")
})
test("la racine voit toutes ses feuilles",()=>{
    const base=parse("12C6 1H12 16O6")
    const a=base.isotopologue("C",13)
    const b=base.isotopologue("H",2)
    const all=[...base.leaves()]
    ok(all.length===3,`expected 3 leaves, got ${all.length}`)
    ok(all.includes(a)&&all.includes(b),"both children must be listed")
})
test("on retrouve une feuille par sa clé",()=>{
    const base=parse("12C6 1H12 16O6")
    const child=base.isotopologue("C",13)
    ok(base.findLeaf(child.key)===child,"a leaf must be findable by its own key")
    ok(base.findLeaf("nope")===null,"an unknown key finds nothing")
})
test("un cycle posé à la main ne boucle pas à l'infini",()=>{
    /* `parent` est une propriété PUBLIQUE. Une boucle posée à la main ne
       planterait pas: `root` ne finirait jamais de remonter. */
    const a=parse("12C6"),b=parse("13C6")
    a.parent=b
    b.parent=a
    ok(a.root===a||a.root===b,"root must terminate even on a cycle")
    ok([...a.leaves()].length>=1,"leaves must terminate even on a cycle")
})
test("une feuille sans table refuse de dériver, en le disant",()=>{
    const orphan=new Formula({composition:Formula.parseComposition("12C6",TABLE)})
    let raised=null
    try{ orphan.isotopologue("C",13) }catch(e){ raised=e }
    ok(raised,"without a table there is no mass to move")
    ok(/table/i.test(raised.message),`the error must explain why: ${raised.message}`)
})

console.log("le lien avec un spectre: l'écart se mesure")
test("ppmTo donne l'écart de masse entre deux feuilles",()=>{
    const mono=parse("12C6 1H12 16O6 [H+]")
    const heavy=mono.isotopologue("C",13)
    /* L'écart attendu est calculé depuis la TABLE, jamais recopié: la valeur
       1.003355 est une constante de papier, et la tester contre elle-même ne
       prouverait rien. */
    const delta=TABLE.find("C").isotope(13).mass-TABLE.find("C").isotope(12).mass
    close(mono.ppmTo(heavy),delta/mono.mz*1e6,1e-6,"the ppm gap is the isotope gap")
})
test("ppmTo est nul contre soi, et refuse l'infini",()=>{
    const f=parse("12C6 1H12 16O6 [H+]")
    close(f.ppmTo(f),0,1e-12,"a formula is at 0 ppm from itself")
    ok(f.ppmTo(null)===null,"no leaf, no error to report")
})

console.log("")
if(failures.length){
    console.log(`${passed} passed, ${failures.length} failed`)
    process.exit(1)
}
console.log(`${passed} passed, 0 failed`)
