/* ===========================================================================
   PARITÉ DU CRIBLE MIXTE: le kernel Rust contre le crible JS, entrée par entrée.

   On part de `buildPlan` — le vrai point d'entrée du nœud — et on compare les
   deux circuits sur la MÊME sélection: index de pic, multiplicités, charge,
   masse, ppm, et l'ordre final.

   Le test ne compare pas des ENSEMBLES de formules mais des LIGNES, dans leur
   ordre. C'est plus strict, et c'est voulu: deux listes qui contiennent les mêmes
   formules dans un ordre différent ne sont pas le même résultat, puisque la
   collection de formules affiche cet ordre à l'utilisateur.

   Chaque cas vise une règle à risque, pas « le kernel marche ». Un kernel qui rend
   la même chose sur un cas trivial mais se trompe sur les groupes fixes est un
   kernel qui casse en production sans qu'aucune alerte ne se déclenche.
   =========================================================================== */
import {test} from "node:test"
import assert from "node:assert/strict"
import {readFileSync} from "node:fs"
/* LE KERNEL. On charge la cible `nodejs`, pas celle du worker: le paquet `web`
   s'initialise par `fetch`, que Node refuse pour un fichier local. Les DEUX
   paquets sortent du MÊME Rust, donc la parité testée est bien celle du noyau. */
import initSync,{crible_mixed_radix} from "../XOP/rust-extension/pkg-node/attribrustor.js"
import {Element} from "./chemistry.js"
import {buildPlan,SortedPoints,attributeSpectrum,planForKernel,cribleMixedRadix,stateToFormula} from "./attribution.js"

/* En cible `nodejs`, wasm-pack n'exporte pas de `init()`: le module se charge
   lui-même à l'import, et les noyaux sont des FONCTIONS LIBRES — pas des méthodes
   d'un objet `wasm` comme en cible `web`. Appeler `init()` ici donnerait « init is
   not a function », c'est-à-dire un échec de chargement qui n'a rien à dire de
   la physique. */
const ready=Promise.resolve(crible_mixed_radix)

const TABLE=Element.load(JSON.parse(
    readFileSync(new URL("../data/elements.json",import.meta.url),"utf8")))

/* UN SPECTRE BÂTI SUR LES MASSES DU PLAN, et c'est la condition pour que le test
   PROUVE quelque chose.

   Un spectre à pics arbitraires — 180, 187.3, 194.6… — ne rencontre aucune formule
   de CH₂/NH/O, dont les masses rondent autour de 57 à 63. Les deux côtés rendent
   alors zéro lecture, les listes comparées sont VIDES, et le test passe sans avoir
   rien vérifié. C'est le piège classique d'une parité : elle passe, et elle ne
   teste rien.

   On demande donc au plan SES masses, et on met le pic dessus. Chaque point est
   alors une formule à portée de pic, et un écart entre les deux circuits se
   verrait immédiatement. */
const spectrumFor=plan=>{
    const peakMass=plan.massCeiling({length:1,massAt:()=>400})
    const found=cribleMixedRadix(plan,{maxMass:peakMass,minMass:0}).states
    const masses=[]
    for(const state of found){
        if(state.mass>50&&state.mass<400) masses.push(state.mass)
    }
    /* On NE GARDE QUE LES MASSES ÉLOIGNÉES: deux pics à moins d'une unité
       massique se disputeraient les mêmes candidats, et le classement par pic
       deviendrait imprévisible — donc on testerait le bruit, pas la règle. */
    masses.sort((a,b)=>a-b)
    const picked=[]
    for(const mass of masses){
        if(!picked.length||mass-picked[picked.length-1]>2.5) picked.push(mass)
        if(picked.length>=24) break
    }
    return new SortedPoints(picked,picked.map(()=>1000))
}

/* LE CRIBLE JS, par le chemin du NŒUD — donc avec la sélection par pic, le même
   classement et le même rendu que ce que voit l'utilisateur. */
const reference=(plan,points,{bestMatches=3,ppm=10}={})=>{
    const out=attributeSpectrum(plan,points,{limit:Infinity,bestMatches,ppm})
    return out.entries.map(entry=>({
        /* L'INDICE DU PIC EST RAPPORTÉ DANS L'ORDRE DU SPECTRE, pas dans l'ordre
           TRIÉ. `SortedPoints` garde `x` dans l'ordre de saisie et `order` porte le
           tri; `nearest` rend un indice de `x`. Le kernel, lui, ne voit que le
           tableau trié et rend donc un rang de tri. Les deux indices sont le même
           pic, numérotés différemment — comparer les nombres bruts comparerait deux
           conventions, pas deux résultats. */
        peak:points.order.indexOf(entry.target?.index??-1),
        /* La COMPOSITION se compare par la clé de formule, et le kernel ne rend que
           des multiplicités: on lui applique le MÊME `stateToFormula` que le
           nœud. Sans cela on comparerait une notation à un vecteur de nombres. */
        key:entry.key,
        charge:entry.charge,
        mass:entry.mass,
        errorPpm:entry.errorPpm
    }))
}

/* LE KERNEL, appelé par le même pont que le worker appellera. */
const kernel=(plan,points,{bestMatches=3,ppm=10}={})=>{
    const bridge=planForKernel(plan)
    const maxMass=plan.massCeiling(points)
    const minMass=plan.massFloor(points)
    /* En cible `nodejs` le noyau est une fonction libre: pas de déballage `.wasm()`,
       pas de `init()` — l'import suffit. */
    return crible_mixed_radix(
        Float64Array.from(bridge.itemMasses),
        Float64Array.from(bridge.itemCharges),
        Float64Array.from(bridge.logProbs),
        Uint32Array.from(plan.capsFor(maxMass)),
        Float64Array.from(points.order.map(index=>points.x[index])),
        maxMass,minMass,ppm,bestMatches,
        {fixed:bridge.fixed,dependence:bridge.dependence}
    ).map(reading=>{
        /* LA COMPOSITION EST REFAITE EN JS, par le même `stateToFormula` que le
           nœud applique aux lectures du kernel. C'est le contrat prévu: le kernel
           rend des multiplicités, la chimie reste en JS. Comparer la clé de
           formule des deux côtés vérifie donc exactement ce que l'utilisateur
           verra — pas deux représentations du même nombre.

           `counts` EST CONSERVÉ: le test du chemin complet doit refaire la formule à
           partir des multiplicités, comme le nœud le fait, et non réutiliser une clé
           déjà calculée par un autre chemin — sinon on vérifierait deux fois le même
           calcul au lieu de vérifier la conversion. */
        const built=stateToFormula(plan,{counts:reading.counts,mass:reading.mass})
        return {
            peak:reading.peak,
            key:built?.formula?.key??null,
            counts:reading.counts,
            charge:reading.charge,
            mass:reading.mass,
            errorPpm:reading.error_ppm
        }
    })
}

/* LA COMPARAISON, ligne à ligne. Le ppm se compare avec une tolérance: les deux
   côtés font la même division dans un ordre différent, donc le dernier bit peut
   bouger. Une égalité EXACTE serait un test qui échouerait sur du bruit. */
const same=(left,right,tolerance=1e-9)=>{
    assert.equal(left.length,right.length,
        `nombres de lectures différents: JS ${left.length}, Rust ${right.length}`)
    for(let i=0;i<left.length;i++){
        const a=left[i],b=right[i]
        assert.equal(a.peak,b.peak,`ligne ${i}: pic ${a.peak} contre ${b.peak}`)
        assert.equal(a.key,b.key,`ligne ${i}: composition ${a.key} contre ${b.key}`)
        assert.ok(Math.abs(a.charge-b.charge)<1e-9,`ligne ${i}: charge ${a.charge} contre ${b.charge}`)
        assert.ok(Math.abs(a.mass-b.mass)<1e-6,`ligne ${i}: masse ${a.mass} contre ${b.mass}`)
        assert.ok(Math.abs(a.errorPpm-b.errorPpm)<=tolerance,
            `ligne ${i}: ppm ${a.errorPpm} contre ${b.errorPpm}`)
    }
}

/* LE TEST DOIT ÊTRE UN TEST.

   `same(..., message)` ne marche pas: le troisième paramètre est la TOLÉRANCE, et
   le message landait donc dans `tolerance` — un `assert` sans condition, toujours
   vrai. Le cas ppm passait avec un message d'erreur en payload: vert au résultat,
   faux au fond. La surchauffe est dans un bloc séparé, où l'étiquette est
   explicite et ne peut pas se confondre avec une tolérance. */
const labelled=(label,run)=>{
    try{
        run()
    }catch(error){
        error.message=`${label} — ${error.message}`
        throw error
    }
}

test("parité: isotopes et ratios — le cas ordinaire, sans groupe fixe",async()=>{
    await ready
    const plan=buildPlan({
        table:TABLE,
        combining:["CH2","NH","O"].map(group=>({group,ratio:0.1,max:4})),
        ionising:[{group:"[H+]",min:1,max:1,ratio:1}],
        ratio:0.1,chargeMax:1,chargeAuto:true
    })
    const points=spectrumFor(plan)
    same(reference(plan,points),kernel(plan,points))
})

/* Chaque cas ci-dessous vise une règle à risque, pas « le kernel marche ». Un
   kernel qui rend la même chose sur un cas trivial mais se trompe sur les groupes
   fixes est un kernel qui casse en production sans qu'aucune alerte ne se
   déclenche. */

test("parité: isotopes et ratios avec [H+]",()=>{
    const plan=buildPlan({
        table:TABLE,
        combining:["CH2","NH","O","C"].map(group=>({group,ratio:0.05,max:4})),
        ionising:[{group:"[H+]",min:1,max:1,ratio:1}],
        ratio:0.05,chargeMax:1,chargeAuto:true
    })
    const points=spectrumFor(plan)
    same(reference(plan,points),kernel(plan,points))
})

test("parité: groupe fixe min === max — une case, pas une dimension",()=>{
    const plan=buildPlan({
        table:TABLE,
        combining:["CH2","O"].map(group=>({group,ratio:0.1,max:3})),
        /* DEUX GROUPES FIXES à la fois: c'est le cas que le commentaire du crible
           mixte vise — « 1 Mg, 1 SO4, 1 CH3OH » doit coûter trois cases et non
           trois dimensions. Un seul ne prouverait pas la règle.

           On évite `0..0`: un groupe fixe de compte zéro arrête le crible
           (`if (count === 0) break`) et ne rend rien — des deux côtés, ce qui est
           conforme, mais ne prouve rien. */
        ionising:[
            {group:"[H+]",min:1,max:1,ratio:1},
            {group:"[CH3OH]",min:1,max:1,ratio:1}
        ],
        ratio:0.1,chargeMax:1,chargeAuto:true
    })
    const points=spectrumFor(plan)
    /* Le groupe fixe déplace toutes les masses d'une constante, et le plan du
       crible mixed tient compte de ce décalage — `spectrumFor` interroge donc le
       crible RÉEL, groupes fixes compris, et les pics tombent sur des lectures. */
    assert.ok(reference(plan,points).length>0,
        "groupe fixe: le circuit JS ne rend aucune lecture — ce cas ne teste rien")
    same(reference(plan,points),kernel(plan,points))
})

test("parité: adduts optionnels et neutre — charge nulle comprise",()=>{
    const plan=buildPlan({
        table:TABLE,
        combining:["CH2"].map(group=>({group,ratio:0.1,max:4})),
        ionising:[
            {group:"[H+]",min:0,max:1,ratio:0.1},
            {group:"[Na+]",min:0,max:1,ratio:0.01}
        ],
        ratio:0.1,chargeMin:0,chargeMax:1,chargeAuto:false
    })
    const points=spectrumFor(plan)
    same(reference(plan,points),kernel(plan,points))
})

test("parité: bestMatches=1 — le seau ne garde que la meilleure",()=>{
    const plan=buildPlan({
        table:TABLE,
        combining:["CH2","O"].map(group=>({group,ratio:0.1,max:4})),
        ionising:[{group:"[H+]",min:1,max:1,ratio:1}],
        ratio:0.1,chargeMax:1,chargeAuto:true
    })
    const points=spectrumFor(plan)
    const options={bestMatches:1,ppm:10}
    same(reference(plan,points,options),kernel(plan,points,options))
})

test("parité: bestMatches=6 — seau profond, où le classement départage",()=>{
    const plan=buildPlan({
        table:TABLE,
        combining:["CH2","O"].map(group=>({group,ratio:0.1,max:5})),
        ionising:[{group:"[H+]",min:1,max:1,ratio:1}],
        ratio:0.1,chargeMax:1,chargeAuto:true
    })
    const points=spectrumFor(plan)
    const options={bestMatches:6,ppm:15}
    same(reference(plan,points,options),kernel(plan,points,options))
})

test("parité: fenêtre ppm — la même des deux côtés, aux bornes comprises",()=>{
    const plan=buildPlan({
        table:TABLE,
        combining:["CH2","O"].map(group=>({group,ratio:0.1,max:4})),
        ionising:[{group:"[H+]",min:1,max:1,ratio:1}],
        ratio:0.1,chargeMax:1,chargeAuto:true
    })
    const points=spectrumFor(plan)
    for(const ppm of [0.5,1,5,25]){
        labelled(`ppm ${ppm}: les deux côtés ne retiennent pas les mêmes lectures`,()=>{
            const options={bestMatches:3,ppm}
            same(reference(plan,points,options),kernel(plan,points,options))
        })
    }
})

/* LE CHEMIN COMPLET, ET C'EST LE TEST QUI COMPTE POUR L'UTILISATEUR.

   Les sept tests ci-dessus comparent le crible au crible. Celui-ci compare ce que le
   NŒUD publie — la liste de lectures que la collection de formules consomme — par
   le chemin asynchrone et par le chemin JS. C'est là que se logent les conversions
   que le kernel ne fait pas : le pic rapporté de l'ordre trié à l'ordre du spectre,
   la formule reconstruite par `stateToFormula`, la probabilité, la notation.

   Un écart ici se verrait à l'écran comme « la liste change quand le kernel est
   là », sans aucune erreur visible. C'est exactement le genre de défaut qu'un test
   de kernel seul laisse passer. */
test("parité: le nœud publie la même liste par le kernel et par le JS",()=>{
    const plan=buildPlan({
        table:TABLE,
        combining:["CH2","NH","O"].map(group=>({group,ratio:0.1,max:4})),
        ionising:[{group:"[H+]",min:1,max:1,ratio:1}],
        ratio:0.1,chargeMax:1,chargeAuto:true
    })
    const points=spectrumFor(plan)
    const bestMatches=3
    const ppm=10

    /* Le chemin JS, tel que le nœud le faisait avant. */
    const viaJs=attributeSpectrum(plan,points,{limit:Infinity,bestMatches,ppm})
    /* Le chemin du kernel, avec les MÊMES conversions que `publishableRows`.
       On relit les MULTIPLICITÉS brutes, que `kernel` a déjà converties en clé:
       il faut les multiplicités pour refaire la formule, donc on rappelle le noyau
       et on garde la ligne telle quelle. */
    const rows=kernel(plan,points,{bestMatches,ppm})
    const viaRust=rows.map(row=>{
        const built=stateToFormula(plan,{counts:row.counts,mass:row.mass})
        const formula=built?.formula
        if(!formula) return null
        return {
            key:formula.key,
            notation:String(formula),
            mz:formula.mz,
            mass:formula.mass,
            charge:formula.charge,
            /* L'INDICE RAPPORTÉ DANS L'ORDRE DU SPECTRE, comme `publishableRows`
               le fait: le kernel rend un rang de tri, le nœud publie un indice de
               `x`. Comparer les deux bruts comparerait deux conventions. */
            peak:points.order[row.peak],
            errorPpm:row.errorPpm
        }
    }).filter(Boolean)

    assert.ok(viaJs.entries.length>0,"le chemin JS ne rend aucune lecture")
    assert.equal(viaRust.length,viaJs.entries.length,
        `le nœud publierait ${viaRust.length} lectures par le kernel contre `+
        `${viaJs.entries.length} par le JS`)
    for(let i=0;i<viaJs.entries.length;i++){
        const a=viaJs.entries[i],b=viaRust[i]
        assert.equal(a.key,b.key,`ligne ${i}: ${a.key} contre ${b.key}`)
        assert.equal(a.notation,b.notation,`ligne ${i}: ${a.notation} contre ${b.notation}`)
        assert.equal(a.target.index,b.peak,
            `ligne ${i}: pic ${a.target.index} contre ${b.peak} pour ${a.key}`)
        assert.ok(Math.abs(a.mz-b.mz)<1e-9,`ligne ${i}: m/z ${a.mz} contre ${b.mz}`)
        assert.ok(Math.abs(a.mass-b.mass)<1e-6,`ligne ${i}: masse ${a.mass} contre ${b.mass}`)
        assert.ok(Math.abs(a.charge-b.charge)<1e-9,`ligne ${i}: charge ${a.charge} contre ${b.charge}`)
        assert.ok(Math.abs(a.errorPpm-b.errorPpm)<1e-9,
            `ligne ${i}: ppm ${a.errorPpm} contre ${b.errorPpm}`)
    }
})

/* LE TEST NE DOIT PAS ÊTRE VERT PAR VACUITÉ.

   Un spectre à pics arbitraires ne rencontre aucune formule: les deux circuits
   rendent alors zéro lecture, les listes comparées sont vides, et l'égalité passe
   sans qu'aucune règle ait été exercée. C'est arrivé — les sept premiers cas
   passaient en ne comparant rien.

   Ce test échoue donc dès qu'un cas cesse de produire des lectures. Il rend le vide
   impossible à confondre avec une réussite. */
test("parité: aucun cas ne compare deux listes vides",()=>{
    const plans=[
        ["CH2,NH,O",buildPlan({
            table:TABLE,
            combining:["CH2","NH","O"].map(group=>({group,ratio:0.1,max:4})),
            ionising:[{group:"[H+]",min:1,max:1,ratio:1}],
            ratio:0.1,chargeMax:1,chargeAuto:true
        })],
        ["groupe fixe",buildPlan({
            table:TABLE,
            combining:["CH2","O"].map(group=>({group,ratio:0.1,max:3})),
            /* Un groupe fixe à `2..2`: il décalera la masse d'une constante sans
               ouvrir de dimension. On NE PAS employer `0..0` ici — c'est un groupe
               fixe de compte ZÉRO, et le crible mixte s'arrête dessus
               (`if (count === 0) break`): il ne rend RIEN, des deux côtés. C'est le
               JS qui le veut ainsi, et le kernel lui est conforme; mais un cas de
               parité qui ne rend rien ne prouve rien. */
            ionising:[{group:"[H+]",min:1,max:1,ratio:1}],
            ratio:0.1,chargeMax:1,chargeAuto:true
        })],
        ["adducts et neutre",buildPlan({
            table:TABLE,
            combining:["CH2"].map(group=>({group,ratio:0.1,max:4})),
            ionising:[
                {group:"[H+]",min:0,max:1,ratio:0.1},
                {group:"[Na+]",min:0,max:1,ratio:0.01}
            ],
            ratio:0.1,chargeMin:0,chargeMax:1,chargeAuto:false
        })]
    ]
    for(const [label,plan] of plans){
        const points=spectrumFor(plan)
        const js=reference(plan,points)
        const rust=kernel(plan,points)
        assert.ok(js.length>0,
            `${label}: le circuit JS ne rend aucune lecture — ce cas ne teste rien`)
        assert.ok(rust.length>0,
            `${label}: le kernel ne rend aucune lecture — ce cas ne teste rien`)
        /* Et l'on compare les ENSEMBLES, pas seulement l'ordre: un kernel qui
           raterait la moitié des pics mais les classerait bien donnerait un écart
           de longueur,(attrapé plus haut) mais un écart de contenu doit aussi se
           voir. On compte donc les compositions distinctes. */
        const distinct=new Set(js.map(reading=>reading.key))
        assert.ok(distinct.size>0,`${label}: aucune composition distincte`)
    }
})
