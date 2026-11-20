import {columnLatticeBasis,quotientRepresentative} from "./math/integerLattice.js"

const assert=(condition,message)=>{
    if(!condition){
        throw new Error(message)
    }
}
const patterns=[
    [2,1,0,0],
    [2,0,0,0],
    [0,0,0,1]
]
const prefixLattice=count=>columnLatticeBasis(
    Array.from({length:4},(_,row)=>patterns.slice(0,count).map(pattern=>pattern[row]))
)
const formulas=[
    [12,6,0,0],
    [14,7,0,0],
    [16,8,0,0],
    [12,6,0,1],
    [14,6,0,0]
]
const classAt=(count,formula)=>quotientRepresentative(formula,prefixLattice(count)).join(",")
assert(classAt(1,formulas[0])===classAt(1,formulas[1])&&
       classAt(1,formulas[1])===classAt(1,formulas[2]),
    "CH2 and H2 multiples should collapse in the cumulative quotient")
assert(classAt(1,formulas[3])!==classAt(1,formulas[0]),
    "oxygen remains a free coordinate before its pattern is applied")
assert(classAt(3,formulas[3])===classAt(3,formulas[0]),
    "the oxygen pattern collapses the oxygen difference at its cascade level")
assert(classAt(1,formulas[4])!==classAt(1,formulas[0]),
    "a formula outside the CH2 lattice remains distinct")
assert(classAt(2,formulas[0])===classAt(2,formulas[1]),
    "adding H2 preserves the CH2 equivalence because the lattice only grows")

let seed=8675309
const randomInteger=()=>{
    seed=(seed*48271)%2147483647
    return seed%7-3
}
for(let sample=0;sample<80;sample++){
    const columns=1+sample%4
    const generators=Array.from({length:columns},()=>Array.from({length:4},randomInteger))
    const matrix=Array.from({length:4},(_,row)=>generators.map(vector=>vector[row]))
    const lattice=columnLatticeBasis(matrix)
    const vector=Array.from({length:4},randomInteger)
    const coefficients=Array.from({length:columns},randomInteger)
    const translated=vector.map((value,row)=>value+
        generators.reduce((sum,generator,index)=>sum+generator[row]*coefficients[index],0))
    const baseClass=quotientRepresentative(vector,lattice)
    const translatedClass=quotientRepresentative(translated,lattice)
    assert(baseClass.join(",")===translatedClass.join(","),
        `adding pattern lattice members changed class for sample ${sample}: `+
        JSON.stringify({generators,vector,coefficients,translated,lattice,baseClass,translatedClass}))
    for(const generator of generators){
        assert(quotientRepresentative(generator,lattice).every(value=>value===0),
            `generator did not reduce to zero for sample ${sample}`)
    }
}

console.log("cumulative pattern quotients preserve exact stoichiometric equivalence")

const fullRank=columnLatticeBasis([[2,1],[1,1]])
assert(fullRank.rank===2&&fullRank.index===1,
    `a unimodular lattice should have rank 2 and index 1, got ${JSON.stringify(fullRank)}`)
const stretched=columnLatticeBasis([[2,0],[0,3]])
assert(stretched.rank===2&&stretched.index===6,
    `diagonal (2,3) should have rank 2 and index 6, got ${JSON.stringify(stretched)}`)
const deficient=columnLatticeBasis([[2,4],[0,0]])
assert(deficient.rank===1&&deficient.index===null,
    `a rank-deficient lattice has no finite index, got ${JSON.stringify(deficient)}`)
assert(prefixLattice(1).rank===1&&prefixLattice(1).index===null,
    "a single pattern in four dimensions cannot be full rank")
console.log("lattice rank and finite quotient index are reported exactly")
