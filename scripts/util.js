//a function to select html elements
const $=(e)=>{ return document.querySelector(e); }

//a function to create a HTML element
const CE=(tag,props,child)=>{
    let res=document.createElement(tag);
    for (let k of Object.keys(props)){
        if(k=="style"){
            for(let j of Object.keys(props[k])){res.style[j]=props[k][j]}
        }else{
            res[k]=props[k]
        }
    }
    for (let elt of child) {
        if(typeof elt ==='string'){
            res.innerText=elt
        } else if(elt===null){
        } else{
            res.appendChild(elt)
        }
    }
    return res
}

//function to transfert style to CSS
const stylize=(target,styleObject)=>{
    for(let prop of Object.keys(styleObject)){
        target.style[prop]=styleObject[prop]
    }
}

function fakeData(n){
    let res=[];
    let line=[];
    let c=0;
    for(let k=0;k<(100*n);k++){
        line=[];
        for(let j=0;j<100*n/1;j++){
            c++;
            line.push(c);
        }
        res.push([...line]);
    }
    return res
}

export {$,CE,stylize,fakeData}