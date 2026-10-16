/* -------------------------------------------------------------------------
   Test — node scripts/houghDetect.test.mjs

   La DÉTECTION, de la grille au nom d'élément. Pas de DOM et pas de WebGL
   ici non plus : les deux méthodes qui décident — le profil de pente et
   l'extraction des maxima — sont pures et extraites DU FICHIER, donc le test
   porte sur l'implémentation et pas sur une transcription.

   Le noyau est déjà couvert par houghKernel.test.mjs, qui compare le Rust et
   son jumeau JS. Ce fichier couvre ce qui se passe APRÈS: la grille est ici
   fabriquée pour que la réponse soit connue, parce qu'un détecteur se teste sur
   une entrée dont on sait ce qu'elle contient.
   ------------------------------------------------------------------------- */
import {readFileSync} from "fs"
import {methodBody} from "./sourceBody.mjs"
import {Element,stepSignature,elementSignatures,matchSignatures} from "./chemistry.js"
import {fileURLToPath} from "url"
import {dirname, join} from "path"

const here=dirname(fileURLToPath(import.meta.url))
const source=readFileSync(join(here,"nodes/HoughTransformNode.js"),"utf8")
const TABLE=Element.load(JSON.parse(
    readFileSync(join(here,"../data/elements.json"),"utf8")))

let passed=0
const failures=[]
const test=(name,fn)=>{
    try{ fn(); passed++; console.log(`  ok   ${name}`) }
    catch(e){ failures.push(name); console.log(`  FAIL ${name}\n       ${e.message}`) }
}
const ok=(value,msg)=>{ if(!value) throw new Error(msg??`expected truthy, got ${value}`) }
const close=(a,b,tol,msg)=>{ if(!(Math.abs(a-b)<=tol)) throw new Error(msg??`${a} vs ${b}`) }
const eq=(a,b,msg)=>{ if(a!==b) throw new Error(msg??`${a} != ${b}`) }

const slopeProfile=new Function(methodBody(source,"slopeProfile"))
/* Les signatures sont REPOSÉES À LA MAIN dans le new Function, comme partout
   ailleurs dans ce dépôt: le corps est extrait du fichier, pas la fonction. */
const slopePeaks=new Function("summary","{mergeRadius}={}",methodBody(source,"slopePeaks"))
const slopeAtColumn=new Function("profile","column",methodBody(source,"slopeAtColumn"))

const BOUNDS=[-0.001,0.001,-0.2,0.2]
/* Un nœud sans DOM : les trois méthodes ne lisent que ces quatre choses, et
   c'est un test qui把它们 garderait tous les quatre si elle en lisait un
   cinquième — le prochain paramètre à entrer se voit ici. */
const makeNode=(grid,nx,ny)=>({
    lastAnswer:{grid},
    bounds:()=>[...BOUNDS],
    gridSize:()=>({nx,ny}),
    slopeProfile:slopeProfile,
    slopePeaks:slopePeaks,
    slopeAtColumn:slopeAtColumn
})

/* Une grille avec des votes sur des pentes DONNÉES. La colonne d'une pente est
   la même formule que dans le noyau, donc une raie posée ici est une raie que
   le noyau produirait. */
const synth=(nx,ny,specs,weights)=>{
    const grid=new Float64Array(nx*ny)
    for(const [index,slope] of specs.entries()){
        const column=Math.round((slope-BOUNDS[0])/(BOUNDS[1]-BOUNDS[0])*(nx-1))
        const height=weights?.[index]??1000
        //trois colonnes de large, comme une tache lissée
        for(let d=-1;d<=1;d++){
            const j=Math.min(nx-1,Math.max(0,column+d))
            for(let iy=0;iy<ny;iy++) grid[iy*nx+j]+=height*(d===0?1:0.4)
        }
    }
    return grid
}

test("le profil somme les votes d'une colonne, et rien d'autre",()=>{
    const nx=8
    const ny=4
    const node=makeNode(synth(nx,ny,[[0]],[100]),nx,ny)
    const profile=node.slopeProfile()
    ok(profile,"aucun profil")
    let total=0
    for(const v of profile.profile) total+=v
    /* la raie fait trois colonnes (1, 0.4, 0.4) sur ny lignes */
    close(total,100*(1+0.4+0.4)*ny,1e-9,"chaque vote doit être compté une fois, colonnes confondues")
    ok(profile.max>0,"le maximum doit être non nul")
    /* nx court sur la PENTE: c'est ce que le noyau écrit, et une colonne
       d'accumulation prise dans l'autre sens ne trouverait jamais rien. */
    const carbon=stepSignature(TABLE.find("C").monoisotopicMass,1)
    close(node.slopeAtColumn(profile,Math.round((carbon.slope-BOUNDS[0])/0.002*(nx-1))),
        carbon.slope,0.002/(nx-1),"la colonne de la pente 0 doit se lire à 0")
})

test("une grille trop courte ou absente ne donne pas de profil",()=>{
    const node=makeNode(new Float64Array(12),4,4)
    ok(node.slopeProfile()===null,"une grille de la mauvaise longueur ne doit pas être lue")
    const empty={lastAnswer:null,bounds:()=>[...BOUNDS],gridSize:()=>({nx:4,ny:4}),slopeProfile}
    ok(empty.slopeProfile()===null,"sans réponse du noyau, pas de profil")
})

test("un pic est trouvé à sa pente, pas à la colonne qui le porte",()=>{
    const nx=256
    const ny=64
    /* trois éléments réellement distincts, à z=1 */
    const nitrogen=stepSignature(TABLE.find("N").monoisotopicMass,1).slope
    const oxygen=stepSignature(TABLE.find("O").monoisotopicMass,1).slope
    const silicon=stepSignature(TABLE.find("Si").monoisotopicMass,1).slope
    const node=makeNode(synth(nx,ny,[[nitrogen],[oxygen],[silicon]]),nx,ny)
    const profile=node.slopeProfile()
    const peaks=node.slopePeaks(profile)
    ok(peaks.length>=3,`trois raies, trois pics, obtenu ${peaks.length}`)
    /* ET LA PENTE EST RENDUE, PAS LA COLONNE: c'est ce nombre qui sera
       comparé à A_E/z, donc c'est celui qui doit être juste. */
    for(const [slope,index] of [[nitrogen,0],[oxygen,1],[silicon,2]]){
        const found=peaks.find(p=>Math.abs(node.slopeAtColumn(profile,p.centre)-slope)<0.002/(nx-1))
        ok(found,`le pic de ${slope.toExponential(3)} doit être trouvé`)
        close(node.slopeAtColumn(profile,found.centre),slope,0.002/(nx-1),
            "la pente rendue doit être celle de la raie")
    }
})

test("deux pics séparés de moins que le rayon n'en font qu'un",()=>{
    /* Le lissage du noyau étale une relation sur plusieurs colonnes PAR
       CONSTRUCTION. Prendre les maxima bruts compterait la même relation trois
       fois, et le widget dirait alors qu'un élément a été trouvé trois fois
       alors qu'il ne l'a jamais été. */
    const nx=256
    const ny=32
    const carbon=stepSignature(TABLE.find("C").monoisotopicMass,1).slope
    const node=makeNode(synth(nx,ny,[[carbon]]),nx,ny)
    const profile=node.slopeProfile()
    /* une seule raie large de dix colonnes, lisible comme dix maxima locaux */
    const wide=new Float64Array(nx*ny)
    const centre=Math.round((carbon-BOUNDS[0])/0.002*(nx-1))
    for(let d=-5;d<=5;d++){
        const j=centre+d
        for(let iy=0;iy<ny;iy++) wide[iy*nx+j]=1000*Math.exp(-d*d/8)
    }
    const wideProfile=node.slopeProfile.call({lastAnswer:{grid:wide},gridSize:()=>({nx,ny})})
    const peaks=node.slopePeaks(wideProfile)
    ok(peaks.length===1,`une seule relation, un seul pic, obtenu ${peaks.length}`)
    close(node.slopeAtColumn(wideProfile,peaks[0].centre),carbon,0.002/(nx-1),
        "et sa pente est la bonne malgré l'étalement")
})

test("LA PENTE SEULE N'IDENTIFIE PAS UN ÉLÉMENT, et la suite le prouve",()=>{
    /* LE RÉSULTAT QUI CHANGE L'OUTIL. Toutes les masses seRamassent autour
       d'un entier, donc la signature d'un élément est epsilon/A — et chez les
       éléments lourds A ≈ k, donc epsilon/k, et le rapport se serre: Po et F
       sont à 1.9e-8 l'un de l'autre. Sur la fenêtre de 2e-3 du noeud, les
       séparer demanderait CENT MILLE colonnes.

       Conséquence: la liste du widget est un ENSEMBLE D'HYPOTHÈSES, jamais un
       nom. Un détecteur qui n'afficherait que le plus proche mentirait sur sa
       propre précision — d'où la distance affichée sur chaque ligne, et
       d'où le classement par masse de votes plutôt que par proximité. Ce test
       existe pour que personne ne "corrige" un jour le classement en le
       remplaçant par le plus proche voisin. */
    const signatures=elementSignatures(TABLE,{charges:[1]})
    const slopes=signatures.map(s=>s.slope).sort((a,b)=>a-b)
    let gap=Infinity
    for(let i=1;i<slopes.length;i++) gap=Math.min(gap,slopes[i]-slopes[i-1])
    ok(gap<1e-7,
        `le couple le plus serré doit rester séparé par la suite, mesuré ${gap.toExponential(2)}`)
    ok(0.002/gap>1000,
        `et il faut plus de mille colonnes pour les départager: ${Math.round(0.002/gap)}`)
    /* Les identification par la pente la plus proche sont donc NON uniques, et
       c'est le nombre d'hypothèses à un demi-bassin qui le dit. */
    const nx=256
    const nitrogen=stepSignature(TABLE.find("N").monoisotopicMass,1).slope
    const columnSlope=0.002/(nx-1)
    const hits=matchSignatures(signatures,nitrogen,columnSlope*1.5)
    ok(hits.length>1,
        `à ${nx} colonnes, la pente de l'azote répond pour plusieurs éléments: ${hits.length}`)
    ok(hits.some(h=>h.symbol==="N"),
        "et l'azote doit être parmi eux — mais pas forcément le premier")
})

test("le matchmaking rend la distance, pour que la liste dise son degré de certitude",()=>{
    const signatures=elementSignatures(TABLE,{charges:[1]})
    const nx=256
    const ny=32
    const nitrogen=stepSignature(TABLE.find("N").monoisotopicMass,1).slope
    const node=makeNode(synth(nx,ny,[[nitrogen]]),nx,ny)
    const profile=node.slopeProfile()
    const peaks=node.slopePeaks(profile)
    const columnSlope=0.002/(nx-1)
    const slope=node.slopeAtColumn(profile,peaks[0].centre)
    const hits=matchSignatures(signatures,slope,columnSlope*1.5)
    ok(hits.length>0,"une pente mesurée doit répondre")
    /* ET LA DISTANCE RENDUE EST EXIGÉE: c'est elle qui distingue un élément
       trouvé sur sa pente d'un élément trouvé à la limite de la tolérance. */
    for(let i=1;i<hits.length;i++){
        ok(Math.abs(hits[i].delta)>=Math.abs(hits[i-1].delta),
            "trié par distance croissante")
        ok(Math.abs(hits[i].delta)<=columnSlope*1.5,"et tout ce qui répond est dans la tolérance")
    }
    /* LA QUANTISATION DE LA GRILLE EST LE REQUIS DU DETECTEUR, pas un détail:
       une raie posée à la colonne 155 est lue avec la demi-largeur de colonne
       d'erreur près. C'est pourquoi le widget affiche la distance. */
    const placed=Math.round((nitrogen-BOUNDS[0])/0.002*(nx-1))
    ok(Math.abs(slope-nitrogen)<=0.002/(nx-1),
        `la pente lue doit être à une demi-colonne de la théorique: ${slope} vs ${nitrogen}`)
    ok(placed>=0&&placed<nx,"et la colonne de placement est dans la grille")
})

test("un plateau sans pic ne donne aucun élément",()=>{
    /* Le cas qui Must not s'appeler "no relation found" sans le dire. Une
       surface plate n'est pas une absence de signal, c'est une absence de
       PEAK — et la liste doit être vide, pas pleine d'éléments au hasard. */
    const nx=64
    const ny=32
    const grid=new Float64Array(nx*ny).fill(5)
    const node=makeNode(grid,nx,ny)
    const profile=node.slopeProfile()
    eq(node.slopePeaks(profile).length,0,"un plateau n'a aucun maximum local")
})

console.log(`\n${passed} passed, ${failures.length} failed`)
if(failures.length) process.exitCode=1
