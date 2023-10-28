class Data{
    constructor(title,...vectors){
        this.title=title
        this.core={}
        for(let vector of vectors){
            
        }
    }
}

class Vector{
    constructor(data,label=undefined,infos=undefined){
        this.label=label
        this.data=data
        if(!infos){
            this.infos={...this.detDim(data)}
        }
    }
    detDim(iterable){
        let res={dim:[],keys:[]}
        if(!Array.isArray(iterable)){res.keys.push(Object.keys(iterable))}
        let queue=Object.values(iterable)
        let newQueue=[]
        let sonSize=0
        let sonKeys=new Set()
        res.dim.push(queue.length)
        queue=queue.filter((e)=>{return Object.values(e).length>1})
        while (queue.length){
            newQueue=[]
            sonSize=0
            sonKeys=new Set()
            for(let k of queue){
                sonSize=Math.max(sonSize,Object.values(k).length)
                if(!Array.isArray(k)){Object.keys(k).forEach((e)=>{sonKeys.add(e)})}
                for(let j of Object.values(k)){
                    if(Object.values(j).length>1){
                        newQueue.push(j)
                    }
                }
            }
            res.keys.push(Array.from(sonKeys))
            queue=[...newQueue]
            res.dim.push(sonSize)
        }
        return res
    }
}

class Wave{
    constructor(...dims){
        this.dims=[...dims]
        this.cum=[1]
        for(let k=1;k<this.dims.length;k++){
            this.cum.push(this.cum[k-1]*this.dims[k-1])
        }
        this.size=dims.reduce((t,e)=>{return t*e},1)
        this.#init()
    }
    index(...coords){
        let res=0
        for(let k in coords){
            const limitedCoord=Math.min(Math.max(coords[k],0),this.dims[k]-1)
            res+=limitedCoord*this.cum[k]
        }
        return res
    }
    coords(index){
        const n=this.dims.length
        let res=new Array(n)
        const limitedIndex=Math.min(Math.max(index,0),this.size-1)
        for(let j=0;j<n;j++){
            res[j]=(Math.floor(limitedIndex/this.cum[j])%this.dims[j])
        }
        return res
    }
    #init(){
        this.#core=new Float64Array(this.size)
    }
    set explicitRec(fnct){
        const n=this.dims.length
        let dims=new Array(n)
        let coords=new Array(n)
        for(let k=0;k<n;k++){
            dims[k]=this.dims[k]
            coords[k]=0
        }
        let count=0
        const rec=(len,depth)=>{
            for(let i=0;i<len;i++){
                coords[depth]=i
                if(depth>0){
                    depth--
                    rec(dims[depth],depth)
                }else{
                    this.#core[count]=fnct(...coords)
                    count++
                }
            }
        }
        return rec(dims[n-1],n-1)
    }
    set explicit(fnct){
        const n=this.dims.length
        const m=this.size
        const o=n-1
        let coords=new Array(n)
        if(n==2){
            let k=0
            const extdim=this.dims[1]
            const intdim=this.dims[0]
            for(let i=0;i<extdim;i++){
                for(let j=0;j<intdim;j++){
                    this.#core[k]=fnct(j,i)
                    k++
                }
            }
        } else if (n==3) {
            let k=0
            const supdim=this.dims[2]
            const extdim=this.dims[1]
            const intdim=this.dims[0]
            for(let l=0;l<supdim;l++){
                for(let i=0;i<extdim;i++){
                    for(let j=0;j<intdim;j++){
                        this.#core[k]=fnct(j,i,l)
                        k++
                    }
                }
            }
        } else {
            for(let k=0;k<n;k++){
                coords[k]=this.dims[k]-1
            }
            for(let k=m-1;k>-1;k--){
                this.#core[k]=fnct(...coords)
                coords[0]--
                for(let j=0;j<o;j++){
                    if (coords[j]<0){
                        coords[j]+=this.dims[j]
                        coords[j+1]--
                    }
                }
            }
        }
    }
    get core(){
        return this.#core
    }
    set extract(fnct){
        const n=this.dims.length
        const m=this.size
        const o=n-1
        let coords=new Array(n)
        let resSize=0
        let resIndx=[]
        if(n==2){
            let k=0
            const extdim=this.dims[1]
            const intdim=this.dims[0]
            for(let i=0;i<extdim;i++){
                for(let j=0;j<intdim;j++){
                    if(fnct(j,i,this.#core[k])){
                        resSize++
                        resIndx.push(k)
                    }
                }
            }
        } else if (n==3){
            let k=0
            const supdim=this.dims[2]
            const extdim=this.dims[1]
            const intdim=this.dims[0]
            for(let l=0;l<supdim;l++){
                for(let i=0;i<extdim;i++){
                    for(let j=0;j<intdim;j++){
                        if(fnct(j,i,l,this.#core[k])){
                            resSize++
                            resIndx.push(k)
                        }
                    }
                }
            }
        } else {
            for(let k=0;k<n;k++){
                coords[k]=this.dims[k]-1
            }
            for(let k=m-1;k>-1;k--){
                if(fnct(...coords,this.#core[k])){
                    resSize++
                    resIndx.push(k)
                }
                coords[0]--
                for(let j=0;j<o;j++){
                    if (coords[j]<0){
                        coords[j]+=this.dims[j]
                        coords[j+1]--
                    }
                }
            }
        }
        let res=new Wave(resSize)
        res.implicit=(x)=>{return this.#core[resIndx[resSize-1-x]]}
        return res
    }
    get implicit(){
        const lim=this.dims.length
        const recProx=(n,target)=>{
            if(n==lim){
                return new Proxy(target,{
                    get(tegrat,prop){
                        console.log(n,prop,tegrat)
                    },
                    set(tegrat,prop,v){
                        console.log(n,prop,tegrat,v)
                    }
                })
            }else{
                return new Proxy(target,{
                    get(tegrat,prop){
                        console.log(n,prop,tegrat)
                        return recProx(n+1,tegrat)
                    },
                    set(tegrat,prop,v){
                        console.log(n,prop,tegrat,v)
                    }
                })
            }
        }
        return recProx(0,this)
    }
    stringify(){
        return this.#core.toString()
    }
    #core
}

export {Data,Vector,Wave}