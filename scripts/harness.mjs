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
import {readFile} from "fs/promises"
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