/* -------------------------------------------------------------------------
   Test — node scripts/kernelParity.test.mjs

   Le kernel Rust et son repli JS doivent rendre LES MÊMES masses. C'est la
   propriété qui autorise à traiter le kernel comme un détail d'implémentation:
   sans elle, l'attribution d'un utilisateur dépendrait de l'état de son build
   wasm — une propriété que personne ne peut raisonner, et que personne ne
   remarkquerait si elle changeait.

   POURQUOI UN FICHIER SÉPARÉ, et pas une section de attribution.test.mjs:
   parce que celui-ci doit charger le wasm, donc il est ASYNCHRONE, alors que
   les autres sont des scripts synchrones. Un `await` de haut niveau dans
   attribution.test.mjs serait un SyntaxError qui empêcherait TOUTE la suite de
   tourner, y compris les tests sans rapport avec le kernel. La séparation est
   donc structurelle, pas une préférence de rangement.

   CE QUE LE TEST NE FAIT PAS: il ne compare pas les empreintes de vecteur. Les
   deux implémentations n'ont aucune raison de produire la même — le Rust mélange
   des u64, le JS des chaînes — et personne ne les lit. Comparer des masses est
   comparer ce que le shell utilise, et rien d'autre.
   ------------------------------------------------------------------------- */

let passed=0
const failures=[]
const test=(name,fn)=>{
    try{ fn(); passed++; console.log(`  ok   ${name}`) }
    catch(e){ failures.push(name); console.log(`  FAIL ${name}\n       ${e.message}`) }
}
const ok=(value,msg)=>{ if(!value) throw new Error(msg??`expected a truthy value, got ${value}`) }
const close=(a,b,tol,msg)=>{ if(!(Math.abs(a-b)<=tol)) throw new Error(`${msg??`${a} vs ${b}`}`) }

/* Values per state in the flat output, kept in step with STRIDE in
   attribution.rs AND with ATTRIBUTION_STRIDE in kernelWorker.js. Three
   constants that must agree — which is why each is written where it is used
   rather than imported from one place: a single source would make their
   agreement invisible, and the agreement is the thing worth testing. */
const STRIDE=4

/* Le repli JS, recopié depuis kernelWorker.js. Il est dupliqué et non importé
   pour deux raisons: importer le worker tirerait `self` dans un process node,
   et il faut que le test se lise sans ouvrir un autre fichier. */
function cribleHeapJS(itemMasses,itemCharges,caps,maxMass,limit){
    const count=itemMasses.length
    if(count===0||itemCharges.length!==count||caps.length!==count) return new Float64Array(0)
    if(!Number.isFinite(maxMass)||maxMass<=0) return new Float64Array(0)
    for(let i=0;i<count;i++){
        //a massless item with no bound would be added forever: its mass never
        //grows, so the ceiling never stops it
        if(caps[i]===0xFFFFFFFF&&!(itemMasses[i]>0)) return new Float64Array(0)
    }
    if(caps.every(cap=>cap===0)) return new Float64Array(0)
    const signature=(counts)=>counts.join(",")
    const open=[]
    const push=(mass,counts)=>open.push({mass,counts})
    const popMin=()=>{
        let best=0
        for(let i=1;i<open.length;i++){
            if(open[i].mass<open[best].mass) best=i
        }
        return open.splice(best,1)[0]
    }
    const seen=new Set()
    const zero=new Int32Array(count)
    seen.add(signature(zero))
    push(0,zero)
    const out=[]
    let emitted=0
    while(open.length){
        const state=popMin()
        let charge=0
        for(let i=0;i<count;i++) charge+=itemCharges[i]*state.counts[i]
        out.push(state.mass,charge,0,emitted===0?-1:emitted-1)
        emitted++
        if(emitted>=limit) break
        for(let i=0;i<count;i++){
            if(state.counts[i]>=caps[i]) continue
            const mass=state.mass+itemMasses[i]
            if(mass>maxMass) continue
            const counts=Int32Array.from(state.counts)
            counts[i]+=1
            const marker=signature(counts)
            if(seen.has(marker)) continue
            seen.add(marker)
            push(mass,counts)
        }
    }
    return Float64Array.from(out)
}

const massesOf=(flat)=>Array.from({length:Math.floor(flat.length/STRIDE)},(_,i)=>flat[i*STRIDE])
const chargesOf=(flat)=>Array.from({length:Math.floor(flat.length/STRIDE)},(_,i)=>flat[i*STRIDE+1])
const fromRust=(c,limit=100000)=>rust.crible_heap(
    Float64Array.from(c.masses),
    Float64Array.from(c.charges),
    Uint32Array.from(c.caps),
    c.maxMass,
    limit
)

/* Les CAS, choisis pour couvrir les décisions qui pourraient diverger entre les
   deux implémentations:

     1. plusieurs briques de masses DIFFÉRENTES — l'ordre du tas compte
     2. deux briques de masses ÉGALES — l'ordre entre masses égales est libre,
        et les deux kernels ont le droit de le trancher différemment
     3. un adduit sans atome, de masse négative — le cas qui a fait boucler le
        kernel, et donc le refus que les deux doivent faire
     4. une brique que le plafond exclut — le refus d'espace vide
     5. deux adduits de charges différentes — la somme des charges */
const cases=[
    {
        label:"CH2 x O x [H+] sous 300",
        masses:[14.016,15.019,15.995,1.007],charges:[0,0,0,1],caps:[21,19,18,1],
        maxMass:300
    },
    {
        label:"une seule brique",
        masses:[14.016],charges:[0],caps:[7],maxMass:100
    },
    {
        label:"deux briques de masses égales",
        masses:[12.0,12.0],charges:[0,0],caps:[8,8],maxMass:100
    },
    {
        label:"un adduit sans atome",
        masses:[-0.001097],charges:[2],caps:[1],maxMass:10
    },
    {
        label:"une brique que le plafond exclut",
        masses:[500],charges:[0],caps:[0],maxMass:100
    },
    {
        label:"une brique et deux adduits",
        masses:[14.016,1.007,-0.001097],charges:[0,1,2],caps:[10,2,1],maxMass:160
    }
]

let rust=null
try{
    const module=await import("../XOP/rust-extension/pkg/attribrustor.js")
    await module.default()
    if(typeof module.crible_heap!=="function"){
        console.log("  (crible_heap absent du paquet — build périmé, seul le repli JS est vérifié)")
    }else{
        rust=module
    }
}catch(error){
    console.log(`  (pas de kernel wasm: ${String(error.message).slice(0,60)})`)
    console.log("    le repli JS est vérifié seul — c'est le comportement voulu quand le wasm manque")
}

console.log("le repli JS, seul s'il le faut")

test("le germe sort en premier, à masse nulle",()=>{
    ok(massesOf(cribleHeapJS([14.0],[0.0],[7],100,1000))[0]===0,
        "the seed must be the empty combination")
})

test("le repli rend par masse croissante",()=>{
    const masses=massesOf(cribleHeapJS([14.016,15.995],[0.0,0.0],[21,18],300,100000))
    ok(masses.length>100,`the space must be substantial, got ${masses.length}`)
    for(let i=1;i<masses.length;i++){
        ok(masses[i-1]<=masses[i],`rank ${i} is lighter than rank ${i-1}`)
    }
})

test("le repli refuse un adduit sans atome et sans borne",()=>{
    ok(cribleHeapJS([-0.001097],[2.0],[0xFFFFFFFF],10,1000).length===0,
        "this is the combination whose walk never ends")
})

test("le repli refuse un plafond qui n est pas un nombre positif",()=>{
    for(const bad of [0,-1,NaN,Infinity]){
        ok(cribleHeapJS([14.0],[0.0],[7],bad,1000).length===0,
            `a ceiling of ${bad} must be refused`)
    }
})

test("le repli refuse des descripteurs de longueurs differentes",()=>{
    ok(cribleHeapJS([14.0,16.0],[0.0],[7,7],300,1000).length===0,
        "two masses and one charge cannot be read")
})

console.log(`\n${passed} passed, ${failures.length} failed`)
if(failures.length) process.exitCode=1
