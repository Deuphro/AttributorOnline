/* -------------------------------------------------------------------------
   clusteringBench.mjs — où le temps passe-t-il, réellement ?

       node scripts/clusteringBench.mjs [n]

       Chronomètre les trois kernels (Rust WASM et fallback JS) sur des
       données de la taille d'une vraie collection : n points, 3 features
       (mz, intensité, erreur), comme computeClustering les fabrique.
       Le calcul PUR d'un k-means ou d'une PCA doit être une fraction de
       milliseconde : si l'interface est lente, ce n'est pas ici que ça
       se passe — cf. les notes en bas de sortie.
   ------------------------------------------------------------------------- */
import {readFileSync} from "fs"
import {fileURLToPath} from "url"
import {dirname, join} from "path"
import init,* as rust from "../XOP/rust-extension/pkg/attribrustor.js"

const here=dirname(fileURLToPath(import.meta.url))
await init(readFileSync(join(here,"../XOP/rust-extension/pkg/attribrustor_bg.wasm")))

const workerSource=readFileSync(join(here,"kernelWorker.js"),"utf8")
function harvest(name){
    const start=workerSource.indexOf(`function ${name}(`)
    if(start<0) throw new Error(`${name} is no longer in kernelWorker.js`)
    let depth=0,began=false
    for(let i=workerSource.indexOf("{",start);i<workerSource.length;i++){
        if(workerSource[i]==="{"){depth++;began=true}
        else if(workerSource[i]==="}"){
            depth--
            if(began&&depth===0) return workerSource.slice(start,i+1)
        }
    }
    throw new Error(`${name} is not balanced in kernelWorker.js`)
}
const {pcaJS,kmeansJS,spectralJS}=new Function(
    ["pcaJS","kmeansJS","spectralJS","kmeansOnEmbeddingJS","estimateSigmaJS"].map(harvest).join("\n")
    +"; return {pcaJS,kmeansJS,spectralJS}"
)()

/* Data as the node builds it: n points, f=3 features, deterministic. */
function makeData(n,f=3){
    const data=new Float64Array(n*f)
    let state=123456789
    const rand=()=>{ state=(state*6364136223846793005+1442695040888963407)>>>0; return state/4294967296 }
    for(let i=0;i<n*f;i++) data[i]=rand()*100+(i%f)*7
    return data
}
const ms=(label,fn)=>{
    const start=performance.now()
    const out=fn()
    const dt=performance.now()-start
    console.log(`  ${label.padEnd(52)} ${dt.toFixed(1).padStart(9)} ms`)
    return out
}

const n=Number(process.argv[2]??5000)
const f=3,kClusters=5
const data=makeData(n,f)
console.log(`\n${n} points × ${f} features (mz / intensité / erreur), k=${kClusters}\n`)

console.log("PCA (décorrélation)")
ms("rust pca_project → 3 composantes",()=>rust.pca_project(data,n,f,f))
ms("JS  pcaJS        → 3 composantes",()=>pcaJS(data,n,f,f))

console.log("\nk-means (100 itérations)")
ms("rust kmeans_cluster",()=>rust.kmeans_cluster(data,n,f,kClusters,100,42n))
ms("JS  kmeansJS       ",()=>kmeansJS(data,n,f,kClusters,100,42))

console.log("\nspectral (sigma auto, 10 voisins)")
const rustSpectral=ms("rust spectral_cluster",()=>rust.spectral_cluster(data,n,f,kClusters,0,10))
console.log(`  (sortie: ${rustSpectral.length} valeurs = ${n} assignations + embedding ${n}×${kClusters} + centres + comptes)`)
ms("JS  spectralJS     ",()=>spectralJS(data,n,f,kClusters,0,10))

console.log(`
Interprétation — le kernel n'est PAS ce qui coûte, sauf spectral :
  • la PCA porte ${n}×3 nombres et une matrice 3×3 : μs, toujours ;
  • le k-means fait ${n}×3×${kClusters}×100 ≈ ${((n*3*kClusters*100)/1e6).toFixed(0)} M opérations : ms ;
  • le spectral alloue une matrice ${n}×${n} = ${((n*n*8)/1048576).toFixed(0)} MiB et la
    multiplie ~une centaine de fois par composante : c'est le seul à temps
    quadratique, et il est lent PAR CONSTRUCTION tant qu'il est dense.
Si l'INTERFACE est lente même sur la PCA, le temps est ailleurs :
  1. chaque changement de paramètre (k, seed, σ, voisins, composantes)
     relance le pipeline SANS debounce et SANS garde de réentrance —
     les runs s'empilent dans la file du pool ;
  2. chaque run se termine par refreshGraph() (reconstruction des traces,
     Map des assignations, redessin) ;
  3. saveSessionSoon() sur chaque changement sérialise la SESSION ENTIÈRE ;
  4. premier run : fetch + compilation du .wasm dans le worker (~1 fois) ;
  5. PCA + k-means = DEUX aller-retours worker au lieu d'un.`)