import {Formula} from "../chemistry.js"
import {computePool} from "../workerPool.js"
import {Wave} from "../formats.js"
import {NodeWithAccordion} from "../core/index.js"
import {CE,stylize} from "../util.js"
import {wavesFromInput} from "../utils/index.js"

/* ----------------------------------------------------------------
   FKMDNode — one input anchor, one output anchor.

   Every XY wave linked to the input is transformed independently, producing
   one F-KMD product wave per input. The kernel is named "fkmd" already, and
   today it only copies the input XY through (see kernelWorker.js).
   ---------------------------------------------------------------- */
export class FKMDNode extends NodeWithAccordion{
    constructor(title,origin,destinationFlow,position={x:180,y:10}){
        //one input (XY wave: X=mass, Y=intensity), one output
        super(title,[[]],[[]],origin,destinationFlow,position)
        this.status="floating"
        //the notation, exactly as typed. The grammar is chemistry.js's
        //("C6H12O6 [H+]"). The notation is parsed as soon as it is TYPED
        //(live feedback), but the m/z it yields only reaches the kernel when
        //the user commits with ENTER.
        this.parameters.notation="C"
        //the formula READ, or null. The output is a list of F-KMD product
        //waves, one per input wave.
        this.formula=null
        this.parseError=null
        this.resolveRun=0
        this.kernelRun=0
        this.inputWaves=[]
        const inputAnchors=this.DOMelt.querySelectorAll('.input.anchor')
        if(inputAnchors[0]) inputAnchors[0].innerHTML='<title>Input: one or more XY waves (X=mass, Y=intensity)</title>'
        const outputAnchors=this.DOMelt.querySelectorAll('.output.anchor')
        if(outputAnchors[0]) outputAnchors[0].innerHTML='<title>Output: one F-KMD product wave per input wave</title>'
    }
    registered(e){
        if(e.detail.msg.caster!==this||this.accordion){
            return
        }
        super.registered(e)
        this.setupFormulaUI()
        //read the default notation, but do NOT run the kernel: the node has no
        //input yet, and a resolve that finds no wave would only publish an
        //empty output. The formula is shown; the products come on the first
        //commit, once something is linked.
        this.readFormula()
    }
    setupFormulaUI(){
        if(!this.accordion) return
        const content=this.accordion.DOMelt.content
        content.replaceChildren()
        this.accordion.setSizingMode("content")
        stylize(content,{
            display:"grid",
            "grid-template-columns":"minmax(0, 1fr)",
            padding:"4px",
            gap:"4px"
        })
        this.notationInput=CE("input",{
            type:"text",
            value:this.parameters.notation,
            spellcheck:false,
            title:"Chemical formula, composition then ionisation between brackets"
        },[])
        stylize(this.notationInput,{
            width:"100%",
            boxSizing:"border-box",
            fontFamily:"inherit",
            fontSize:"0.9em",
            padding:"4px 6px",
            borderRadius:"4px"
        })
        this.notationInput.addEventListener("keydown",(e)=>{
            if(e.key==="Enter"){
                e.preventDefault()
                this.startResolve().then(()=>this.resolveChildren())
            }
        })
        this.notationInput.addEventListener("input",()=>{
            this.parameters.notation=this.notationInput.value
            this.readFormula()
        })
        content.append(this.notationInput)
        this.readout=CE("div",{
            style:{
                fontSize:"0.85em",
                opacity:"0.85",
                padding:"2px 4px",
                whiteSpace:"pre-wrap"
            }
        },[])
        content.append(this.readout)
        this.renderReadout()
    }
    async table(){
        if(this.origin.table) return this.origin.table
        await this.origin.tableReady
        return this.origin.table??null
    }
    async startResolve(){
        await this.readFormula()
        await this.applyKernel()
    }
    async readFormula(){
        const run=++this.resolveRun
        const notation=this.parameters.notation
        const table=await this.table()
        if(run!==this.resolveRun) return null
        if(!table||!notation.trim()){
            this.formula=null
            this.parseError=null
            this.setStatus("floating")
            this.renderReadout()
            return null
        }
        try{
            this.formula=Formula.parse(notation,table)
            this.parseError=null
            this.setStatus("floating")
        }catch(err){
            this.formula=null
            this.parseError=err.message
            this.setStatus("error")
        }
        this.renderReadout()
        return this.formula
    }
    formulaMz(){
        return this.formula?this.formula.mz:null
    }
    renderReadout(){
        if(!this.readout) return
        if(this.parseError){
            this.readout.textContent=this.parseError
            return
        }
        if(!this.formula){
            this.readout.textContent=this.origin.tableError
                ?`table pÃ©riodique indisponible: ${this.origin.tableError}`
                :""
            return
        }
        const f=this.formula
        const lines=[
            Formula.compositionToString(f.composition,f.rule),
            `charge ${f.charge>0?"+":""}${f.charge}`,
            `m/z ${f.mz.toFixed(6)}`
        ]
        if(this.skippedInputs){
            lines.push(`${this.skippedInputs} entrÃ©e(s) ignorÃ©e(s): pas une wave XY`)
        }
        for(const err of this.kernelErrors??[]){
            lines.push(`kernel: ${err}`)
        }
        this.readout.textContent=lines.join("\n")
    }
    collectInputWaves(){
        const {waves,skipped}=wavesFromInput(this.inputs[0])
        const accepted=[]
        let refused=0
        for(const wave of waves){
            if(wave.degree===2&&wave.dims[1]===2){
                accepted.push(wave)
            }else{
                refused++
            }
        }
        return {waves:accepted,skipped:skipped+refused}
    }
    async applyKernel(){
        const mz=this.formulaMz()
        const {waves,skipped}=this.collectInputWaves()
        this.inputWaves=waves
        this.skippedInputs=skipped
        if(mz===null||!waves.length){
            this.outputs[0]=[]
            this.kernelErrors=[]
            this.setStatus(mz===null?(this.parseError?"error":"floating"):"floating")
            this.renderReadout()
            return
        }
        const run=++this.kernelRun
        const products=[]
        const errors=[]
        for(const wave of waves){
            try{
                const result=await computePool.run("fkmd",{
                    core:wave.core,
                    params:{mz}
                })
                if(run!==this.kernelRun) return
                const core=result?.core
                if(!(core instanceof Float64Array)||core.length%2){
                    errors.push(`the kernel returned ${core?.length??"nothing"}, not a flat XY`)
                    continue
                }
                if(core.length===0){
                    errors.push(`m/z ${mz} gives no scale: nothing to divide by`)
                    continue
                }
                const pointCount=core.length/2
                const x=core.subarray(0,pointCount)
                const y=core.subarray(pointCount)
                products.push(Wave.fromCoordinates(x,y,{
                    title:`${this.title} (F-KMD)`,
                    "f-kmd":true,
                    key:this.parameters.notation,
                    mz,
                    sourceWave:wave.metadata?.title??"unknown",
                    traceMode:"points"
                },["x","y"]))
            }catch(err){
                if(run!==this.kernelRun) return
                errors.push(err.message??String(err))
            }
        }
        if(run!==this.kernelRun) return
        this.kernelErrors=errors
        this.outputs[0]=products
        this.setStatus(errors.length&&!products.length?"error":"resolved")
        this.renderReadout()
    }
    setStatus(status){
        this.status=status
        dispatchEvent(this.events.broadcast.nodeStatusChanged.call(this,status))
    }
    serializeState(){
        return {
            notation:this.parameters.notation
        }
    }
    restoreState(state){
        if(typeof state?.notation==="string"){
            this.parameters.notation=state.notation
        }
        if(this.notationInput) this.notationInput.value=this.parameters.notation
        this.readFormula()
    }
}