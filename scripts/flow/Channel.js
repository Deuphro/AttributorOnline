export class Channel{
    constructor(origin){
        this.origin=origin
        this.eventTypes={}
        this.listeners={}
        this.casters=new Map()
        this.names=new Map()
        this.nextId=1
    }
    register(requestedName,caster,label=caster.label??caster.title??requestedName){
        let registrationName=requestedName
        let suffix=2
        while(this.names.has(registrationName)){
            registrationName=`${requestedName} (${suffix})`
            suffix++
        }
        const registrationId=`channel-${this.nextId++}`
        this.casters.set(registrationId,caster)
        this.names.set(registrationName,registrationId)
        if (!caster.events){
            caster.events={}
        }
        if (!caster.events.broadcast){
            caster.events.broadcast={}
        }
        const identity={channel:this,registrationName,registrationId,label,caster}
        caster.events.broadcast['poppedUp']=new CustomEvent("poppedUp",{detail:{msg:identity,emitter:caster}})
        caster.events.broadcast['killed']=new CustomEvent("killed",{detail:{msg:"default killed message",emitter:caster}})
        caster.events.broadcast['registered']=new CustomEvent("registered",{detail:{msg:identity,emitter:caster}})
        caster.events.registrationName=registrationName
        caster.events.registrationId=registrationId
        caster.events.label=label
        const broadcasts=caster.events.broadcast
        Object.values(broadcasts).forEach((e)=>{
            if (!this.eventTypes[e.type]){
                this.listeners[e.type]=this.defaultListener.bind(this)
                globalThis.addEventListener(e.type,this.listeners[e.type])
                this.eventTypes[e.type]=new Set()
            }
        })
        if(!caster.events.listen){
        } else {
            const listeners=caster.events.listen
            Object.keys(listeners).forEach((e)=>{
                if (!this.eventTypes[e]){
                    this.listeners[e]=this.defaultListener.bind(this)
                    globalThis.addEventListener(e,this.listeners[e])
                    this.eventTypes[e]=new Set()
                }
                this.eventTypes[e].add(registrationId)
        })
        }
        dispatchEvent(broadcasts.registered)
        dispatchEvent(broadcasts.poppedUp)
        return registrationId
    }
    get(nameOrId){
        const id=this.casters.has(nameOrId)?nameOrId:this.names.get(nameOrId)
        return id===undefined?undefined:this.casters.get(id)
    }
    setupOnAir(){
        for(let etype of Object.keys(this.eventTypes)){
            globalThis.addEventListener(etype,this.listeners[etype])
        }
    }
    shutDown(){
        for(let etype of Object.keys(this.eventTypes)){
            globalThis.removeEventListener(etype,this.listeners[etype])
        }
        this.eventTypes={}
        this.listeners={}
        this.casters.clear()
        this.names.clear()
    }
    degister(registrationId){
        const caster=this.casters.get(registrationId)
        if(!caster){
            return
        }
        this.casters.delete(registrationId)
        this.names.delete(caster.events.registrationName)
        Object.entries(this.eventTypes).forEach(([eventType,casters])=>{
            casters.delete(registrationId)
            if(!casters.size){
                globalThis.removeEventListener(eventType,this.listeners[eventType])
                delete this.eventTypes[eventType]
                delete this.listeners[eventType]
            }
        })
    }
    defaultListener(e){
        const et=e.type
        if(this.eventTypes[e.type]){
            this.eventTypes[e.type].forEach((registrationId)=>{
                const caster=this.casters.get(registrationId)
                caster?.events.listen?.[et]?.call(caster,e)
                })
        }
        if(et=="killed"){
            this.degister(e.detail.emitter.events.registrationId)
        }
    }
}