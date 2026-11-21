const lnGamma=value=>{
    const coefficients=[
        676.5203681218851,-1259.1392167224028,771.3234287776531,
        -176.6150291621406,12.507343278686905,-0.13857109526572012,
        9.984369578019572e-6,1.5056327351493116e-7
    ]
    if(value<0.5){
        return Math.log(Math.PI)-Math.log(Math.sin(Math.PI*value))-lnGamma(1-value)
    }
    const shifted=value-1
    let sum=0.9999999999998099
    coefficients.forEach((coefficient,index)=>{sum+=coefficient/(shifted+index+1)})
    const t=shifted+7.5
    return 0.5*Math.log(2*Math.PI)+(shifted+0.5)*Math.log(t)-t+Math.log(sum)
}

export function evaluateDistribution(model,x,parameters,options={}){
    const [amplitude=0,shape=0,location=0]=parameters
    const m0=options.m0??1
    const massUnit=options.massUnit??1
    const massAt=value=>options.xIsIndex===true?m0+value*massUnit:value
    if(model==="wesslau"){
        const mass=massAt(x)
        if(!(mass>m0)||!(shape>1)||!(location>0)) return 0
        const logAlpha=Math.log(shape)
        const latent=Math.log(mass/m0)/logAlpha
        const trials=options.trials??1e9
        const variance=options.poissonLimit!==false?location:location*(1-location/trials)
        if(!(variance>0)) return 0
        return amplitude/(mass*logAlpha*Math.sqrt(2*Math.PI*variance))*
            Math.exp(-0.5*(latent-location)**2/variance)
    }
    if(model==="flory_schulz"){
        const k=x
        const a=shape
        if(k<1||!(a>0&&a<1)) return 0
        return options.massWeighted===true
            ?amplitude*k*(1-a)**2*a**(k-1)
            :amplitude*(1-a)*a**(k-1)
    }
    if(model==="schulz_zimm"){
        const mass=massAt(x)
        const z=shape
        const mean=location
        if(!(mass>0)||!(z>0)||!(mean>0)) return 0
        return amplitude*Math.exp(z*Math.log(z/mean)-lnGamma(z)+(z-1)*Math.log(mass)-z*mass/mean)
    }
    throw new TypeError(`Unknown distribution model: ${model}`)
}

const solveLinear=(matrix,rhs,size)=>{
    for(let pivot=0;pivot<size;pivot++){
        let best=pivot
        for(let row=pivot+1;row<size;row++){
            if(Math.abs(matrix[row*size+pivot])>Math.abs(matrix[best*size+pivot])) best=row
        }
        if(Math.abs(matrix[best*size+pivot])<1e-18) return false
        if(best!==pivot){
            for(let column=pivot;column<size;column++){
                [matrix[pivot*size+column],matrix[best*size+column]]=
                    [matrix[best*size+column],matrix[pivot*size+column]]
            }
            ;[rhs[pivot],rhs[best]]=[rhs[best],rhs[pivot]]
        }
        const diagonal=matrix[pivot*size+pivot]
        for(let column=pivot;column<size;column++) matrix[pivot*size+column]/=diagonal
        rhs[pivot]/=diagonal
        for(let row=0;row<size;row++){
            if(row===pivot) continue
            const factor=matrix[row*size+pivot]
            for(let column=pivot;column<size;column++) matrix[row*size+column]-=factor*matrix[pivot*size+column]
            rhs[row]-=factor*rhs[pivot]
        }
    }
    return true
}

export function fitDistributionKernelJS(payload){
    const {x,y,model,initial,lower,upper,options={}}=payload
    const count=initial.length
    const parameters=Array.from(initial,(value,index)=>Math.max(lower[index],Math.min(upper[index],value)))
    const trialParameters=Array.from(parameters)
    const predictions=new Float64Array(x.length)
    const trialPredictions=new Float64Array(x.length)
    const jacobian=new Float64Array(x.length*count)
    const normal=new Float64Array(count*count)
    const gradient=new Float64Array(count)
    const delta=new Float64Array(count)
    const evaluate=(value,params)=>evaluateDistribution(model,value,params,options)
    const sseFor=(params,output)=>{
        let total=0
        for(let index=0;index<x.length;index++){
            const prediction=evaluate(x[index],params)
            output[index]=prediction
            total+=(prediction-y[index])**2
        }
        return total
    }
    let sse=sseFor(parameters,predictions)
    let lambda=1e-3
    let converged=false
    let iterations=0
    for(let iteration=0;iteration<Math.max(1,Math.min(1000,payload.maxIterations??300));iteration++){
        iterations=iteration+1
        for(let parameter=0;parameter<count;parameter++){
            const step=Math.max(Math.abs(parameters[parameter])*1e-5,1e-7)
            trialParameters.splice(0,count,...parameters)
            trialParameters[parameter]=Math.min(parameters[parameter]+step,upper[parameter])
            if(trialParameters[parameter]===parameters[parameter]){
                trialParameters[parameter]=Math.max(parameters[parameter]-step,lower[parameter])
            }
            const actualStep=trialParameters[parameter]-parameters[parameter]
            if(actualStep===0) continue
            for(let index=0;index<x.length;index++){
                jacobian[index*count+parameter]=
                    (evaluate(x[index],trialParameters)-predictions[index])/actualStep
            }
        }
        normal.fill(0)
        gradient.fill(0)
        for(let index=0;index<x.length;index++){
            const residual=y[index]-predictions[index]
            for(let a=0;a<count;a++){
                const ja=jacobian[index*count+a]
                gradient[a]+=ja*residual
                for(let b=0;b<count;b++) normal[a*count+b]+=ja*jacobian[index*count+b]
            }
        }
        const gradientNorm=Math.max(...gradient.map(value=>Math.abs(value)))
        if(gradientNorm<1e-10){converged=true;break}
        for(let index=0;index<count;index++){
            normal[index*count+index]+=lambda*(Math.abs(normal[index*count+index])+1e-9)
            delta[index]=gradient[index]
        }
        if(!solveLinear(normal,delta,count)){
            lambda*=10
            if(lambda>1e15) break
            continue
        }
        for(let index=0;index<count;index++){
            trialParameters[index]=Math.max(lower[index],Math.min(upper[index],parameters[index]+delta[index]))
        }
        const trialSse=sseFor(trialParameters,trialPredictions)
        if(Number.isFinite(trialSse)&&trialSse<sse){
            const improvement=sse-trialSse
            parameters.splice(0,count,...trialParameters)
            predictions.set(trialPredictions)
            sse=trialSse
            lambda=Math.max(lambda*0.3,1e-12)
            if(improvement<=1e-12*(1+sse)||Math.max(...delta.map(value=>Math.abs(value)))<1e-8){
                converged=true
                break
            }
        }else{
            lambda*=10
            if(lambda>1e15) break
        }
    }
    sse=sseFor(parameters,predictions)
    return {parameters,yPred:predictions,sse,converged,iterations}
}