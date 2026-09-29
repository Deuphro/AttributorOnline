import {App} from "./interface.js"
import * as d3 from "https://cdn.jsdelivr.net/npm/d3@7/+esm"
import * as util from "./util.js"
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
   starts things, it does not know what a session is made of. */
globalThis.Attributor=new App();
globalThis.d3=d3
globalThis.util=util