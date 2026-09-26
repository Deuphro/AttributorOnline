//Executes the REAL kernelWorker.js and drives the two new kernels. The wasm
//path cannot load in node (fetch on file://), so the JS fallbacks answer -
//which is exactly the degradation we want to prove works.
import {readFileSync} from "node:fs"
import {pathToFileURL} from "node:url"

const root = "c:/Users/orthousf/Nextcloud/IPAG/Attributor/Webttributor/AttributorOnline"
const src = readFileSync(`${root}/scripts/kernelWorker.js`, "utf8")

const listeners = []
const pending = new Map()
let nextId = 1
globalThis.self = {
    addEventListener(type, fn) {
        if (type === "message") listeners.push(fn)
    },
    postMessage(msg) {
        const entry = pending.get(msg.id)
        if (!entry) return
        pending.delete(msg.id)
        msg.error ? entry.reject(new Error(msg.error)) : entry.resolve(msg.result)
    },
    location: {href: `${root}/scripts/kernelWorker.js`},
}

// kernelWorker.js is COPIED into scripts/ as kw_check.mjs so it loads as a REAL
// module: new Function() would choke on its top-level import. It has to sit in
// scripts/ because its own import of the wasm package is relative to it.
await import(`${pathToFileURL(`${root}/scripts/kw_check.mjs`).href}`)
if (listeners.length !== 1) throw new Error(`expected 1 listener, got ${listeners.length}`)

const call = (kernel, payload) => new Promise((resolve, reject) => {
    const id = nextId++
    pending.set(id, {resolve, reject})
    listeners[0]({data: {id, kernel, payload}})
})

let failures = 0
const check = (label, actual, expected) => {
    // Object.is, not ===: -Infinity === -Infinity is true, but the tolerance
    // arithmetic below would be NaN - which is how the two passthrough checks
    // first reported a failure on a perfectly correct answer
    const ok = typeof expected === "number" && typeof actual === "number" && Number.isFinite(expected)
        ? Math.abs(actual - expected) < 1e-9
        : Object.is(actual, expected)
    if (!ok) failures++
    console.log(`${ok ? "ok  " : "FAIL"} ${label}: ${actual}${ok ? "" : ` (expected ${expected})`}`)
}

// a noisy floor around 100 with a few peaks, as a real spectrum
const n = 2000
const y = new Float64Array(n)
for (let i = 0; i < n; i++) y[i] = 100 + 8 * Math.sin(i * 0.7) + (i % 11) * 0.3
y[300] = 1200
y[900] = 5000
y[1500] = 9000
const core = y

console.log("--- trimGuess ---")
const t = await call("trimGuess", {core, params: {method: "intensityThreshold", threshold: 250}})
check("intensityThreshold returns the threshold", t, 250)

const mad = await call("trimGuess", {core, params: {method: "madResidual", k: 5, window: 9}})
check("madResidual sits above the baseline", mad > 100 ? 1 : 0, 1)
const mad1 = await call("trimGuess", {core, params: {method: "madResidual", k: 1, window: 9}})
const mad10 = await call("trimGuess", {core, params: {method: "madResidual", k: 10, window: 9}})
check("a larger k gives a larger threshold", mad10 > mad1 ? 1 : 0, 1)
const win3 = await call("trimGuess", {core, params: {method: "madResidual", k: 5, window: 3}})
const win25 = await call("trimGuess", {core, params: {method: "madResidual", k: 5, window: 25}})
check("a wider window changes the estimate", win3 !== win25 ? 1 : 0, 1)
check("passthrough is -Infinity",
    await call("trimGuess", {core, params: {method: "passthrough"}}), -Infinity)
check("an unknown method falls back to passthrough",
    await call("trimGuess", {core, params: {method: "nope"}}), -Infinity)

console.log("--- trimApply ---")
// 2000..6000 keeps only the 5000 peak: the 1200 one is below, the 9000 above
const cut = await call("trimApply", {core, params: {lowBound: 2000, highBound: 6000}})
check("total is the whole wave", cut.totalCount, n)
check("the low peak is gone", cut.pointsY.includes(1200) ? 0 : 1, 1)
check("the high peak is gone", cut.pointsY.includes(9000) ? 0 : 1, 1)
check("the mid peak survives", cut.pointsY.includes(5000) ? 1 : 0, 1)
check("kept is below the total", cut.keptCount < n ? 1 : 0, 1)

const all = await call("trimApply", {core, params: {}})
check("no bounds at all keeps everything", all.keptCount, n)
const none = await call("trimApply", {core, params: {lowBound: -Infinity, highBound: Infinity}})
check("infinite bounds keep everything", none.keptCount, n)

// the regression the split exists for: a cursor BELOW the guessed threshold
const guessOnly = await call("trimApply", {core, params: {lowBound: mad, highBound: Infinity}})
const dragged = await call("trimApply", {core, params: {lowBound: 0, highBound: Infinity}})
check("a cursor below the guess cuts less", dragged.keptCount > guessOnly.keptCount ? 1 : 0, 1)

console.log("--- neighbours still work ---")
const hist = await call("trimHistogram", {core, params: {bins: 60, scale: "log"}})
check("histogram bars", hist.centres.length > 0 ? 1 : 0, 1)
const ph = await call("persistentHomology0D", {core, params: {}})
check("persistentHomology0D answers", ph !== undefined ? 1 : 0, 1)

console.log(failures === 0 ? "\nALL OK" : `\n${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
