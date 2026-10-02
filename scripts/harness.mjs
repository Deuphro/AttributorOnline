/* -------------------------------------------------------------------------
   harnais.mjs — LA PAGE, RENDUE.

   Pourquoi ce fichier existe: tout le travail précédent sur le nœud
   d'attribution a été du code DOM ÉCRIT, puis `node --check`, puis testé par
   extraction de texte. Aucun de ces gestes ne dit ce que l'utilisateur voit.
   Ici la page est chargée dans un vrai Chromium, et on agit sur le DOM comme
   un utilisateur: on tape dans une case, on clique sur Resolve, et on LIT le
   texte affiché.

       node scripts/harness.mjs [--keep] [--shots]

   Le serveur statique est écrit ici plutôt que dans index.js parce qu'il doit
   servir TOUT (scripts/attribution.js, data/elements.json...), alors que le
   serveur de production sert une liste blanche.
   ------------------------------------------------------------------------- */
import {createServer} from "http"
import {readFile,writeFile} from "fs/promises"
import {existsSync,mkdirSync} from "fs"
import path from "path"
import {fileURLToPath} from "url"
import puppeteer from "puppeteer"
import {PEAKS} from "./fixture.mjs"

const ROOT=path.resolve(path.dirname(fileURLToPath(import.meta.url)),"..")
const PORT=8099
const MIME={
    ".html":"text/html",".js":"text/javascript",".mjs":"text/javascript",
    ".css":"text/css",".json":"application/json",".wasm":"application/wasm",
    ".svg":"image/svg+xml",".png":"image/png",".txt":"text/plain"
}

function serve(root,port){
    const server=createServer(async(req,res)=>{
        const url=decodeURIComponent((req.url??"/").split("?")[0])
        const file=path.join(root,url==="/"?"index.html":url)
        if(!path.resolve(file).startsWith(path.resolve(root))){
            res.writeHead(403); res.end(); return
        }
        try{
            const data=await readFile(file)
            res.writeHead(200,{
                "Content-Type":MIME[path.extname(file).toLowerCase()]??"application/octet-stream",
                "Access-Control-Allow-Origin":"*"
            })
            res.end(data)
        }catch{
            res.writeHead(404,{"Content-Type":"text/plain"})
            res.end(`404 ${url}`)
        }
    })
    return new Promise(resolve=>server.listen(port,()=>resolve(server)))
}

const shots=process.argv.includes("--shots")?path.join(ROOT,"shots"):null
if(shots&&!existsSync(shots)) mkdirSync(shots)

export const log=(...parts)=>console.log(...parts)

/* Un diagnostic ponctuel, à lancer quand une slice semble cortailler. */
if(process.argv.includes("--slice")){
    const node=await readFile(path.join(ROOT,"scripts/interface.js"),"utf8")
    const start=node.indexOf("    commitNumber(name,raw,low,high){")
    const end=node.indexOf("    fieldFor(name){")
    const slice=node.slice(start,end)
    log(`start=${start} end=${end} length=${slice.length}`)
    log(`has bestMatches|ppm: ${/bestMatches|ppm/.test(slice)}`)
    log(`has startResolve   : ${slice.includes("startResolve")}`)
    log(`tail: ${JSON.stringify(slice.slice(-140))}`)
}

export async function open(){
    const server=await serve(ROOT,PORT)
    const browser=await puppeteer.launch({
        headless:true,
        args:["--no-sandbox","--disable-dev-shm-usage"]
    })
    const page=await browser.newPage()
    await page.setViewport({width:1600,height:1000})
    const seen=[]
    page.on("console",msg=>seen.push(`${msg.type()}: ${msg.text()}`))
    page.on("pageerror",err=>seen.push(`pageerror: ${err.message}`))
    await page.goto(`http://localhost:${PORT}/index.html`,{waitUntil:"networkidle2",timeout:60000})
    await page.waitForFunction("globalThis.Attributor!==undefined",{timeout:30000})
    await page.evaluate(()=>globalThis.Attributor.tableReady)
    return {browser,page,server,seen}
}

/* Le nœud, trouvé par sa classe — pas par un indice, pour que le harnais
   survive aunumbered change. */
export const FIND_NODE=`(()=>{
    const flow=globalThis.Attributor.channel.get("mainFlow")
    return [...flow.nodeSet].find(n=>n.constructor.name==="AttributionNode")??null
})()`

export async function readState(page){
    return page.evaluate(`(()=>{
        const node=${FIND_NODE}
        if(!node) return {error:"no AttributionNode in the flow"}
        return {
            readout:node.readout?.textContent??"(none)",
            charges:node.chargeLabel?.textContent??"(none)",
            button:node.resolveButton?.textContent??"(none)",
            disabled:node.resolveButton?.disabled,
            status:node.status,
            needsResolve:node.needsResolve,
            plan:node.plan?{
                combinables:node.plan.combinables.length,
                ionisers:node.plan.ionisers.length,
                chargeMin:node.plan.chargeMin,
                chargeMax:node.plan.chargeMax,
                chargeSet:node.plan.chargeSet
            }:null,
            attributions:node.attributions?.map(r=>({
                n:r.entries.length,candidates:r.candidates,
                notations:r.entries.slice(0,6).map(e=>e.notation)
            }))??null
        }
    })()`)
}

export async function dump(label,state){
    log(`\n=== ${label} ===`)
    log(`button      : "${state.button}" disabled=${state.disabled} needsResolve=${state.needsResolve}`)
    log(`charges     : ${state.charges}`)
    log(`status      : ${state.status}`)
    log(`plan        : ${JSON.stringify(state.plan)}`)
    log(`readout     :\n${state.readout}`)
    log(`attributions: ${JSON.stringify(state.attributions)}`)
    return state
}

export async function shutdown({browser,server}){
    await browser.close()
    server.close()
}

/* Réintroduire une faute, vérifier qu'un test la voit, puis restaurer.

   C'est le seul moyen honnête de dire qu'un test protège quelque chose: sans
   ça, « 64 passed » ne prouve que que le test passe sur le code qu'il décrit.
   Le motif est celui de collectionReader.test.mjs — lire, découper, évaluer —
   et ici il s'agit de remettre une ligne en place puis de la retirer. */
/* Les fins de ligne du fichier, lues et non supposées. Windows les écrit en
   CRLF, donc chercher `\n` seul dans un motif multiligne ne trouve rien — et
   un motif introuvable doit être une ERREUR, jamais un test qui passe. */
export async function reintroduce(file,from,to){
    /* `target`, et non `path`: le nom du module `path` est déjà pris dans cette
       portée, et le déclarer ici en `const path` le rendrait inaccessible —
       exactement le genre de faute que cette fonction sert à attraper. */
    const target=path.join(ROOT,file)
    const original=await readFile(target,"utf8")
    /* On tente le motif tel quel, puis avec les fins de ligne du fichier. Un
       seul des deux doit exister; sinon le test vérifierait du vide. */
    const crlf=original.includes("\r\n")
    const pattern=crlf?from.replace(/\n/g,"\r\n"):from
    if(!original.includes(pattern)){
        throw new Error(`cannot reintroduce: the pattern is not in ${file}`+
            `${crlf?" (CRLF)":""}:\n${from}`)
    }
    await writeFile(target,original.replace(pattern,
        crlf?to.replace(/\n/g,"\r\n"):to))
    return async ()=>{ await writeFile(target,original) }
}