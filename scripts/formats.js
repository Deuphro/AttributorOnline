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
        this.degree=this.dims.length
        this.cum=[1]
        for(let k=1;k<this.degree;k++){
            this.cum.push(this.cum[k-1]*this.dims[k-1])
        }
        for(let k=0;k<this.degree;k++){
            const value=k
            globalThis['_'+k]=new Function('...c','return c['+k+']')//(...c)=>{return c[value]}
        }
        this.size=dims.reduce((t,e)=>{return t*e},1)
        this.#init()
        this[Symbol.iterator]=()=>{
            let res={value:undefined,index:-1}
            const limit= this.size-1
            return{next:()=>{
                if(res.index++<limit){
                    res.value=this.core[res.index]
                    return {value:res,done:false}
                }else{
                    res={value:undefined,index:-1}
                    return {done:true}
                }
                }
            }
        }
        this.iterables=this.generateIterables()
        this.indices={
            [Symbol.iterator]:()=>{
                let res= new Array(this.degree).fill(0)
                res[0]=-1
                res.index=-1
                const limit=this.size-1
                const tik=(cursor)=>{
                    res[cursor]++
                    if(res[cursor]==this.dims[cursor]){
                        res[cursor]=0
                        tik(cursor+1)
                    }
                    return
                }
                return{next:()=>{
                    if(res.index++<limit){
                        tik(0)
                        return {value:res,done:false}
                    }else{
                        res.fill(0)
                        res[0]=-1
                        res.index=-1
                        return {done:true}
                    }
                    }
                }
            }
        }
        this.labels=new Array(this.degree)
    }
    index(...coords){
        let res=coords[0]
        for(let k=1;k<this.degree;k++){
            res+=coords[k]*this.cum[k]
        }
        return res
    }
    coords(index){
        const n=this.degree
        let res=new Array(n)
        for(let j=0;j<n;j++){
            res[j]=(Math.floor(index/this.cum[j])%this.dims[j])
        }
        return res
    }
    #init(){
        this.core=new Float64Array(this.size)
    }
    forEach(fn){
        for(let k=0;k<this.size;k++){
            fn(this.core[k],k,this.core)
        }
    }
    set fill(v){
        this.core.fill(v)
    }
    valueAt(...coords){
        let res=0
        res=coords[0]
        for(let k=1;k<this.degree;k++){
            res+=coords[k]*this.cum[k]
        }
        return this.core[res]
    }
    explicitIterators(fnct,...cleanIterables){
        let iterables=(cleanIterables.length ? [...cleanIterables] : [...this.iterables])
        let iterators=[]
        const regenIterator=(iterable)=>{return iterable[Symbol.iterator]()}
        for(let k of iterables){iterators.push(regenIterator(k))}
        const n=iterators.length
        let coords=new Array(n)
        let cursor=0
        let count=0
        let res=0
        if(n==2){
            for(let j of iterables[1]){
                for(let l of iterables[0]){
                    this.core[l+j*this.cum[1]]=fnct(l,j)
                }
            }
        }else if(n==3){
            for(let m of iterables[2]){
                for(let j of iterables[1]){
                    for(let l of iterables[0]){
                        this.core[l+j*this.cum[1]+m*this.cum[2]]=fnct(l,j,m)
                    }
                }
            }
        }else if(n==4){
            for(let o of iterables[3]){
                for(let m of iterables[2]){
                    for(let j of iterables[1]){
                        for(let l of iterables[0]){
                            this.core[l+j*this.cum[1]+m*this.cum[2]+o*this.cum[3]]=fnct(l,j,m,o)
                        }
                    }
                }
            }
        }else{
            let index=0
            for(let k in iterators){
                res=iterators[k].next()
                coords[k]=res.value
                index+=res.value*this.cum[k]
            }
            this.core[index]=fnct(...coords)
            count++
            while (cursor!=n){
                res=iterators[cursor].next()
                if(res.done){
                    iterators[cursor]=regenIterator(iterables[cursor])
                    res=iterators[cursor].next()
                    index+=(res.value-coords[cursor])*this.cum[cursor]
                    coords[cursor]=res.value
                    cursor++
                }else{
                    index+=(res.value-coords[cursor])*this.cum[cursor]
                    coords[cursor]=res.value
                    cursor=0
                    count++
                    this.core[index]=fnct(...coords)
                }
            }
        }
        //console.log(count)
    }
    set explicitRec(fnct){
        const n=this.degree
        let coords=new Array(n)
        for(let k=0;k<n;k++){
            coords[k]=0
        }
        let count=0
        let k=0
        const o=n-1
        const rec=()=>{
            this.core[count]=fnct(...coords)
            count++
            coords[0]++
            for(k=0;k<o;k++){
                if(coords[k]==this.dims[k]){
                    coords[k]=0
                    coords[k+1]++
                }
            }
            if(count<this.size){
                rec()
            }else{
                console.log(count)
            }
        }
        return rec()
    }
    set explicit(fnct){//sets the core; fnct should be (coords)=>{return fnct(coords)}
        const n=this.degree
        const m=this.size
        const o=n-1
        let coords=new Array(n)
        if(n==2){
            let k=0
            const extdim=this.dims[1]
            const intdim=this.dims[0]
            for(let i=0;i<extdim;i++){
                for(let j=0;j<intdim;j++){
                    this.core[k]=fnct(j,i)//isFinite(fnct(j,i))?fnct(j,i):this.core[k]
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
                        this.core[k]=fnct(j,i,l)
                        k++
                    }
                }
            }
        }else if(n==4){
            let k=0
            const supexdim=this.dims[3]
            const supdim=this.dims[2]
            const extdim=this.dims[1]
            const intdim=this.dims[0]
            for(let o=0;o<supexdim;o++){
                for(let l=0;l<supdim;l++){
                    for(let i=0;i<extdim;i++){
                        for(let j=0;j<intdim;j++){
                            this.core[k]=fnct(j,i,l,o)
                            k++
                        }
                    }
                }
            }
        } else {
            for(let k=0;k<n;k++){
                coords[k]=this.dims[k]-1
            }
            for(let k=m-1;k>-1;k--){
                this.core[k]=fnct(...coords)
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
    extract(fnct){
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
                    if(fnct(j,i,this.core[k])){
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
                        if(fnct(j,i,l,this.core[k])){
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
                if(fnct(...coords,this.core[k])){
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
        res.explicit=(x)=>{return this.core[resIndx[resSize-1-x]]}
        return res
    }
    get implicit(){
        const lim=this.degree
        let res=[]
        const recProx=(n,target)=>{
            if(n==lim){
                return new Proxy(target,{
                    get(tegrat,prop){
                        res.push(prop)
                        //console.log(res)
                        let coordifier=new Array(n)
                        let iterables=new Array(n)
                        iterables.ranges=new Array(n)
                        let complexity=lim
                        for(let k=0;k<lim;k++){
                            if(res[k]==''){
                                coordifier[k]=(...c)=>{return c[k]}
                                iterables[k]=target.iterables[k]
                                iterables.ranges[k]=target.iterables[k].range
                            }else if (Number.isInteger(Number(res[k]))){
                                const value=Number(res[k])
                                coordifier[k]=(...c)=>{return value}
                                iterables[k]=[parseInt(res[k])]
                                iterables.ranges[k]=1
                                complexity--
                            }else{
                                let regex=/\(((?:(?:(?:\s*[\w$]+(?:\s*=\s*.+)?\s*,)*\s*[\w$]+(?:\s*=\s*.+)?\s*,\s*)?\.{3}[\w$]+|(?:(?:\s*[\w$]+(?:\s*=\s*.+)?\s*,)*\s*[\w$]+(?:\s*=\s*.+)?)?))\)(?:\s*=>\s*)(?:(?:\{(?:return)?\s*(.*)\})|(.+))/
                                let match=regex.exec(res[k])
                                if(match){
                                    const value=new Function(match[1],'return '+(match[2]? match[2]:match[3]))
                                    //console.log(match)
                                    coordifier[k]=value
                                    iterables[k]=target.iterables[k]
                                    iterables.ranges[k]=target.iterables[k].range
                                }else{
                                    regex=/function\s*[\w$]+\s*\(((?:(?:(?:\s*[\w$]+(?:\s*=\s*.+)?\s*,)*\s*[\w$]+(?:\s*=\s*.+)?\s*,\s*)?\.{3}[\w$]+|(?:(?:\s*[\w$]+(?:\s*=\s*.+)?\s*,)*\s*[\w$]+(?:\s*=\s*.+)?)?))\n?\)\s*\{\n?\s*(?:return)\s*(.*)\s*\n?\}/
                                    match=regex.exec(res[k])
                                    if(match){
                                        const value=new Function(match[1],'return '+match[2])
                                        //console.log(match)
                                        coordifier[k]=value
                                        iterables[k]=target.iterables[k]
                                        iterables.ranges[k]=target.iterables[k].range
                                    }else{
                                        let commaSplit=res[k].split(",")
                                        let dotSplit=commaSplit.map((e)=>{return e.split(".")})
                                        let indices=new Set()
                                        for(let range of dotSplit){
                                            for(let k=parseInt(range[0]);k<parseInt(range[range.length-1])+1;k++){
                                                indices.add(k)
                                            }
                                        }
                                        iterables[k]=Array.from(indices)
                                        iterables.ranges[k]=indices.size
                                        coordifier[k]=(...c)=>{return iterables[k][c[k]]}
                                    }
                                }
                            }
                        }
                        //console.log(coordifier)
                        const modifier=(...c)=>{
                            const n=c.length
                            let res=new Array(n)
                            for(let k=0;k<n;k++){
                                res[k]=coordifier[k](...c)
                            }
                            return res
                        }
                        const outputFunc=(...coords)=>{return target.core[target.index(...modifier(...coords))]}
                        outputFunc.iterables=iterables
                        Object.defineProperty(outputFunc,'slice',{get(){
                            const res=new Wave(...this.iterables.ranges)
                            //res.explicitIterators((...c)=>{return target.core[target.index(...c)]},...this.iterables)
                            res.explicit=(...c)=>{return target.core[target.index(...modifier(...c))]}
                            return res
                        }})
                        if(complexity){
                            return outputFunc
                        }else{
                            const dummyCoord=new Array(n)
                            return outputFunc(...dummyCoord)
                        }
                    },
                    set(tegrat,prop,v){
                        res.push(prop)
                        console.log(res,v)
                        const inputType= typeof v
                        let value=0
                        switch (inputType) {
                            case "number":
                                value=()=>{return v};
                                break;
                            case "function":
                                value=v;
                                break;
                            default:
                                break;
                        }
                        let iterables=new Array(n)
                        let complexity=lim
                        for(let k=0;k<lim;k++){
                            if(res[k]==''){
                                iterables[k]=target.iterables[k]
                                complexity--
                            }else if (Number.isInteger(Number(res[k]))){
                                iterables[k]=[parseInt(res[k])]
                            }else{
                                let commaSplit=res[k].split(",")
                                let dotSplit=commaSplit.map((e)=>{return e.split(".")})
                                let indices=new Set()
                                for(let range of dotSplit){
                                    for(let k=parseInt(range[0]);k<parseInt(range[range.length-1])+1;k++){
                                        indices.add(k)
                                    }
                                }
                                iterables[k]=Array.from(indices)
                            }
                        }
                        console.log(complexity)
                        if(complexity){
                            target.explicitIterators(value,...iterables)
                        }else{
                            target.explicit=value
                        }
                        return true
                    }
                })
            }else{
                return new Proxy(target,{
                    get(tegrat,prop){
                        res.push(prop)
                        //console.log(prop,res)
                        return recProx(n+1,tegrat)
                    }
                })
            }
        }
        return recProx(1,this)
    }
    stringify(){
        return this.core.toString()
    }
    generateIterables(){
        const resu=[]
        const dims=[...this.dims]
        const makeIt=(k)=>{
            const dim=dims[k]
            let indx=0
            const res={
                range:dim,
                index:indx,
                }
            res[Symbol.iterator]=()=>{
                return{next:()=>{
                    if(indx<dim){
                        return {value:indx++,done:false}
                    }else{
                        indx=0
                        return {done:true}
                    }
                    }
                }
            }
            return res
            }
        for(let k=0;k<dims.length;k++){
            resu.push(makeIt(k))
        }
        return resu
    }
    get clone(){
        const res=new Wave(...this.dims)
        for(let k=0;k<this.size;k++){
            res.core[k]=this.core[k]
        }
        return res
    }
    swapaxes(a,b){
        let newdims=[...this.dims]
        newdims[a]=this.dims[b]
        newdims[b]=this.dims[a]
        let output=new Wave(...newdims)
        let antecum=[...this.cum]
        antecum[a]=this.cum[b]
        antecum[b]=this.cum[a]
        let counters=new Array(this.degree).fill(0)
        let anteK=0
        const tik=(cursor)=>{
            counters[cursor]++
            anteK+=antecum[cursor]
            if(counters[cursor]==newdims[cursor]){
                anteK-=(counters[cursor]*antecum[cursor])
                counters[cursor]=0
                tik(cursor+1)
            }
            return
        }
        for(let k=0;k<this.size;k++){
            output.core[k]=this.core[anteK]
            tik(0)
        }
        return output
    }
    get transpose(){
        if(this.degree==2){
            if(this.dims[0]==this.dims[1]){
                const n=this.dims[0]
                let output=new Wave(...this.dims)
                for(let i=0;i<n;i++){
                    for(let m=0;m<n;m++){
                        output.core[i+n*m]=this.core[n*i+m]
                        //output.core[n*i+m]=this.core[i+m]
                    }
                }
                return output
            }
        }
    }
}

export {Data,Vector,Wave}