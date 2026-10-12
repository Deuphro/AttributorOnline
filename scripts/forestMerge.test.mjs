import {test} from "node:test"
import assert from "node:assert/strict"
import {readFileSync} from "node:fs"
import {
    forestCompositionDiff,
    forestDiffIsEmpty,
    forestDiffNotation,
    forestFindBrick,
    forestMergeGraphs
} from "./forest.js"
import {Element,Formula} from "./chemistry.js"
import {buildPlan,mergeComposition,propagateForest} from "./attribution.js"

const TABLE=Element.load(JSON.parse(
    readFileSync(new URL("../data/elements.json",import.meta.url),"utf8")))

/* LA NOTATION D'UNE SUBSTITUTION, déduite de deux formules réelles — c'est
   exactement ce que fait le bouton « Merge » quand il n'a pas de brique. */
const between=(from,to)=>{
    const a=Formula.parse(from,TABLE)
    const b=Formula.parse(to,TABLE)
    return forestDiffNotation(forestCompositionDiff(b.composition,a.composition))
}
const eq=(a,b,msg)=>{ if(a!==b) throw new Error(`${msg??`${a} != ${b}`}`) }
const close=(a,b,tol,msg)=>{ if(!(Math.abs(a-b)<=tol)) throw new Error(`${msg??`${a} vs ${b}`}`) }

const planFor=(combining,ionising=[{group:"[H+]",min:1,max:1,ratio:1}])=>buildPlan({
    combining,ionising,ratio:1,chargeMin:1,chargeMax:1,table:TABLE
})

test("the root diff is big minus small, isotope by isotope",()=>{
    const plan=planFor([{group:"CH4"},{group:"CH2"}])
    const byKey=new Map(plan.items.map(item=>[item.key,item.composition]))
    const ch4=byKey.get("12C 1H4")
    const ch2=byKey.get("12C 1H2")
    assert.ok(ch4&&ch2,"the plan must carry both compositions")
    const diff=forestCompositionDiff(ch4,ch2)
    /* L'A PAR DÉFAUT N'EST PLUS ÉCRIT: « +1H2 » se lisait, mais « -14N » ne se
       lirait pas — le nombre devant le symbole est un COEFFICIENT. La notation
       dit donc « +H2 », et le lecteur prend l'isotope par défaut tout seul. */
    assert.equal(forestDiffNotation(diff),"+H2")
    assert.ok(!forestDiffIsEmpty(diff))
    const same=forestCompositionDiff(ch2,byKey.get("12C 1H2"))
    assert.ok(forestDiffIsEmpty(same),"same formula twice must give an empty diff")
})

test("a non-default isotope difference survives notation and propagation",()=>{
    const light=Formula.parse("12C",TABLE)
    const heavy=Formula.parse("13C",TABLE)
    const diff=forestCompositionDiff(heavy.composition,light.composition)
    const notation=forestDiffNotation(diff)
    assert.notEqual(notation,"±0","an isotope substitution must not disappear")
    const reference=Formula.parse(notation,TABLE)
    assert.deepEqual(reference.composition,diff,
        "the forest's signed isotope difference must be readable as a formula")

    const graph={rootIndex:0,vertices:[
        {index:0,mass:Formula.parse("12C[+]",TABLE).mz},
        {index:1,mass:Formula.parse("13C[+]",TABLE).mz}
    ],links:[{u:0,v:1,standard:0,label:notation}]}
    const references=[{composition:reference.composition}]
    const forward=propagateForest(graph,Formula.parse("12C[+]",TABLE),references,{table:TABLE})
    assert.equal(forward.rows.find(row=>row.index===1)?.notation,"13C[+]")

    const reverse=propagateForest({...graph,rootIndex:1},Formula.parse("13C[+]",TABLE),references,{table:TABLE})
    const returned=reverse.rows.find(row=>row.index===0)
    assert.equal(Formula.parse(returned.notation,TABLE).key,Formula.parse("12C[+]",TABLE).key)

    const threeHeavy=Formula.parse("13C3",TABLE)
    const oneHeavy=Formula.parse("13C",TABLE)
    const heavyLoss=forestCompositionDiff(oneHeavy.composition,threeHeavy.composition)
    const heavyLossNotation=forestDiffNotation(heavyLoss)
    assert.equal(heavyLossNotation,"13C-2")
    assert.deepEqual(Formula.parse(heavyLossNotation,TABLE).composition,heavyLoss)
    const lossGraph={rootIndex:0,vertices:[
        {index:0,mass:Formula.parse("13C3[+]",TABLE).mz},
        {index:1,mass:Formula.parse("13C[+]",TABLE).mz}
    ],links:[{u:0,v:1,standard:0,label:heavyLossNotation}]}
    const lossResult=propagateForest(lossGraph,Formula.parse("13C3[+]",TABLE),[
        {composition:Formula.parse(heavyLossNotation,TABLE).composition}
    ],{table:TABLE})
    assert.equal(lossResult.rows.find(row=>row.index===1)?.notation,"13C[+]")
})

test("a brick is found by its SIGNED difference, and by nothing else",()=>{
    /* LE MODÈLE A CHANGÉ, ET CE TEST L'ANCIEN VERSION AVAIT RAISON.

       Il affirmait que « -CH2 doit trouver la brique CH2, le sens du lien
       décide du signe ». C'était coherent tant qu'une brique ne pouvait pas
       porter de compte négatif: il n'y avait alors qu'une seule brique
       possible, et le sens du lien decidait effectivement du signe. Le plan
       accepte maintenant des briques signées — la composition du groupe est
       rendue telle qu'elle a été lue — donc `CH2` et `-CH2` sont DEUX briques,
       et la question « laquelle? » a une réponse: celle dont la différence
       signée est exactement celle qu'on cherche.

       Connaître le signe à l'avance n'est donc plus une information perdue:
       c'est ce qui choisit la brique. */
    const plan=planFor([{group:"CH4"},{group:"CH2"}])
    const byKey=new Map(plan.items.map(item=>[item.key,item.composition]))
    const plus=forestCompositionDiff(byKey.get("12C 1H4"),byKey.get("12C 1H2"))
    const minus=forestCompositionDiff(byKey.get("12C 1H2"),byKey.get("12C 1H4"))
    assert.equal(forestFindBrick(plan.items,plus),-1,
        "the plan has no +H2 brick, so +H2 must not be found")
    assert.equal(forestFindBrick(plan.items,minus),-1,
        "and no -H2 brick either: the plan must not answer from magnitudes")
    const asIs=byKey.get("12C 1H2")
    assert.equal(forestFindBrick(plan.items,asIs),1)
    const negated=forestCompositionDiff(
        forestCompositionDiff(asIs,asIs),asIs)
    assert.equal(forestFindBrick(plan.items,negated),-1,
        "-H2 must NOT match the +H2 brick: they are different bricks, and "
        +"matching them by magnitude is what lost the sign in the first place")

    /* ET LA BRIQUE SIGNÉE EST BIEN CELLE-LÀ. */
    const signed=planFor([{group:"CH2"},{group:"-CH2"}])
    /* `diff(big, small) = big − small`, donc diff(∅, CH2) = −CH2: la perte. */
    const loss=forestCompositionDiff(new Map(),asIs)
    const items=signed.items.filter(item=>item.kind==="combining")
    const found=forestFindBrick(items,loss)
    assert.ok(found>=0,`a signed brick is findable by its signed difference, got -1 for ${forestDiffNotation(loss)}`)
    assert.ok(items[found].atomicMass<0,
        `and it weighs a NEGATIVE mass, got ${items[found].atomicMass} — `
        +"a loss of CH2 is -14 Da, and the old code re-read the canonical key "
        +"and answered +13 Da")
})

test("merged graphs keep every vertex and link, plus the bridge",()=>{
    const g1={rank:0,size:2,rootIndex:0,weight:0.1,vertices:[
        {index:0,mass:100,intensity:1},{index:1,mass:114,intensity:2}],
        links:[{u:0,v:1,weight:0.1,standard:0,label:"CH2"}]}
    const g2={rank:1,size:1,rootIndex:5,weight:0,vertices:[
        {index:5,mass:128,intensity:3}],links:[]}
    const merged=forestMergeGraphs([g1,g2],[{u:1,v:5,weight:0.05,standard:0,label:"CH2"}])
    assert.equal(merged.size,3)
    assert.equal(merged.rootIndex,0,"the biggest tree keeps its root")
    assert.equal(merged.links.length,2)
    assert.deepEqual(merged.mergedFrom,[0,1])
    assert.equal(merged.totalIntensity,6)
    assert.ok(merged.vertices.every(v=>v.index!==undefined))
})

test("a SUBSTITUTION links two roots, like any other difference",()=>{
    /* Une substitution, c'est un élément retiré ET un élément ajouté. Le diff
       reste SIGNÉ, et il mélange les deux signes.

       L'ancien modèle cherchait la brique par MAGNITUDES, donc `+C-H+N+O`
       trouvait la brique `CHNO`: le lien était créé, et il était faux — la
       brique pesait 43 Da au lieu des 15 Da de la différence réelle, et la
       propagation ajoutait les quatre atomes au lieu d'échanger C contre N et O.
       Le poids du lien portait donc l'erreur du modèle, pas celle de la mesure.

       Ici la brique est la différence signée: elle n'est pas trouvée tant qu'elle
       n'est pas dans le plan, et elle s'écrit dans la langue que le lecteur parle
       — ce qui est vérifié en la relisant, pas en comparant des chaînes. */
    const plan=planFor([{group:"CHNO"},{group:"H2"}])
    const byKey=new Map(plan.items.map(item=>[item.key,item.composition]))
    const chno=byKey.get("12C 1H 14N 16O")
    const h2=byKey.get("1H2")
    assert.ok(chno&&h2,"the plan must carry both compositions")
    const diff=forestCompositionDiff(chno,h2)
    assert.ok(!forestDiffIsEmpty(diff))
    const notation=forestDiffNotation(diff)
    assert.ok(notation.includes("-"),"the diff must stay signed")
    assert.ok(notation.includes("+"),"and it must mix both signs")
    assert.equal(forestFindBrick(plan.items,diff),-1,
        "a CHNO brick is not a substitution: magnitudes must not decide")

    /* LA BRIQUE ÉCRITE EST RELUE, ET ELLE PÈSE CE QUE PÈSE LA DIFFÉRENCE. */
const reloaded=Formula.parse(notation,TABLE)
    let realMass=0
    for(const [el,byA] of chno) for(const [A,n] of byA) realMass+=el.isotope(A).mass*n
    let otherMass=0
    for(const [el,byA] of h2) for(const [A,n] of byA) otherMass+=el.isotope(A).mass*n
    assert.ok(Math.abs(reloaded.mass-(realMass-otherMass))<1e-6,
        `the notation must read back as the difference: ${reloaded.mass} vs ${realMass-otherMass}`)
    const withBrick=planFor([{group:"CHNO"},{group:"H2"},{group:notation}])
    assert.ok(forestFindBrick(withBrick.items,diff)>=0,
        "and once it IS in the plan, the substitution links")
})

test("applying a SIGNED brick turns one root into the other, not into a bigger one",()=>{
    /* LE CONTRAT DE LA PROPAGATION, VÉRIFIÉ SUR LA COMPOSITION SEULE.

       C'est ce que `propagateForest` fait de chaque lien: appliquer la
       composition de la référence à celle de la formule déjà attribuée. Le graphe
       n'est pas nécessaire pour le vérifier, et il évite d'avoir à en
       fabriquer un — ce qui compte, c'est qu'une substitution SOIT un échange.

       L'ancien modèle échouait ici deux fois: il écrivait une brique en
       magnitudes, donc appliquait `CHNO` à C6H12O5 et obtenait C7H13O6N — quatre
       atomes de trop — au lieu de H11NO6. */
    const plan=planFor([{group:between("C6H12O5","H11NO6")}])
    const brick=plan.items.find(item=>item.kind==="combining")
    const low=Formula.parse("C6H12O5",TABLE)
    /* LA COPIE EST PROFONDE, et c'est un piège que ce test vient de payer:
       `new Map(composition)` ne copie que le premier niveau — les tables
       d'isotopes restent les MÊMES objets, donc `mergeComposition` a modifié la
       composition de la racine elle-même, et le calcul de l'écart s'est fait
       sur une formule déjà changée. C'est exactement à cela que sert
       `copyComposition`, qui n'est pas exporté: on refait la copie ici. */
    const target=new Map([...low.composition].map(([el,byA])=>[el,new Map(byA)]))
    mergeComposition(target,brick.composition,1)
    const rebuilt=Formula.parse(Formula.compositionToString(target,"mostProbable"),TABLE)
    eq(String(rebuilt),String(Formula.parse("H11NO6",TABLE)),
        "C6H12O5 plus the signed brick must be H11NO6")
    close(rebuilt.mass,Formula.parse("H11NO6",TABLE).mass,1e-6,
        "and weigh the same")
    /* ET LA MASSE DE LA BRIQUE EST BIEN L'ÉCART ENTRE LES DEUX RACINES — c'est
       ce que le poids du lien compare, donc c'est ce qui doit être juste. */
    const gap=Formula.parse("H11NO6",TABLE).mass-low.mass
    close(brick.atomicMass,gap,1e-6,
        `the brick must weigh the gap between the roots: ${brick.atomicMass} vs ${gap}`)
})

test("a CHAIN of merges keeps every absorbed rank consumed",()=>{
    /* Le bug : `mergedFrom` ne portait que les rangs RE�US. Apr�s #0+#1 puis
       (fusionn�)+#2, la provenance valait [0,2] � le rang 1, d�j� absorb�, en
       disparaissait, et l'arbre #1 R�APPARAISSAIT dans la liste. L'utilisateur le
       voyait ressurgir et fusionnait ensuite le mauvais couple. */
    const tree=rank=>({rank,size:1,rootIndex:rank*10,weight:0,vertices:[
        {index:rank*10,mass:100+rank,intensity:1}],links:[]})
    const g0=tree(0), g1=tree(1), g2=tree(2)
    const first=forestMergeGraphs([g0,g1],[])
    assert.deepEqual(first.mergedFrom,[0,1],"a first merge absorbs both")
    // the first merge is drawn, then the user selects it with #2
    const second=forestMergeGraphs([first,g2],[])
    assert.deepEqual(second.mergedFrom,[0,1,2],
        "a chained merge must carry the ranks its input had already absorbed")
    assert.ok(second.mergedFrom.includes(1),
        "an absorbed rank must never fall out of the provenance")
})