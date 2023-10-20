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
        this.infos={...infos,...this.detDim(data)}
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

class NdArray{
    constructor(dims){
        this.dims=dims
        this.cum=[1]
        for(let k=1;k<this.dims.length;k++){
            this.cum.push(this.cum[k-1]*this.dims[k-1])
        }
        this.size=1
        this.dims.forEach((e) => {
            this.size*=e
        })
        this.#fillCore()
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
        let res=[]
        const limitedIndex=Math.min(Math.max(index,0),this.size-1)
        for(let j in this.dims){
            res.push(Math.floor(limitedIndex/this.cum[j])%this.dims[j])
        }
        return res
    }
    #core
    #fillCore(){this.#core=new Float64Array(this.size)}
}

export {Data,Vector,NdArray}