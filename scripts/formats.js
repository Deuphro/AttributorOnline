class Data{
    constructor(title,...vectors){
        this.title=title
        this.core={}
        for(let vector of vectors){
            
        }
    }
}

class Vector{
    constructor(data,infos=undefined){
        this.data=data
        this.infos={...infos,...this.detDim(data)}
    }
    detDim(iterable){
        let res={dim:[],keys:[[]]}
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

export {Data,Vector}