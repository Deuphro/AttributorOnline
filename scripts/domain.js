import {$,CE,stylize} from "./util.js"

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
        });
        this.core=new Float64Array(this.size)
    }
    index(...indices){
        let res=0
        for(let k in indices){
            res+=indices[k]*this.cum[k]
        }
        return res
    }
}

export{NdArray}