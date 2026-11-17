/* =========================================================================
   EM / MÉLANGE DE GAUSSIENNES 2D — l'outil de lecture du nuage.

   Le funnel plot projette chaque paire (M, M+1) dans le plan choisi par
   l'utilisateur. En abscisse |Δppm| ou Δppm et en ordonnée δ, le nuage
   « sain » est celui qui reste collé à l'origine : masses justes des deux
   côtés, erreur différentielle faible, rapport isotopique naturel. Le reste
   est soit une autre population, soit du bruit.

   Un seuil rectangulaire ne sait pas dire ça : la forme du nuage n'est pas
   un rectangle, et deux populations peuvent se chevaucher en x comme en y
   tout en restant séparables dans le plan. On ajuste donc un mélange de
   gaussiennes 2D par expectation-maximization, puis on désigne la composante
   dont la moyenne est la plus proche de l'origine.

   TOUT EST PUR ICI : aucun DOM, aucun état, aucune collection. L'appelant
   fournit des points et reçoit les paramètres, les responsabilités et les
   étiquettes. Le dessin (ellipses, atténuation du reste) reste au funnel.

   CONVENTIONS :
     - un point est `[x,y]` ou `{x,y}` ; les non-finis sont ignorés ;
     - le calcul se fait sur des données centrées-réduites, puis les
       paramètres sont ramenés dans les unités d'origine. Sans cela, un axe
       en ppm (dizaines) et un axe δ (centièmes) donneraient au premier une
       inertie mille fois plus grande, et l'initialisation y resterait collée ;
     - le nombre de composantes est choisi par BIC quand `k` n'est pas fourni.
   ========================================================================= */

const LOG_2PI=Math.log(2*Math.PI)

/* RNG déterministe (mulberry32). Les tests comparent des sorties exactes:
   un Math.random rendrait le résultat d'un run à l'autre différent. */
function mulberry32(seed){
    let a=seed>>>0
    return function(){
        a=(a+0x6D2B79F5)>>>0
        let t=a
        t=Math.imul(t^(t>>>15),t|1)
        t^=t+Math.imul(t^(t>>>7),t|61)
        return ((t^(t>>>14))>>>0)/4294967296
    }
}

function toPairs(points){
    const out=[]
    for(const point of points??[]){
        const x=Array.isArray(point)?point[0]:point?.x
        const y=Array.isArray(point)?point[1]:point?.y
        if(Number.isFinite(x)&&Number.isFinite(y)) out.push([x,y])
    }
    return out
}

function standardize(pairs){
    const n=pairs.length
    let meanX=0
    let meanY=0
    for(const [x,y] of pairs){ meanX+=x; meanY+=y }
    meanX/=n
    meanY/=n
    let varX=0
    let varY=0
    let covXY=0
    for(const [x,y] of pairs){
        const dx=x-meanX
        const dy=y-meanY
        varX+=dx*dx
        varY+=dy*dy
        covXY+=dx*dy
    }
    varX/=n
    varY/=n
    covXY/=n
    const stdX=Math.sqrt(Math.max(varX,1e-12))||1
    const stdY=Math.sqrt(Math.max(varY,1e-12))||1
    return {
        z:pairs.map(([x,y])=>[(x-meanX)/stdX,(y-meanY)/stdY]),
        mean:[meanX,meanY],
        std:[stdX,stdY]
    }
}

/* k-means++ dans l'espace centré-réduit, suivi de quelques passes de Lloyd.
   L'EM part de là : des centres bien séparés valent mieux qu'un tirage
   uniforme, qui laisse souvent une composante vide et rend le résultat
   dépendant du hasard. */
function kmeansInit(z,k,rng){
    const n=z.length
    const centers=[z[Math.floor(rng()*n)].slice()]
    const nearest=new Float64Array(n).fill(Infinity)
    while(centers.length<k){
        let total=0
        for(let i=0;i<n;i++){
            let best=Infinity
            for(const center of centers){
                const dx=z[i][0]-center[0]
                const dy=z[i][1]-center[1]
                const distance=dx*dx+dy*dy
                if(distance<best) best=distance
            }
            nearest[i]=best
            total+=best
        }
        let pick=-1
        if(!(total>1e-12)){
            pick=Math.floor(rng()*n)
        }else{
            let target=rng()*total
            for(let i=0;i<n;i++){
                target-=nearest[i]
                if(target<=0){ pick=i; break }
            }
            if(pick<0) pick=n-1
        }
        centers.push(z[pick].slice())
    }
    const labels=new Int32Array(n)
    for(let iteration=0;iteration<12;iteration++){
        let changed=false
        for(let i=0;i<n;i++){
            let best=0
            let bestDistance=Infinity
            for(let c=0;c<centers.length;c++){
                const dx=z[i][0]-centers[c][0]
                const dy=z[i][1]-centers[c][1]
                const distance=dx*dx+dy*dy
                if(distance<bestDistance){ bestDistance=distance; best=c }
            }
            if(labels[i]!==best){ labels[i]=best; changed=true }
        }
        const sums=Array.from({length:centers.length},()=>[0,0,0])
        for(let i=0;i<n;i++){
            const sum=sums[labels[i]]
            sum[0]+=z[i][0]
            sum[1]+=z[i][1]
            sum[2]+=1
        }
        for(let c=0;c<centers.length;c++){
            if(sums[c][2]>0){
                centers[c][0]=sums[c][0]/sums[c][2]
                centers[c][1]=sums[c][1]/sums[c][2]
            }
        }
        if(!changed) break
    }
    return centers
}

function invertCovariance(covariance){
    let a=covariance[0][0]
    let b=covariance[0][1]
    let c=covariance[1][0]
    let d=covariance[1][1]
    let det=a*d-b*c
    if(!(det>1e-12)||!Number.isFinite(det)){
        a+=1e-6
        d+=1e-6
        b=0
        c=0
        det=a*d
    }
    return {
        inverse:[[d/det,-b/det],[-c/det,a/det]],
        logDet:Math.log(det)
    }
}

function logGaussian(x,y,mean,inverse,logDet){
    const dx=x-mean[0]
    const dy=y-mean[1]
    const q=inverse[0][0]*dx*dx
        +(inverse[0][1]+inverse[1][0])*dx*dy
        +inverse[1][1]*dy*dy
    return -LOG_2PI-0.5*logDet-0.5*q
}

function runEm(z,k,{maxIterations,tolerance,rng}){
    const n=z.length
    const centers=kmeansInit(z,k,rng)
    let globalXX=0
    let globalXY=0
    let globalYY=0
    for(const [x,y] of z){
        globalXX+=x*x
        globalXY+=x*y
        globalYY+=y*y
    }
    globalXX/=n
    globalXY/=n
    globalYY/=n
    const means=centers.map(center=>[center[0],center[1]])
    const weights=new Float64Array(k).fill(1/k)
    const covariances=[]
    for(let c=0;c<k;c++){
        covariances.push([
            [Math.max(globalXX,1e-3),globalXY],
            [globalXY,Math.max(globalYY,1e-3)]
        ])
    }
    const responsibilities=new Float64Array(n*k)
    const logWeights=new Float64Array(k)
    const logDensities=new Float64Array(k)
    let previous=-Infinity
    let logLikelihood=0
    let converged=false
    let iteration=0
    for(iteration=1;iteration<=maxIterations;iteration++){
        const inverses=covariances.map(invertCovariance)
        logLikelihood=0
        for(let i=0;i<n;i++){
            let maxLog=-Infinity
            for(let c=0;c<k;c++){
                const value=Math.log(Math.max(weights[c],1e-300))
                    +logGaussian(z[i][0],z[i][1],means[c],
                        inverses[c].inverse,inverses[c].logDet)
                logDensities[c]=value
                if(value>maxLog) maxLog=value
            }
            let total=0
            for(let c=0;c<k;c++) total+=Math.exp(logDensities[c]-maxLog)
            const logSum=maxLog+Math.log(total)
            logLikelihood+=logSum
            for(let c=0;c<k;c++){
                responsibilities[i*k+c]=Math.exp(logDensities[c]-logSum)
            }
        }
        for(let c=0;c<k;c++){
            let mass=0
            let meanX=0
            let meanY=0
            for(let i=0;i<n;i++){
                const r=responsibilities[i*k+c]
                mass+=r
                meanX+=r*z[i][0]
                meanY+=r*z[i][1]
            }
            if(mass<1e-10){
                const point=z[Math.floor(rng()*n)]
                means[c]=[point[0],point[1]]
                weights[c]=1e-3
                covariances[c]=[[0.5,0],[0,0.5]]
                continue
            }
            meanX/=mass
            meanY/=mass
            let varX=0
            let varY=0
            let covXY=0
            for(let i=0;i<n;i++){
                const r=responsibilities[i*k+c]
                const dx=z[i][0]-meanX
                const dy=z[i][1]-meanY
                varX+=r*dx*dx
                varY+=r*dy*dy
                covXY+=r*dx*dy
            }
            varX/=mass
            varY/=mass
            covXY/=mass
            const regularization=1e-6
            means[c]=[meanX,meanY]
            covariances[c]=[
                [varX+regularization,covXY],
                [covXY,varY+regularization]
            ]
            weights[c]=mass/n
        }
        let weightSum=0
        for(let c=0;c<k;c++) weightSum+=weights[c]
        if(weightSum>0){
            for(let c=0;c<k;c++) weights[c]/=weightSum
        }
        if(Number.isFinite(previous)
            &&Math.abs(logLikelihood-previous)<=tolerance*(1+Math.abs(logLikelihood))){
            converged=true
            break
        }
        previous=logLikelihood
    }
    return {
        k,weights,means,covariances,responsibilities,
        logLikelihood,iterations:Math.min(iteration,maxIterations),converged
    }
}

/* AJUSTE UN MÉLANGE 2D ET RENVOIE LA MEILLEURE COMPOSANTE SELON BIC.

   `k` force le nombre de composantes (utile aux tests et au sélecteur de
   l'interface) ; sans lui, on essaie 1..`maxComponents` et on garde le BIC
   minimal : -2 logL + p ln(n), avec p = 6k − 1 (deux moyennes, trois
   paramètres de covariance, un poids par composante, moins la contrainte de
   somme des poids). */
export function fitGmm2d(points,{
    k=null,maxComponents=6,tolerance=1e-7,maxIterations=400,seed=0x9e3779b9
}={}){
    const pairs=toPairs(points)
    const n=pairs.length
    if(!n) return null
    if(n===1){
        const [x,y]=pairs[0]
        return {
            k:1,means:[[x,y]],covariances:[[[1,0],[0,1]]],weights:[1],
            labels:new Int32Array([0]),counts:[1],originComponent:0,
            originDistance:Math.hypot(x,y),responsibilities:new Float64Array([1]),
            logLikelihood:0,bic:0,iterations:0,converged:true,
            standard:{mean:[x,y],std:[1,1]}
        }
    }
    const {z,mean,std}=standardize(pairs)
    const requested=Number.isInteger(k)&&k>0?k:null
    const maxK=Math.max(1,Math.min(maxComponents,n-1,requested??maxComponents))
    const candidates=requested?[Math.min(requested,maxK)]
        :Array.from({length:maxK},(_,index)=>index+1)
    let best=null
    for(const components of candidates){
        const fit=runEm(z,components,{
            maxIterations,tolerance,rng:mulberry32(seed)
        })
        const parameters=6*components-1
        const bic=-2*fit.logLikelihood+parameters*Math.log(n)
        if(!best||bic<best.bic) best={...fit,bic}
    }
    const means=best.means.map(([x,y])=>[mean[0]+x*std[0],mean[1]+y*std[1]])
    const covariances=best.covariances.map(covariance=>[
        [covariance[0][0]*std[0]*std[0],covariance[0][1]*std[0]*std[1]],
        [covariance[1][0]*std[0]*std[1],covariance[1][1]*std[1]*std[1]]
    ])
    const labels=new Int32Array(n)
    const counts=new Array(best.k).fill(0)
    for(let i=0;i<n;i++){
        let label=0
        let bestResponsibility=-1
        for(let c=0;c<best.k;c++){
            const responsibility=best.responsibilities[i*best.k+c]
            if(responsibility>bestResponsibility){
                bestResponsibility=responsibility
                label=c
            }
        }
        labels[i]=label
        counts[label]+=1
    }
    let originComponent=0
    let originDistance=Infinity
    means.forEach(([x,y],component)=>{
        const distance=Math.hypot(x,y)
        if(distance<originDistance){
            originDistance=distance
            originComponent=component
        }
    })
    return {
        k:best.k,means,covariances,weights:Array.from(best.weights),
        labels,counts,originComponent,originDistance,
        responsibilities:best.responsibilities,
        logLikelihood:best.logLikelihood,bic:best.bic,
        iterations:best.iterations,converged:best.converged,
        standard:{mean,std}
    }
}

/* DÉPAQUETER LA SORTIE PLATE DU NOYAU RUST.

   Le noyau ne peut pas rendre un objet : il rend un Vec<f64>. Ce décodeur est
   la seule définition du contrat, partagée par le worker et les tests, pour
   qu'une évolution du Rust ne puisse pas être lue de deux façons. Voir
   emgmm.rs pour la disposition exacte. */
export function unpackGmm2dFlat(flat,n){
    if(!flat||!flat.length) return null
    const k=Math.round(flat[0])
    if(!(k>0)) return null
    const iterations=Math.round(flat[1])
    const converged=flat[2]!==0
    const originComponent=Math.round(flat[3])
    const logLikelihood=flat[4]
    const bic=flat[5]
    let offset=6
    /* En-tête + poids + moyennes + covariances + effectifs + étiquettes +
       responsabilités + moyenne/écart de standardisation. */
    if(flat.length<offset+7*k+n+n*k+4) return null
    const weights=Array.from(flat.slice(offset,offset+k))
    offset+=k
    const means=[]
    for(let component=0;component<k;component++){
        means.push([flat[offset+2*component],flat[offset+2*component+1]])
    }
    offset+=2*k
    const covariances=[]
    for(let component=0;component<k;component++){
        covariances.push([
            [flat[offset+3*component],flat[offset+3*component+1]],
            [flat[offset+3*component+1],flat[offset+3*component+2]]
        ])
    }
    offset+=3*k
    const counts=Array.from(flat.slice(offset,offset+k))
    offset+=k
    const labels=Int32Array.from(flat.slice(offset,offset+n))
    offset+=n
    const responsibilities=flat.slice(offset,offset+n*k)
    offset+=n*k
    const standardMean=[flat[offset],flat[offset+1]]
    const standardStd=[flat[offset+2],flat[offset+3]]
    let originDistance=Infinity
    for(const [x,y] of means){
        const distance=Math.hypot(x,y)
        if(distance<originDistance) originDistance=distance
    }
    return {
        k,means,covariances,weights,labels,counts,
        originComponent,originDistance,responsibilities,
        logLikelihood,bic,iterations,converged,
        standard:{mean:standardMean,std:standardStd}
    }
}

/* LE CONTOUR D'UNE GAUSSIENNE 2D, fermé, pour le dessin.

   Décomposition propre d'une matrice 2×2 : les demi-axes valent
   `sqrt(λ) × radius` le long des vecteurs propres. `radius=2` est le contour
   à 2σ, qui contient environ 86 % d'une gaussienne 2D ; `radius=1` en
   contient 39 %, et sert à montrer le cœur de la population. */
export function gaussianEllipse(mean,covariance,{radius=2,samples=64}={}){
    const a=covariance[0][0]
    const b=covariance[0][1]
    let d=covariance[1][1]
    if(!(d>0)) d=1e-12
    const trace=a+d
    const discriminant=Math.sqrt(Math.max(0,(a-d)*(a-d)/4+b*b))
    const major=Math.max(1e-12,trace/2+discriminant)
    const minor=Math.max(0,trace/2-discriminant)
    let vectorX
    let vectorY
    if(Math.abs(b)>1e-12){
        vectorX=major-d
        vectorY=b
    }else if(a>=d){
        vectorX=1
        vectorY=0
    }else{
        vectorX=0
        vectorY=1
    }
    const norm=Math.hypot(vectorX,vectorY)||1
    vectorX/=norm
    vectorY/=norm
    const halfMajor=Math.sqrt(major)*radius
    const halfMinor=Math.sqrt(minor)*radius
    const count=Math.max(8,Math.floor(samples))
    const points=new Array(count+1)
    for(let index=0;index<=count;index++){
        const angle=2*Math.PI*index/count
        const along=Math.cos(angle)*halfMajor
        const across=Math.sin(angle)*halfMinor
        points[index]=[
            mean[0]+along*vectorX-across*vectorY,
            mean[1]+along*vectorY+across*vectorX
        ]
    }
    return points
}
