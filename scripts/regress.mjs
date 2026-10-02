/* -------------------------------------------------------------------------
   regress.mjs — CHAQUE TEST PROTÈGE-T-IL QUELQUE CHOSE ?

       « 64 passed » ne prouve qu'une chose: le test passe sur le code qu'il
       décrit. Pour dire qu'un test ATTACHE quelque chose, il faut retirer la
       ligne qu'il protège et vérifier qu'il échoue.

           node scripts/regress.mjs

       Chaque cas remet la faute, lance la suite, puis restaure. Une faute que
       la suite ne voit pas est un test qui ne protège rien — et il est
       rapporté comme tel.
   ------------------------------------------------------------------------- */
import {reintroduce,log} from "./harness.mjs"
import {execFileSync} from "child_process"
import path from "path"
import {fileURLToPath} from "url"

const HERE=path.dirname(fileURLToPath(import.meta.url))
const suite=path.join(HERE,"attribution.test.mjs")

/* Chaque cas: le motif à retirer, et ce qu'on remet à la place. Le motif est
   cité EXACTEMENT, sinon `reintroduce` refuse — ce qui vaut mieux qu'un test
   qui passe à vide parce que le motif n'a plus été trouvé. */
const CASES=[
    {
        what:"BUG 2 — le filtre qui écartait la charge 0",
        file:"scripts/attribution.js",
        from:".filter(v=>Number.isFinite(v))",
        to:".filter(v=>v>0&&Number.isFinite(v))"
    },
    {
        what:"BUG 2 — l'union qui inventait un neutre après un adduit obligatoire",
        file:"scripts/attribution.js",
        from:"            sums=next\n",
        to:"            for(const value of next) sums.add(value)\n"
    },
    {
        what:"BUG 2bis — la fenêtre de charge qui ne descendait jamais à 0",
        file:"scripts/attribution.js",
        from:"if(low!==this.chargeMin) this.chargeMin=low",
        to:"if(low>0) this.chargeMin=low"
    },
    {
        what:"NEUTRES — les neutres jetés à la sélection",
        file:"scripts/attribution.js",
        from:"const target=sorted.nearest(state.mass/Math.max(1,Math.abs(charge)))",
        to:"if(!charge) return; const target=sorted.nearest(state.mass/charge)"
    },
    {
        what:"NEUTRES — une liste ionisante vide rendue « aucune charge »",
        file:"scripts/attribution.js",
        from:"if(!anyAdduct) return [0]",
        to:"if(!anyAdduct) return null"
    },
    {
        /* LE SABOTAGE DOIT ÊTRE CIBLE ET COMPILE.

           La première version remplaçait `const ratioFor=new Map()` par un
           nombre, ce qui faisait planter `chemistry.js` sur
           `ratioFor?.get is not a function` — et TOUS les tests tombaient. Une
           suite qui casse en masse protège quelque chose, mais elle ne prouve
           plus que le test visé le voit.

           On retire donc la LIGNE qui pose le verrou, en laissant `ratioFor`
           vide: c'est exactement l'état d'avant la correction du défaut 3quater
           — le groupe entier s'ouvre — et la suite compile. */
        what:"BUG 3 — le verrou d'isotope retiré du groupe entier",
        file:"scripts/attribution.js",
        from:"            for(const element of written.keys()) ratioFor.set(element,0)\n",
        to:""
    },
    {
        what:"ÉCRAN — bestMatches/ppm qui attendent un clic",
        file:"scripts/interface.js",
        from:'        if(name==="bestMatches"||name==="ppm"){\n'+
            "            return this.startResolve().then(()=>this.resolveChildren())\n"+
            "        }\n",
        to:""
    }
]

/* LE CODE DE SORTIE SEULEMENT, et non le texte.

   `execFileSync` lève sur un code non nul, et ce code vaut exactement ce qu'il
   doit: la suite fait `process.exitCode=1` quand un test échoue. Les
   avertissements de Node (MODULE_TYPELESS_PACKAGE_JSON) partent sur stderr et
   ne changent rien au code — les lire comme un échec donnait un faux « la
   suite échoue » sur du code parfaitement correct. */
const runSuite=()=>{
    try{
        const out=execFileSync(process.execPath,[suite],{
            encoding:"utf8",
            stdio:["ignore","pipe","ignore"]
        })
        return {out,sawFailure:false}
    }catch(error){
        /* `status` est le code du processus fils; `sawFailure` ne vaut vrai que
           pour le code 1, qui est celui que la suite pose en cas d'échec. */
        return {out:String(error.stdout??""),sawFailure:error.status===1}
    }
}
const summary=out=>out.split(/\r?\n/).filter(l=>/passed,/.test(l)).pop()??"(aucun résumé)"

const baseline=runSuite()
log(`reference : ${summary(baseline.out)}`)
if(baseline.sawFailure){
    log("the suite FAILS on the current code — stop, something is wrong")
    process.exit(1)
}

let unguarded=0
for(const testCase of CASES){
    const restore=await reintroduce(testCase.file,testCase.from,testCase.to)
    const result=runSuite()
    await restore()
    if(!result.sawFailure){
        log(`  PAS VU    ${testCase.what}`)
        log(`            (la suite passe encore: ${summary(result.out)})`)
        unguarded++
    }else{
        log(`  détecté   ${testCase.what}`)
        log(`            ${summary(result.out)}`)
    }
}

log(`\n${CASES.length-unguarded}/${CASES.length} fautes sont vues par la suite`)
if(unguarded) process.exitCode=1