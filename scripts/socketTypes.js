/* TYPES DE SOCKETS — ce qui circule sur un lien entre deux nœuds.

   Pas d'enum rigide en dur : ce sont des chaînes, donc un node peut déclarer
   qu'il accepte "Any" et se connecter à n'importe quoi. Deux sockets sont
   compatibles si leurs types sont égaux, ou si l'un des deux vaut "Any".

   À terme, le menu "nouveau nœud depuis un lien" (ComfyUI-like) filtrera la
   liste des constructeurs selon le type de la sortie d'origine.
*/

export const SOCKET = {
    WAVE: "Wave",                    // tracé XY (core Float64Array + metadata)
    FORMULA_COLLECTION: "FormulaCollection", // collection de formules sérialisée
    ANY: "Any"                       // accepte n'importe quel type
}

/* Compatibilité entre une sortie et une entrée. */
export function socketCompatible(outputType, inputType) {
    if (!outputType || !inputType) return true
    return outputType === inputType ||
        outputType === SOCKET.ANY ||
        inputType === SOCKET.ANY
}

/* Par défaut, toutes les sockets d'un node sont "Any" si rien n'est déclaré. */
export function defaultSocketTypes(count) {
    return Array.from({ length: Math.max(0, Math.trunc(count) || 0) }, () => SOCKET.ANY)
}
