/* -------------------------------------------------------------------------
   Test — node scripts/funnelMask.test.mjs

   Le Funnel Mask apparie des lectures du crible et note leur cohérence
   isotopique. L'oracle est physique et vérifiable à la main :

     - 13C/12C théorique vient de data/elements.json ;
     - pour C6H12O6, I(13C1)/I(13C0) vaut environ 6 x (13C/12C) ;
     - retirer le satellite doit supprimer le rapport ;
     - un satellite hors fenêtre ne doit pas être apparié ;
     - un pic dont le mariage par défaut n'est pas la lecture au meilleur
       delta doit être signalé.
   ------------------------------------------------------------------------- */
import {readFileSync} from "fs"
import {Element,Formula} from "./chemistry.js"
import {
    elementsInProposals,
    normaliseCandidates,
    findProposedPermutations,
    isotopeRatio,
    computeFunnelMask
} from "./funnelMask.js"

const TABLE=Element.load(JSON.parse(
    readFileSync(new URL("../data/elements.json",import.meta.url),"utf8")))

let passed=0
const failures=[]
const test=(name,fn)=>{
    try{ fn(); passed++; console.log(`  ok   ${name}`) }
    catch(e){ failures.push(name); console.log(`  FAIL ${name}\n       ${e.message}`) }
}
const ok=(value,msg)=>{ if(!value) throw new Error(msg??`expected a truthy value, got ${value}`) }
const close=(a,b,tol,msg)=>{
    if(!(Math.abs(a-b)<=tol)) throw new Error(`${msg??"values differ"}: ${a} vs ${b}`)
}

const carbon=TABLE.bySymbol.get("C")
const theoretical1312=carbon.isotope(13).abundance/carbon.isotope(12).abundance

const glucose=Formula.parse("C6H12O6 [H+]",TABLE)
const glucose13=glucose.isotopologue("C",13)
const other=Formula.parse("C5H10O5 [H+]",TABLE)

const reading=(formula,point,{mz=formula.mz,intensity=1000,errorPpm=0}={})=>({
    formula,
    key:formula.key,
    mz:formula.mz,
    charge:formula.charge,
    errorPpm,
    target:{index:point,mz,intensity,errorPpm}
})
const peaksStub=(peaks)=>{
    const list=peaks.map((peak,index)=>({
        index:peak.index??index,
        mz:peak.mz,
        intensity:peak.intensity??1
    }))
    return {
        length:list.length,
        x:list.map(peak=>peak.mz),
        y:list.map(peak=>peak.intensity),
        nearest(mz){
            let best=null
            let distance=Infinity
            for(const peak of list){
                const current=Math.abs(peak.mz-mz)
                if(current<distance){ distance=current; best=peak }
            }
            if(!best) return null
            return {
                index:best.index,
                mz:best.mz,
                intensity:best.intensity,
                errorPpm:(best.mz-mz)/mz*1e6
            }
        }
    }
}

test("la base est 13C0 et son frère 13C1 de même molécule",()=>{
    const candidates=normaliseCandidates([
        reading(glucose,0),
        reading(glucose13,1)
    ])
    const pairs=findProposedPermutations(candidates,{symbol:"C",lightA:12,heavyA:13})
    ok(pairs.length===1,`expected one pair, got ${pairs.length}`)
    ok(pairs[0].light.key===glucose.key,"the base is the light member")
    ok(pairs[0].heavy.key===glucose13.key,"the sibling is the heavy member")
})

test("le ratio 13C/12C est l'écart des intensités divisé par les carbones",()=>{
    const lightIntensity=1000
    const heavyIntensity=lightIntensity*6*theoretical1312*1.5
    const ratio=isotopeRatio({
        lightIntensity,heavyIntensity,atoms:6,theoretical:theoretical1312
    })
    close(ratio.ratio,1.5*theoretical1312,1e-12,"ratio = (I1/I0)/N_C")
    close(ratio.delta,0.5,1e-12,"the relative gap to the natural ratio")
})

test("un frère proposé donne un rapport avec un delta vérifiable",()=>{
    const lightIntensity=1000
    const heavyIntensity=lightIntensity*6*theoretical1312*1.5
    const mask=computeFunnelMask({
        entries:[
            reading(glucose,0,{intensity:lightIntensity}),
            reading(glucose13,1,{intensity:heavyIntensity})
        ],
        element:"C",lightA:12,heavyA:13
    })
    ok(mask.available,"the element/isotopes must be usable")
    ok(mask.ratios.length===1,`expected one ratio, got ${mask.ratios.length}`)
    close(mask.ratios[0].delta,0.5,1e-12,"delta must be 0.5")
    ok(mask.ratios[0].simulated===false,"this pair was proposed, not simulated")
    ok(mask.ratios[0].atoms===6,"the stoichiometry is six carbons")
    ok(mask.points.length===2,"both peaks carry a delta")
})

test("sans frère proposé, le satellite est simulé en masse",()=>{
    const lightIntensity=800
    const heavyIntensity=lightIntensity*6*theoretical1312*0.8
    const deltaMass=carbon.isotope(13).mass-carbon.isotope(12).mass
    const mask=computeFunnelMask({
        entries:[reading(glucose,0,{intensity:lightIntensity})],
        peakList:peaksStub([
            {index:0,mz:glucose.mz,intensity:lightIntensity},
            {index:5,mz:glucose.mz+deltaMass,intensity:heavyIntensity}
        ]),
        element:"C",lightA:12,heavyA:13
    })
    ok(mask.ratios.length===1,`expected one simulated ratio, got ${mask.ratios.length}`)
    ok(mask.ratios[0].simulated===true,"no sibling in the sieve, so it is simulated")
    ok(mask.ratios[0].heavyPoint===5,"the measured satellite is the heavy peak")
    close(mask.ratios[0].delta,-0.2,1e-9,"0.8 x natural must give -0.2")
})

test("un satellite hors fenêtre ppm n'est pas apparié",()=>{
    const deltaMass=carbon.isotope(13).mass-carbon.isotope(12).mass
    const mask=computeFunnelMask({
        entries:[reading(glucose,0,{intensity:1000})],
        peakList:peaksStub([
            {index:0,mz:glucose.mz,intensity:1000},
            {index:5,mz:glucose.mz+deltaMass+0.05,intensity:100}
        ]),
        element:"C",lightA:12,heavyA:13,ppm:10
    })
    ok(mask.ratios.length===0,"a peak 4000 ppm away is not the satellite")
})

test("une formule déjà lourde n'est pas une base",()=>{
    const mask=computeFunnelMask({
        entries:[reading(glucose13,0,{intensity:1000})],
        element:"C",lightA:12,heavyA:13
    })
    ok(mask.ratios.length===0,"only 13C0 can start a 13C0 -> 13C1 ratio")
})

test("le mariage temporaire est signalé quand il n'a pas le meilleur delta",()=>{
    const lightIntensity=1000
    const heavyIntensity=lightIntensity*6*theoretical1312
    const mask=computeFunnelMask({
        entries:[
            reading(glucose,0,{intensity:lightIntensity,errorPpm:2.0}),
            reading(other,0,{intensity:lightIntensity*0.9,errorPpm:0.1}),
            reading(glucose13,1,{intensity:heavyIntensity,errorPpm:1.0})
        ],
        element:"C",lightA:12,heavyA:13
    })
    const point=mask.points.find(item=>item.index===0)
    ok(point,"the ambiguous peak must carry a delta")
    ok(point.married===other.key,"the default marriage is the best mass match")
    ok(point.bestKey===glucose.key,"the best isotopic reading is the glucose base")
    ok(point.mismatch===true,"the temporary marriage must be flagged")
})

test("le mariage cohérent n'est pas signalé",()=>{
    const lightIntensity=1000
    const heavyIntensity=lightIntensity*6*theoretical1312
    const mask=computeFunnelMask({
        entries:[
            reading(glucose,0,{intensity:lightIntensity,errorPpm:0.1}),
            reading(other,0,{intensity:lightIntensity*0.9,errorPpm:2.0}),
            reading(glucose13,1,{intensity:heavyIntensity,errorPpm:1.0})
        ],
        element:"C",lightA:12,heavyA:13
    })
    const point=mask.points.find(item=>item.index===0)
    ok(point.mismatch===false,"the best mass match is also the coherent one")
})

test("un choix de réinspection l'emporte sur le mariage par défaut",()=>{
    const lightIntensity=1000
    const heavyIntensity=lightIntensity*6*theoretical1312
    const mask=computeFunnelMask({
        entries:[
            reading(glucose,0,{intensity:lightIntensity,errorPpm:2.0}),
            reading(other,0,{intensity:lightIntensity*0.9,errorPpm:0.1}),
            reading(glucose13,1,{intensity:heavyIntensity,errorPpm:1.0})
        ],
        element:"C",lightA:12,heavyA:13,
        marriageByPoint:new Map([[0,glucose.key]])
    })
    const point=mask.points.find(item=>item.index===0)
    ok(point.married===glucose.key,"the explicit choice is the marriage")
    ok(point.mismatch===false,"and it now agrees with the isotopic reading")
})

test("les propositions en double ne comptent qu'une fois",()=>{
    const candidates=normaliseCandidates([
        reading(glucose,0),
        reading(glucose,0)
    ])
    ok(candidates.length===1,"the same (formula, peak) is one candidate")
})

test("les éléments proposés listent leurs isotopes par A croissant",()=>{
    const elements=elementsInProposals([reading(glucose,0)])
    const c=elements.find(item=>item.symbol==="C")
    ok(c,`carbon must be present, got ${elements.map(item=>item.symbol)}`)
    ok(c.isotopes.map(isotope=>isotope.A).join(",")==="12,13","C has 12 then 13")
    ok(c.proposalCount===1,"one proposal carries carbon")
})

test("un couple d'isotopes absent ne prétend rien calculer",()=>{
    const mask=computeFunnelMask({
        entries:[reading(glucose,0)],
        element:"S",lightA:32,heavyA:34
    })
    ok(mask.available===false,"sulfur is not in the proposals")
    ok(mask.ratios.length===0,"and nothing is computed")
})

console.log(`\n${passed} passed, ${failures.length} failed`)
if(failures.length){
    console.log(failures.join("\n"))
    process.exit(1)
}
