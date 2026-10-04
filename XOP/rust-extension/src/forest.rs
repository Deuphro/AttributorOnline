//! Forest — l'arbre couvrant de poids minimal sur les points MESURÉS.
//!
//! L'ORACLE est `GrowForest` et ses deux fonctions dans
//! resources/ProcAttributorLegacy/MainProc.ipf:
//!
//!   - `calcBestof(obs,Adja,stds)`  — pour chaque paire de pics (k<j), l'écart
//!     `|obs[k]-obs[j]|` est comparé aux masses de référence; s'il tombe à moins
//!     de 0.5 d'une, l'arête existe et son POIDS est l'erreur résiduelle.
//!   - `kruskal4mass(obs,Adja,poids,parent,degmax)` — les arêtes sont triées par
//!     poids croissant, puis Kruskal les accepte tant que les deux bouts sont
//!     dans des arbres différents ET que le degré maximal n'est pas atteint.
//!
//! CE QUI CHANGE, ET POURQUOI.
//!
//! Igor tient trois matrices n×n (`Adja`, `Adja_temp`, `Poids`): 24 octets par
//! point et par matrice, donc 240 Mo pour 10 000 pics — et il compare chaque
//! paire à CHAQUE masse de référence, ce qui est O(n²·s). Ici il n'y a AUCUNE
//! matrice: les arêtes candidates vivent dans un unique vecteur plat, la
//! référence la plus proche est trouvée par RECHERCHE BINAIRE dans une liste
//! triée (O(log s) au lieu de O(s)), et la boucle des paires S'ARRÊTE dès que
//! l'écart dépasse la plus grosse référence — les masses étant triées, tous les
//! j suivants donneraient un écart plus grand. La course devient donc
//! O(n·w·log s) au lieu de O(n²·s), et la mémoire O(E) au lieu de O(n²).
//!
//! Ce qui est conservé, parce que c'est de la physique et pas de
//! l'implémentation: le poids d'une arête est l'erreur en unités de masse (Da,
//! pas ppm), et la meilleure référence est celle qui minimise l'écart — à
//! égalité, celle d'indice le plus BAS, comme le `whichgap[0]` d'Igor.
//!
//! CE QUI N'EST PAS PORTÉ, VOLONTAIREMENT: le bloc statistique de
//! `kruskal4mass` (`stal`, `meanpoids`, `residue`, `bayesianCut`). Il
//! n'amène rien à l'arbre — il calculait un résidu, imprimait, et pouvait
//! avorter la course sur un critère qui n'a pas de sens mathématique — et il
//! lisait `residue[-1]` dès la première itération. Le porter serait transporter
//! un arrêt sur erreur. Ce qui reste est l'arbre, proprement dit.

use wasm_bindgen::prelude::*;

/// Le nombre de valeurs par arête: `u`, `v`, poids, indice de la référence.
/// Une constante nommée et exportée, parce que JS doit découper sur le MÊME
/// nombre — deux découpages qui divergent donneraient une sortie silencieusement
/// fausse, qui est le pire genre de bug possible ici.
pub const EDGE_STRIDE: usize = 4;

/// Ce que rend `forest_grow`.
///
/// Les tableaux sont PLATS et non entrelacés: c'est la forme que le worker
/// transporte et que `toFloat64` rend directement. Les composants sont ORDONNÉS
/// par taille décroissante puis par indice de sommet croissant — le même tri que
/// le `Sort2D(...,1,1,-1)` d'Igor, rendu déterministe.
#[wasm_bindgen]
pub struct Forest {
    edge_u: Vec<f64>,
    edge_v: Vec<f64>,
    edge_weight: Vec<f64>,
    edge_standard: Vec<f64>,
    degree: Vec<f64>,
    component_of: Vec<f64>,
    component_root: Vec<f64>,
    component_size: Vec<f64>,
    component_max_intensity: Vec<f64>,
    component_weight: Vec<f64>,
    component_root_mass: Vec<f64>,
    component_peak_mass: Vec<f64>,
    candidates: f64,
    isolated: f64,
}
#[wasm_bindgen]
impl Forest {
    #[wasm_bindgen(getter)]
    pub fn edge_u(&self) -> Vec<f64> {
        self.edge_u.clone()
    }
    #[wasm_bindgen(getter)]
    pub fn edge_v(&self) -> Vec<f64> {
        self.edge_v.clone()
    }
    #[wasm_bindgen(getter)]
    pub fn edge_weight(&self) -> Vec<f64> {
        self.edge_weight.clone()
    }
    /// L'indice, dans la liste des RÉFÉRENCES, de celle qui a matché l'arête.
    /// C'est ce qui permet à l'écran d'écrire « CH2 » sur un lien sans que le
    /// noyau ait jamais su ce qu'est une formule.
    #[wasm_bindgen(getter)]
    pub fn edge_standard(&self) -> Vec<f64> {
        self.edge_standard.clone()
    }
    #[wasm_bindgen(getter)]
    pub fn degree(&self) -> Vec<f64> {
        self.degree.clone()
    }
    /// Le rang du composant de chaque point, dans les tableaux de composants.
    #[wasm_bindgen(getter)]
    pub fn component_of(&self) -> Vec<f64> {
        self.component_of.clone()
    }
    #[wasm_bindgen(getter)]
    pub fn component_root(&self) -> Vec<f64> {
        self.component_root.clone()
    }
    #[wasm_bindgen(getter)]
    pub fn component_size(&self) -> Vec<f64> {
        self.component_size.clone()
    }
    #[wasm_bindgen(getter)]
    pub fn component_max_intensity(&self) -> Vec<f64> {
        self.component_max_intensity.clone()
    }
    /// Le poids TOTAL de l'arbre du composant: la somme des erreurs de ses
    /// arêtes. C'est la grandeur que l'on compare entre deux lectures du même
    /// spectre, et ce n'est PAS la somme des poids de toutes les arêtes
    /// candidates — seulement de celles que Kruskal a gardées.
    #[wasm_bindgen(getter)]
    pub fn component_weight(&self) -> Vec<f64> {
        self.component_weight.clone()
    }
    /// La masse du sommet le plus LÉGER du composant — l'ancêtre qu'Igor
    /// prenait dans `roipnts[0]`, et donc celui qu'il attribuait.
    #[wasm_bindgen(getter)]
    pub fn component_root_mass(&self) -> Vec<f64> {
        self.component_root_mass.clone()
    }
    #[wasm_bindgen(getter)]
    pub fn component_peak_mass(&self) -> Vec<f64> {
        self.component_peak_mass.clone()
    }
    /// Combien de paires ont trouvé une référence. C'est le DIAGNOSTIC qui
    /// compte: le nombre d'arêtes possibles avant le tri et le plafond de degré,
    /// donc il dit si un composant est pauvre par absence de liens ou par abandon.
    #[wasm_bindgen(getter)]
    pub fn candidates(&self) -> f64 {
        self.candidates
    }
    #[wasm_bindgen(getter)]
    pub fn isolated(&self) -> f64 {
        self.isolated
    }
    #[wasm_bindgen(getter)]
    pub fn edge_count(&self) -> f64 {
        self.edge_u.len() as f64
    }
    #[wasm_bindgen(getter)]
    pub fn component_count(&self) -> f64 {
        self.component_size.len() as f64
    }
}
/// Une arête candidate: le poids EST l'erreur, donc le tri se lit ensuite.
#[derive(Clone, Copy)]
struct Candidate {
    weight: f64,
    u: usize,
    v: usize,
    std_index: usize,
}

/// Union-Find avec compression de chemin ET union par taille. La compression
/// seule suffirait; la taille est gratuite et garde la profondeur logarithmique
/// quand le graphe est une longue chaîne de triangles.
struct UnionFind {
    parent: Vec<usize>,
    size: Vec<usize>,
}

impl UnionFind {
    fn new(n: usize) -> Self {
        UnionFind {
            parent: (0..n).collect(),
            size: vec![1; n],
        }
    }
    fn find(&mut self, mut i: usize) -> usize {
        while self.parent[i] != i {
            let grand = self.parent[self.parent[i]];
            self.parent[i] = grand;
            i = grand;
        }
        i
    }
    fn union(&mut self, a: usize, b: usize) {
        let (mut ra, mut rb) = (self.find(a), self.find(b));
        if ra == rb {
            return;
        }
        if self.size[ra] < self.size[rb] {
            std::mem::swap(&mut ra, &mut rb);
        }
        self.parent[rb] = ra;
        self.size[ra] += self.size[rb];
    }
}

/// La référence la plus proche de `gap` dans une liste TRIÉE, et son erreur.
///
/// Le choix à égalité est l'INDICE LE PLUS BAS, comme le `whichgap[0]` d'Igor:
/// deux références à la même distance sont indiscernables pour la physique, donc
/// il faut au moins que le choix soit DÉTERMINISTE — sinon le même spectre
/// donnerait deux arbres différents d'une exécution à l'autre.
fn nearest_standard(sorted: &[f64], gap: f64) -> Option<(usize, f64)> {
    if sorted.is_empty() {
        return None;
    }
    let mut low = 0usize;
    let mut high = sorted.len();
    while low < high {
        let mid = (low + high) / 2;
        if sorted[mid] < gap {
            low = mid + 1;
        } else {
            high = mid;
        }
    }
    let mut best: Option<(usize, f64)> = None;
    /* Seuls les deux voisins du point d'insertion peuvent être les plus
       proches. `.iter().copied()` et non `into_iter()`: le crate est en édition
       2018, où `into_iter` sur un tableau ne donne que des RÉFÉRENCES — et
       indexer un `&[f64]` par un `&usize` ne compile pas. */
    for index in [
        low.checked_sub(1),
        if low < sorted.len() { Some(low) } else { None },
    ]
    .iter()
    .copied()
    .flatten()
    {
        let error = (sorted[index] - gap).abs();
        //comparaison STRICTE: une erreur égale garde l'indice le plus bas, donc
        //celui que l'on a examiné en premier
        let better = match best {
            None => true,
            Some((_, best_error)) => error < best_error,
        };
        if better {
            best = Some((index, error));
        }
    }
    best
}

/// Un résultat vide, et il est NOMÉ: c'est la réponse à une entrée refusée, pas
/// un forgot de calcul. C'est donc une fermeture, pas une allocation écrite
/// cinq fois.
fn empty_forest() -> Forest {
    Forest {
        edge_u: Vec::new(),
        edge_v: Vec::new(),
        edge_weight: Vec::new(),
        edge_standard: Vec::new(),
        degree: Vec::new(),
        component_of: Vec::new(),
        component_root: Vec::new(),
        component_size: Vec::new(),
        component_max_intensity: Vec::new(),
        component_weight: Vec::new(),
        component_root_mass: Vec::new(),
        component_peak_mass: Vec::new(),
        candidates: 0.0,
        isolated: 0.0,
    }
}
/// L'arbre couvrant de poids minimal sur des points MESURÉS.
///
/// `masses` doit être TRIÉ par masse croissante — c'est ce qui autorise l'arrêt
/// précoce de la boucle des paires, et le seul prérequis que la fonction ne
/// peut pas vérifier elle-même sans payer un tri qu'elle ne sera pas amenée à
/// faire. C'est donc un CONTRAT, et il est écrit ici parce qu'un contrat non
/// écrit est un bug qui n'apparaît qu'à l'écran.
///
/// `intensities` sert au composant le plus intense, comme le `wavemax(roi1)`
/// d'Igor. `standards` sont des masses EN M/Z: la comparaison se fait donc dans
/// l'espace mesuré, et c'est à l'appelant de diviser par la charge —
/// `forest.js` le fait, à partir des briques du plan.
///
/// `degree_max` plafonne le degré d'un sommet; `<= 0` ou non fini signifie
/// « aucun plafond », ce qui est le `degmax=inf` de `GrowForest`.
#[wasm_bindgen]
pub fn forest_grow(
    masses: &[f64],
    intensities: &[f64],
    standards: &[f64],
    tolerance: f64,
    degree_max: f64,
) -> Forest {
    let n = masses.len();
    /* LES REFUS, ET ILS SONT ÉCRITS.

       Une tolérance nulle ou négative n'est pas une fenêtre, et une liste de
       références vide n'a rien à comparer. Rendre un arbre vide dans ces cas est
       la seule réponse qui ne mente pas: une tolérance négative rendrait
       « distance 0 » admissible partout, c'est-à-dire un graphe complet. */
    if n == 0 || masses.len() != intensities.len() {
        return empty_forest();
    }
    if !tolerance.is_finite() || tolerance <= 0.0 {
        return empty_forest();
    }
    /* LES RÉFÉRENCES, COPIÉES ET TRIÉES.

       La copie est délibérée: l'appelant garde sa liste dans l'ordre qu'il a
       choisie, et les indices que le noyau rend se rapportent à CET ordre —
       donc trier une référence interne casserait le libellé écrit sur le lien. */
    let mut references: Vec<(f64, usize)> = standards
        .iter()
        .enumerate()
        .filter(|(_, mass)| mass.is_finite() && **mass > 0.0)
        .map(|(index, mass)| (*mass, index))
        .collect();
    if references.is_empty() {
        return empty_forest();
    }
    references.sort_by(|a, b| a.0.partial_cmp(&b.0).unwrap_or(std::cmp::Ordering::Equal));
    let reference_masses: Vec<f64> = references.iter().map(|(mass, _)| *mass).collect();

    /* LA COUPURE, et c'est elle qui donne le gain asymptotique.

       Igor testait `ecart < max(Stds)+1`, le `+1` étant de la marge pour sa
       fenêtre fixe de 0.5. Ici la fenêtre EST le paramètre, donc la marge
       devient la fenêtre: au-delà, aucune référence n'est plus atteignable, et
       comme les masses sont triées tous les `j` suivants le sont non plus.
       On peut donc SORTIR de la boucle, ce qu'Igor ne pouvait pas faire. */
    let reach = reference_masses[reference_masses.len() - 1] + tolerance;

    let mut candidates: Vec<Candidate> = Vec::new();
    for k in 0..n {
        let low = masses[k];
        if !low.is_finite() {
            continue;
        }
        for j in (k + 1)..n {
            let gap = masses[j] - low;
            if !(gap <= reach) {
                break;
            }
            if let Some((index, error)) = nearest_standard(&reference_masses, gap) {
                if error < tolerance {
                    candidates.push(Candidate {
                        weight: error,
                        u: k,
                        v: j,
                        std_index: references[index].1,
                    });
                }
            }
        }
    }
    let found = candidates.len() as f64;

    /* LE TRI DES POIDS, et c'est LUI que le noyau existe.

       `sort_unstable_by` sur le poids, puis sur les DEUX indices: le second
       critère rend le résultat indépendant de l'algorithme de tri interne,
       donc deux exécutions — ou deux versions du noyau — donnent le même
       arbre. L'ordre d'Igor était le poids puis `col` puis `row`, ce qui est le
       même arbitrage écrit à l'envers. */
    candidates.sort_unstable_by(|a, b| {
        a.weight
            .partial_cmp(&b.weight)
            .unwrap_or(std::cmp::Ordering::Equal)
            .then(a.u.cmp(&b.u))
            .then(a.v.cmp(&b.v))
    });

    let cap = if !degree_max.is_finite() || degree_max <= 0.0 {
        None
    } else {
        Some(degree_max as usize)
    };
    let mut union_find = UnionFind::new(n);
    let mut degree = vec![0usize; n];
    let mut kept: Vec<Candidate> = Vec::new();
    for edge in candidates {
        if union_find.find(edge.u) == union_find.find(edge.v) {
            continue;
        }
        /* LE PLAFOND DE DEGRÉ, et la condition est celle d'Igor: les DEUX bouts
           doivent être sous le plafond AVANT l'ajout, donc un sommet atteint le
           plafond exactement et refuse ensuite. `degmax=2` donne des nœuds de
           degré 2 — c'est le mode « réticules » d'Igor, où chaque sommet
           n'accroche que deux voisins. */
        if let Some(limit) = cap {
            if degree[edge.u] >= limit || degree[edge.v] >= limit {
                continue;
            }
        }
        union_find.union(edge.u, edge.v);
        degree[edge.u] += 1;
        degree[edge.v] += 1;
        kept.push(edge);
    }
/* LES COMPOSANTS, et `component_of` EN EST LA VÉRITÉ.

       On regroupe par racine d'union-Find, chaque groupe étant représenté par
       son SOMMET DE PLUS FAIBLE INDICE — donc le plus léger, puisque les masses
       sont triées. C'est l'ancêtre qu'Igor attribuait depuis `roipnts[0]`: le
       choix n'est pas cosmétique, c'est celui qui décide de la formule proposée
       pour l'arbre entier.

       Un sommet isolé est son PROPRE composant, comme le faisait le `Parent=x`
       d'Igor. Une liste de 95 pics dont 3 sont reliés ne donne donc pas
       3 composants mais 93, et annoncer 3 ferait croire que les 92 autres ont
       disparu du spectre. */
    let mut roots: Vec<usize> = Vec::new();
    let mut representative: Vec<usize> = Vec::new();
    for node in 0..n {
        let root = union_find.find(node);
        match roots.iter().position(|r| *r == root) {
            /* ON NE REMPLACE PAS: le représentant est le PREMIER nœud rencontré,
               donc le plus faible indice — et c'est lui qu'Igor attribuait.
               Réécrire à chaque passage donnait le DERNIER, c'est-à-dire le pic
               le plus LÉGER de l'arbre: un composant était alors classé par la
               masse de son sommet le plus haut au lieu de son ancêtre. */
            Some(_) => {}
            None => {
                roots.push(root);
                representative.push(node);
            }
        }
    }
    let rank_of_root = |root: usize| roots.iter().position(|r| *r == root).expect("root recorded");

    let mut sizes = vec![0usize; roots.len()];
    let mut max_intensity = vec![f64::NEG_INFINITY; roots.len()];
    let mut peak_mass = vec![f64::NEG_INFINITY; roots.len()];
    let mut component_of = vec![0f64; n];
    for node in 0..n {
        let rank = rank_of_root(union_find.find(node));
        sizes[rank] += 1;
        if intensities[node] > max_intensity[rank] {
            max_intensity[rank] = intensities[node];
        }
        if masses[node] > peak_mass[rank] {
            peak_mass[rank] = masses[node];
        }
        component_of[node] = rank as f64;
    }

    /* LE RANG, et il est DONNÉ ICI plutôt que recalculé par JS.

       Les composants sont triés par taille décroissante, puis par sommet
       croissant. Le tri se fait UNE fois, dans le noyau, et `component_of`
       porte le rang DÉFINITIF: l'écran ne peut donc pas classer un composant
       autrement que le noyau ne l'a classé, même s'il se trompait de clé. */
    let mut order: Vec<usize> = (0..roots.len()).collect();
    order.sort_by(|a, b| {
        sizes[*b]
            .cmp(&sizes[*a])
            .then(representative[*a].cmp(&representative[*b]))
    });
    let mut position_of_rank = vec![0usize; roots.len()];
    for (rank, old) in order.iter().enumerate() {
        position_of_rank[*old] = rank;
    }
    for slot in component_of.iter_mut() {
        *slot = position_of_rank[*slot as usize] as f64;
    }

    let mut component_weight = vec![0f64; order.len()];
    for edge in &kept {
        component_weight[component_of[edge.u] as usize] += edge.weight;
    }

    let component_root: Vec<f64> = order.iter().map(|r| representative[*r] as f64).collect();
    let component_size: Vec<f64> = order.iter().map(|r| sizes[*r] as f64).collect();
    let component_root_mass: Vec<f64> = order.iter().map(|r| masses[representative[*r]]).collect();
    let component_peak_mass: Vec<f64> = order
        .iter()
        .map(|r| if peak_mass[*r].is_finite() { peak_mass[*r] } else { 0.0 })
        .collect();
    let component_max_intensity: Vec<f64> = order
        .iter()
        .map(|r| if max_intensity[*r].is_finite() { max_intensity[*r] } else { 0.0 })
        .collect();
    let isolated = degree.iter().filter(|d| **d == 0).count() as f64;

    Forest {
        edge_u: kept.iter().map(|e| e.u as f64).collect(),
        edge_v: kept.iter().map(|e| e.v as f64).collect(),
        edge_weight: kept.iter().map(|e| e.weight).collect(),
        edge_standard: kept.iter().map(|e| e.std_index as f64).collect(),
        degree: degree.iter().map(|d| *d as f64).collect(),
        component_of,
        component_root,
        component_size,
        component_max_intensity,
        component_weight,
        component_root_mass,
        component_peak_mass,
        candidates: found,
        isolated,
    }
}
#[cfg(test)]
mod tests {
    use super::*;

    /* LE TEST DE BASE: deux pics séparés d'une référence, au centième de Dalton.

       C'est le cas que `calcBestof` doit accrocher, et il ne doit le faire
       qu'une fois: une arête, un composant. */
    #[test]
    fn links_two_peaks_on_a_reference() {
        let forest = forest_grow(&[100.0, 114.02], &[10.0, 20.0], &[14.0], 0.5, 0.0);
        assert_eq!(forest.edge_count(), 1.0);
        assert_eq!(forest.edge_u[0], 0.0);
        assert_eq!(forest.edge_v[0], 1.0);
        assert!((forest.edge_weight[0] - 0.02).abs() < 1e-12);
        assert_eq!(forest.component_count(), 1.0);
        assert_eq!(forest.component_size[0], 2.0);
    }

    /* LE REFUS PAR LA FENÊTRE, et il doit être VISIBLE.

       Un écart de 0.6 avec une tolérance de 0.5 ne produit aucune arête: un
       noyau qui lierait quand même afficherait un composant de deux points dont
       personne ne peut lire l'erreur. */
    #[test]
    fn refuses_a_gap_outside_the_window() {
        let forest = forest_grow(&[100.0, 114.6], &[10.0, 20.0], &[14.0], 0.5, 0.0);
        assert_eq!(forest.edge_count(), 0.0);
        assert_eq!(forest.candidates, 0.0);
        assert_eq!(forest.component_count(), 2.0);
        assert_eq!(forest.isolated, 2.0);
    }

    /* LE TRI COMPTE, et c'est le cœur du Kruskal.

       Trois pics A, B, C. A–B est à 0.10 d'une référence, B–C à 0.02, A–C à
       0.08 d'une AUTRE référence. Le noyau prend B–C (la plus légère), puis
       A–C, qui refermerait un cycle — et il s'arrête là: l'arbre tient en
       0.10. C'est le test qui distingue « trier les poids » de « accepter la
       première arête trouvée »: dans l'ordre d'énumération des paires, A–B
       (0.10) passerait avant A–C (0.08) et l'arbre pèserait 0.12. */
    #[test]
    fn sorts_weights_before_building() {
        let forest = forest_grow(
            &[100.0, 114.10, 128.08],
            &[1.0, 1.0, 1.0],
            &[14.0, 28.0],
            0.5,
            0.0,
        );
        assert_eq!(forest.edge_count(), 2.0);
        let total: f64 = forest.edge_weight.iter().sum();
        assert!((total - 0.10).abs() < 1e-9, "tree weight was {}", total);
        assert_eq!(forest.component_size[0], 3.0);
    }

    /* LE PLAFOND DE DEGRÉ, et sa lecture EXACTE.

       Une étoile: un pic central et trois voisins, trois références BIEN SÉPARÉES
       pour que les voisins ne se ressemblent pas entre eux. Sans plafond:
       trois arêtes, degré 3. Avec `degmax=2` — le mode « réticules » d'Igor —
       le sommet n'accroche que deux voisins, donc deux arêtes et un voisin qui
       reste seul. */
    #[test]
    fn degree_cap_holds_at_the_limit() {
        let masses = [100.0, 114.10, 130.30, 148.45];
        let standards = [14.0, 30.0, 48.0];
        let free = forest_grow(&masses, &[1.0, 1.0, 1.0, 1.0], &standards, 0.5, 0.0);
        assert_eq!(free.edge_count(), 3.0);
        assert_eq!(free.degree[0], 3.0);
        let capped = forest_grow(&masses, &[1.0, 1.0, 1.0, 1.0], &standards, 0.5, 2.0);
        assert_eq!(capped.edge_count(), 2.0);
        assert!(capped.degree.iter().all(|d| *d <= 2.0));
    }
/* LE COMPOSANT LE PLUS INTENSE, parce que c'est ce qu'Igor affichait.

       Trois pics reliés, celui du milieu est le plus intense: le composant doit
       le dire, sinon l'écran montrerait le pic le plus fort en faisant croire
       que c'est l'ancêtre. */
    #[test]
    fn reports_the_tallest_peak_of_each_component() {
        let forest = forest_grow(&[100.0, 114.01, 128.02], &[5.0, 900.0, 7.0], &[14.0], 0.5, 0.0);
        assert_eq!(forest.component_count(), 1.0);
        assert_eq!(forest.component_max_intensity[0], 900.0);
        assert_eq!(forest.component_root[0], 0.0);
        assert_eq!(forest.component_root_mass[0], 100.0);
        assert_eq!(forest.component_peak_mass[0], 128.02);
    }

    /* LE CLASSEMENT DES COMPOSANTS, taille d'abord.

       Un groupe de trois et un pic seul: le groupe sort EN TÊTE, comme le
       `Sort2D(...,1,1,-1)` d'Igor. C'est ce qui fait que la liste affichée
       commence par ce qui explique le plus de signal. */
    #[test]
    fn orders_components_by_size() {
        let forest = forest_grow(
            &[100.0, 114.01, 128.02, 300.0],
            &[1.0, 1.0, 1.0, 9.0],
            &[14.0],
            0.5,
            0.0,
        );
        assert_eq!(forest.component_count(), 2.0);
        assert_eq!(forest.component_size[0], 3.0);
        assert_eq!(forest.component_size[1], 1.0);
        assert_eq!(forest.component_root[1], 3.0);
    }

    /* LE POINT ISOLÉ EST UN COMPOSANT, et non un trou.

       95 pics dont 3 reliés donnent 93 composants. Compter 3 ferait croire que
       92 pics ont disparu, donc l'isolé est compté ET listé. */
    #[test]
    fn an_isolated_peak_is_its_own_component() {
        let forest = forest_grow(
            &[100.0, 114.01, 128.02, 400.0],
            &[1.0, 1.0, 1.0, 1.0],
            &[14.0],
            0.5,
            0.0,
        );
        assert_eq!(forest.component_count(), 2.0);
        assert_eq!(forest.component_size[0], 3.0);
        assert_eq!(forest.component_size[1], 1.0);
        assert_eq!(forest.isolated, 1.0);
        assert_eq!(forest.component_of[3], 1.0);
    }

    /* LA RÉFÉRENCE LA PLUS PROCHE GAGNE, et à ÉGALITÉ LE PLUS BAS INDICE.

       Les deux moitiés du test utilisent des NOMMES EXACTS en binaire — 10.25
       et 10.5 le sont, 10.2 ne l'est pas. C'est délibéré: `110.2 - 100.0` vaut
       10.200000000000003, donc un « écart de 10.2 » n'est PAS une égalité entre
       10.0 et 10.4, et un test écrit avec 10.2 ne prouve pas l'égalité qu'il
       prétend vérifier — il prouve un arrondi, et il échouerait ou passerait
       selon la machine. */
    #[test]
    fn nearest_reference_wins_and_ties_go_to_the_lowest_index() {
        //gap 10.25: 0.25 des deux côtés, et les deux sont exacts en binaire
        let tie = forest_grow(&[100.0, 110.25], &[1.0, 1.0], &[10.0, 10.5], 0.5, 0.0);
        assert_eq!(tie.edge_standard[0], 0.0);
        //gap 10.4: la référence à 10.5 est à 0.1, celle à 10.0 à 0.4
        let nearer = forest_grow(&[100.0, 110.4], &[1.0, 1.0], &[10.0, 10.5], 0.5, 0.0);
        assert_eq!(nearer.edge_standard[0], 1.0);
    }
/* L'ARRÊT PRÉCOCE NE CHANGE RIEN AU RÉSULTAT.

       La boucle des paires s'arrête dès que l'écart dépasse la plus grosse
       référence. Un pic très isolé, très loin de tout, ne doit donc ni ralentir
       ni promettre d'arête — c'est le test qui prouve que l'optimisation est une
       optimisation et pas un raccourci. */
    #[test]
    fn the_early_break_loses_no_edge() {
        let masses = [100.0, 114.01, 128.02, 900.0];
        let forest = forest_grow(&masses, &[1.0, 1.0, 1.0, 1.0], &[14.0], 0.5, 0.0);
        assert_eq!(forest.edge_count(), 2.0);
        assert_eq!(forest.component_count(), 2.0);
        assert_eq!(forest.component_size[0], 3.0);
    }

    /* LES REFUS, ET ILS RENDENT UN ARBRE VIDE PLUTÔT QU'UN ARBRE FORTUIT.

       Une tolérance négative rendrait « distance 0 » admissible partout, donc un
       graphe complet: c'est un résultat, pas une erreur, et il ne doit donc pas
       pouvoir être produit par accident. */
    #[test]
    fn refuses_impossible_windows() {
        let peaks = [100.0, 114.0];
        assert_eq!(forest_grow(&peaks, &[1.0, 1.0], &[14.0], -1.0, 0.0).edge_count(), 0.0);
        assert_eq!(forest_grow(&peaks, &[1.0, 1.0], &[14.0], 0.0, 0.0).edge_count(), 0.0);
        assert_eq!(forest_grow(&peaks, &[1.0, 1.0], &[], 0.5, 0.0).edge_count(), 0.0);
        assert_eq!(forest_grow(&[], &[], &[14.0], 0.5, 0.0).edge_count(), 0.0);
        /* Une liste de masses et une liste d'intensités de tailles différentes
           est une erreur d'APPELANT, pas un cas limite: les appairer lirait
           hors du bord de l'une des deux. */
        assert_eq!(forest_grow(&peaks, &[1.0], &[14.0], 0.5, 0.0).edge_count(), 0.0);
    }

    /* DEUX EXÉCUTIONS, LE MÊME ARBRE.

       Le tri par (poids, u, v) rend le résultat indépendant de l'algorithme de
       tri interne. Deux appels doivent donc être identiques ARBORESCENCE ET
       ORDRE — c'est ce qui permet à un test de parité JS↔Rust de comparer des
       LISTES plutôt que des ensembles. */
    #[test]
    fn the_result_is_deterministic() {
        let masses = [100.0, 114.0, 128.1, 142.05, 156.2];
        let first = forest_grow(&masses, &[3.0, 1.0, 4.0, 1.0, 5.0], &[14.0, 28.0], 0.5, 0.0);
        let second = forest_grow(&masses, &[3.0, 1.0, 4.0, 1.0, 5.0], &[14.0, 28.0], 0.5, 0.0);
        assert_eq!(first.edge_u, second.edge_u);
        assert_eq!(first.edge_v, second.edge_v);
        assert_eq!(first.edge_weight, second.edge_weight);
        assert_eq!(first.component_of, second.component_of);
    }

    /* LE POIDS TOTAL D'UN COMPOSANT, et sa différence avec la somme des
       CANDIDATES.

       C'est la grandeur que l'on compare entre deux lectures: elle ne compte
       que les arêtes GARDÉES, sinon deux arbres différents donneraient le même
       score. */
    #[test]
    fn component_weight_counts_kept_edges_only() {
        let forest = forest_grow(&[100.0, 114.10, 128.05], &[1.0, 1.0, 1.0], &[14.0, 28.0], 0.5, 0.0);
        let kept: f64 = forest.edge_weight.iter().sum();
        assert!(forest.candidates > forest.edge_count());
        assert_eq!(forest.component_count(), 1.0);
        assert!((forest.component_weight[0] - kept).abs() < 1e-12);
    }

    /* LE CONTRAT « MASSES TRIÉES », rendu visible par un test.

       Le noyau ne trie pas: payer un tri à chaque appel serait exactement le
       poste qu'il existe pour supprimer. C'est donc un contrat de l'appelant,
       et ce test montre ce qu'il produit quand il est respecté. */
    #[test]
    fn the_sorted_input_contract_is_what_makes_the_break_safe() {
        let sorted = [100.0, 114.0, 128.0, 142.0];
        let forest = forest_grow(&sorted, &[1.0; 4], &[14.0], 0.5, 0.0);
        assert_eq!(forest.edge_count(), 3.0);
        assert_eq!(forest.component_count(), 1.0);
        assert_eq!(forest.component_size[0], 4.0);
    }
}