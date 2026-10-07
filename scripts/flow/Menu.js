import {CE} from "../util.js"

export class Menu{
    constructor(configObject,title,origin,destination){
        this.title=title
        this.origin=origin
        this.destination=destination
        this.container=CE('nav',{className:"menu container"},[])
        this.events={broadcast:{},listen:{}}
        this.dfs(configObject,this.container,0)
        this.draw()
        this.windowClickHandler=(e)=>{
            if(!e.target.closest('.menu .container')){
                this.container.querySelectorAll('.parent.open').forEach(elt=>elt.classList.remove('open'))
                document.body.classList.remove("menu-open")
                this.afterToggle()
            }
        }
        window.addEventListener('click',this.windowClickHandler)
    }
    dispose(){
        if(this.windowClickHandler){
            window.removeEventListener('click',this.windowClickHandler)
            this.windowClickHandler=null
        }
        this.container.remove()
    }
    dfs(object,DOMelt,rank){
        if(!Object.keys(object).length){
            return
        }
        const category=(rank==0 ? "menu" :"child")
        DOMelt.appendChild(CE('div',{className:category},[]))
        let protoDOMelt
        rank++
        for (let k of Object.keys(object)){
            if(k=='hr'){
                protoDOMelt=CE('hr',{},[])
            } else {
                const isAction=typeof object[k]=='function'
                const closeSelfAndChildren=(element)=>{
                    element.classList.remove('open')
                    for(const child of element.children){
                        closeSelfAndChildren(child)
                    }
                }
                protoDOMelt=
                CE('div',{className:"parent",tabIndex:0,
                    handleClick:(e)=>{
                        e.stopPropagation()
                        if(isAction){
                            object[k]()
                            this.container.querySelectorAll('.parent.open').forEach(elt=>elt.classList.remove('open'))
                            this.afterToggle()
                        }else{
                            for(const sibling of e.target.parentNode.children){
                                if(sibling!=e.target){
                                    closeSelfAndChildren(sibling)
                                }
                            }
                            e.target.classList.toggle('open')
                            this.afterToggle()
                        }
                    },
                }
            ,[k+(Object.keys(object[k]).length==0 || rank<2?"":"..."),])
            }
            DOMelt.lastChild.append(protoDOMelt)
            this.dfs(object[k],protoDOMelt,rank)
        }
    }
    draw(){
        if (!this.destination.querySelector('.menu.container')){
            this.destination.appendChild(this.container);
        }else{
            this.container.remove()
            this.destination.appendChild(this.container);
        }
    }
    afterToggle(){
    }
}