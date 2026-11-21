import {computePool} from "./workerPool.js"

const PARAMETER_NAMES={
    wesslau:["amplitude","alpha","mu"],
    flory_schulz:["amplitude","a"],
    schulz_zimm:["amplitude","z","Mn"]
}

const asFloat64=(values,name)=>{
    if(!(values instanceof Float64Array)&&!Array.isArray(values)){
        throw new TypeError(`${name} must be a Float64Array or number array`)
    }
    return Float64Array.from(values,value=>Number(value))
}

function fitSettings(model,x,y,options){
    const positiveX=x.filter(value=>value>0)
    const inferredM0=positiveX.length?positiveX.reduce((minimum,value)=>Math.min(minimum,value),Infinity)*0.9:1
    const m0=Number(options.m0??options.M0??(model==="wesslau"?inferredM0:1))
    const massUnit=Number(options.massUnit??1)
    const trials=Number(options.N??options.trials??1e9)
    if(!Number.isFinite(m0)||m0<=0||!Number.isFinite(massUnit)||massUnit<=0||!Number.isFinite(trials)||trials<=0){
        throw new RangeError("m0, massUnit and N must be positive finite values")
    }
    // Rank-one series use k as X; the continuous models evaluate at m=M0+k*M_unit.
    // Rank-one series use k as X; the continuous models evaluate at m=M0+k*M_unit.
    const xIsIndex=options.xIsIndex===true
    const physicalMass=x.map(value=>xIsIndex?m0+value*massUnit:value)
    const meanX=x.reduce((sum,value)=>sum+value,0)/x.length
    const massMean=physicalMass.reduce((sum,value,index)=>sum+y[index]*value,0)/
        Math.max(Number.MIN_VALUE,y.reduce((sum,value)=>sum+value,0))
    const parameterNames=PARAMETER_NAMES[model]
    const defaults=model==="wesslau"
        ?{initial:[1,1.08,Math.max(0.1,meanX)],lower:[0,1.000001,1e-6],upper:[1e6,20,Math.max(meanX*20,100)]}
        :model==="flory_schulz"
            ?{initial:[1,Math.max(0.01,Math.min(0.98,1-1/(meanX+1)))],lower:[0,1e-8],upper:[1e6,1-1e-8]}
            :{initial:[1,2,Math.max(physicalMass.reduce((sum,value)=>sum+value,0)/x.length,1)],
                lower:[0,1e-4,Math.max(Number.MIN_VALUE,physicalMass.reduce((minimum,value)=>Math.min(minimum,value),Infinity)*0.1)],
                upper:[1e6,1e4,physicalMass.reduce((maximum,value)=>Math.max(maximum,value),0)*100]}
    if(model==="wesslau"){
        const latent=physicalMass.map(mass=>Math.log(mass/m0)/Math.log(defaults.initial[1]))
            .filter(value=>Number.isFinite(value)&&value>0)
        if(latent.length) defaults.initial[2]=latent.reduce((sum,value)=>sum+value,0)/latent.length
        defaults.upper[2]=Math.min(trials*(1-1e-9),Math.max(defaults.initial[2]*20,100))
    }
    if(model==="schulz_zimm") defaults.initial[2]=Number.isFinite(massMean)&&massMean>0?massMean:defaults.initial[2]
    const initial=options.p0??options.initial??defaults.initial
    const lower=parameterNames.map((name,index)=>Number(options.bounds?.[name]?.[0]??options.lowerBounds?.[index]??defaults.lower[index]))
    const upper=parameterNames.map((name,index)=>Number(options.bounds?.[name]?.[1]??options.upperBounds?.[index]??defaults.upper[index]))
    if(initial.length!==parameterNames.length||lower.length!==parameterNames.length||upper.length!==parameterNames.length){
        throw new RangeError(`${model} expects ${parameterNames.length} parameters`)
    }
    if(lower[0]<0){
        throw new RangeError("amplitude must be bounded at or above zero")
    }
    const poissonLimit=options.poisson_limit??options.poissonLimit??true
    if(model==="wesslau"&&(lower[1]<=1||lower[2]<=0||
       poissonLimit===false&&upper[2]>=trials)){
        throw new RangeError("Weßlau bounds require alpha > 1, mu > 0 and, for finite N, mu < N")
    }
    if(model==="flory_schulz"&&(lower[1]<=0||upper[1]>=1)){
        throw new RangeError("Flory-Schulz bounds require 0 < a < 1")
    }
    if(model==="schulz_zimm"&&(lower[1]<=0||lower[2]<=0)){
        throw new RangeError("Schulz-Zimm bounds require z > 0 and Mn > 0")
    }
    return {m0,massUnit,trials,parameterNames,initial:Array.from(initial,Number),lower,upper}
}

export async function fitDistribution(xValues,yValues,{model,...options}={}){
    if(!Object.hasOwn(PARAMETER_NAMES,model)) throw new TypeError(`Unknown model "${model}"`)
    const xInput=asFloat64(xValues,"x")
    const yInput=asFloat64(yValues,"y")
    if(xInput.length!==yInput.length) throw new RangeError("x and y must have equal lengths")
    const valid=[]
    const positiveX=Array.from(xInput).filter(value=>Number.isFinite(value)&&value>0)
    const defaultM0=positiveX.length?positiveX.reduce((minimum,value)=>Math.min(minimum,value),Infinity)*0.9:1
    const m0=Number(options.m0??options.M0??(model==="wesslau"?defaultM0:1))
    for(let index=0;index<xInput.length;index++){
        const x=xInput[index]
        const y=yInput[index]
        const mass=options.xIsIndex===true?m0+x*(options.massUnit??1):x
        const validX=model==="flory_schulz"?x>=1:model==="wesslau"?mass>m0:mass>0
        if(Number.isFinite(x)&&Number.isFinite(y)&&y>=0&&validX){
            valid.push({x,y})
        }
    }
    const parameterCount=PARAMETER_NAMES[model].length
    if(valid.length<parameterCount) throw new RangeError(`${model} needs at least ${parameterCount} valid points`)
    const x=Float64Array.from(valid,point=>point.x)
    const yOriginal=Float64Array.from(valid,point=>point.y)
    const yScale=options.normalizeY===false?1:yOriginal.reduce((maximum,value)=>Math.max(maximum,value),0)||1
    const y=Float64Array.from(yOriginal,value=>value/yScale)
    const settings=fitSettings(model,Array.from(x),Array.from(y),options)
    if(settings.lower.some((value,index)=>!Number.isFinite(value)||value>=settings.upper[index])||
       settings.upper.some(value=>!Number.isFinite(value))||settings.initial.some((value,index)=>!Number.isFinite(value)||value<settings.lower[index]||value>settings.upper[index])){
        throw new RangeError("initial parameters and finite bounds must be ordered and compatible")
    }
    const kernelOptions={
        m0:settings.m0,massUnit:settings.massUnit,xIsIndex:options.xIsIndex===true,
        poissonLimit:options.poisson_limit??options.poissonLimit??true,
        trials:settings.trials,massWeighted:options.distribution==="mass"||options.massWeighted===true
    }
    const raw=await computePool.run("distributionFit",{
        x,y,model,initial:settings.initial,lower:settings.lower,upper:settings.upper,
        options:kernelOptions,maxIterations:options.maxIterations??300
    })
    const predictions=Float64Array.from(raw.yPred,value=>value*yScale)
    const parameters=Array.from(raw.parameters,(value,index)=>index===0?value*yScale:value)
    let sse=0
    const mean=yOriginal.reduce((sum,value)=>sum+value,0)/yOriginal.length
    let totalVariance=0
    for(let index=0;index<yOriginal.length;index++){
        const residual=predictions[index]-yOriginal[index]
        sse+=residual*residual
        totalVariance+=(yOriginal[index]-mean)**2
    }
    const dof=yOriginal.length-parameterCount
    const likelihoodSse=Math.max(sse/yOriginal.length,Number.MIN_VALUE)
    const aic=yOriginal.length*Math.log(likelihoodSse)+2*parameterCount
    const aicc=dof>1?aic+(2*parameterCount*(parameterCount+1))/(dof-1):Infinity
    const bic=yOriginal.length*Math.log(likelihoodSse)+parameterCount*Math.log(yOriginal.length)
    const parameterObject=Object.fromEntries(settings.parameterNames.map((name,index)=>[name,parameters[index]]))
    return {
        model,parameters:parameterObject,parameterVector:Float64Array.from(parameters),
        x,y:yOriginal,yPred:predictions,sse,rmse:Math.sqrt(sse/yOriginal.length),
        chi2Red:dof>0?sse/dof:null,
        r2:totalVariance>0?1-sse/totalVariance:null,
        aic,aicc,bic,
        converged:raw.converged,iterations:raw.iterations,dropped:xInput.length-valid.length,
        options:{...kernelOptions,normalizedY:yScale!==1}
    }
}

export async function compareModels(x,y,models,options={}){
    if(!Array.isArray(models)||!models.length) throw new TypeError("models must be a non-empty array")
    const fits=await Promise.all(models.map(model=>fitDistribution(x,y,{...options,model})))
    fits.sort((left,right)=>left.aicc-right.aicc)
    return {best:fits[0],fits}
}