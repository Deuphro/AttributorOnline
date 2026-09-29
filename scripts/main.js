import {App,restoreSession} from "./interface.js"
import * as d3 from "https://cdn.jsdelivr.net/npm/d3@7/+esm"
import * as util from "./util.js"
import {clearSession,readSession} from "./sessionStore.js"
import init,* as rust from '../XOP/rust-extension/pkg/attribrustor.js'
async function run(){
    await init();
    globalThis.rust=rust
    const resultAdd = rust.add(5, 3);
    console.log("Result Add:", resultAdd);

    const resultCompute = rust.compute(10, 5);
    console.log("Result Compute:", resultCompute);
}
run()

/* The App loads what it needs, including the periodic table: main.js only
   starts things, it does not know what a session is made of.

   The skeleton is read BEFORE any App exists, because a restored session brings
   its own App - the one created here would only be built to be thrown away.
   A first visit, a cleared store and an unreadable entry all land on the same
   empty app: a failed save must never be the reason the app does not open. */
function startApp(){
    const saved=readSession()
    if(!saved){
        return new App()
    }
    try{
        const restored=restoreSession(saved)
        if(restored){
            return restored
        }
    }catch(error){
        console.error("[boot] the saved session could not be restored:",error)
        //dropped rather than kept: a skeleton this build cannot read would be
        //re-read on every reload, and the user would meet the same failure every
        //time with no way out of it
        clearSession()
    }
    return new App()
}

const app=startApp()
globalThis.Attributor=app
/* The skeleton carries no data, so the graph comes back painted and empty and
   the resolve runs behind it. This is what makes F5 mean "the same pipeline, the
   values back" instead of "the same pipeline, everything floating". */
app.resolveAfterRestore?.()
globalThis.d3=d3
globalThis.util=util