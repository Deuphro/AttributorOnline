//! Attribution — le crible des masses combinables.
//!
//! Ce que fait ce kernel: étant donné un jeu de BRIQUES (les masses isotopiques
//! des groupes à combiner, plus les adduits ionisants) et un plafond de masse, il
//! énumère TOUTES les combinaisons dont la masse totale ne dépasse pas le
//! plafond, par masse CROISSANTE, sans doublon.
//!
//! L'ORACLE est le code Igor de la thèse — `trouvemass` et `crible1..10` dans
//! resources/ProcAttributorLegacy/MainProc.ipf. On garde son idée (un crible
//! exhaustif) et on supprime le comblement par la masse la plus faible, que
//! `trouvemass` faisait pour ne pas explorer les masses nobles proches: ici la
//! fenêtre doit être couverte ENTIÈREMENT.
//!
//! POURQUOI RUST, ET OÙ EST LE GOULOT.
//! L'algorithme est un tas minimal sur les masses. Ce qui coûte n'est pas le
//! tas: c'est le `seen` qui empêche les doublons. En JS il faut une chaîne par
//! état, donc une allocation par combinaison, et k atteint le million dès que le
//! plafond est celui d'un spectre entier. Ici c'est une table de hachage de u64:
//! huit octets par état, zéro allocation par entrée.
//!
//! C'est le seul endroit du projet où la justification du Rust n'est pas « c'est
//! rapide » mais « c'est faisable »: la version JS rend les mêmes résultats et ne
//! passe pas à l'échelle. Les deux kernels sont donc comparables, et c'est ce qui
//! permet d'affirmer que passer au Rust n'a rien changé à la physique.

use std::collections::{BinaryHeap, HashMap};
use wasm_bindgen::prelude::*;

/// Le nombre de valeurs par état dans la sortie plate.
///
/// Quatre: masse, charge, signature du vecteur, index du parent. La constante
/// est nommée et exportée parce que JS doit découper sur le MÊME nombre — deux
/// découpages qui divergent donneraient une sortie silencieusement fausse, qui
/// est le pire genre de bug possible ici.
pub const STRIDE: usize = 4;

/// Le tas minimum sur les masses.
///
/// `BinaryHeap` est un MAX-heap en Rust, donc on inverse la comparaison: `Ord`
/// renvoie `Greater` quand `self.mass` est PLUS PETIT, ce qui fait remonter le
/// plus léger au sommet. C'est le seul endroit où l'inversion est écrite, et
/// c'est le genre de détail qui se vérifie par un test plutôt qu'à la relecture.
#[derive(Debug)]
struct Candidate {
    mass: f64,
    counts: Vec<u32>,
    signature: u64,
    parent: u64,
}

impl PartialEq for Candidate {
    fn eq(&self, other: &Self) -> bool {
        self.mass == other.mass
    }
}
impl Eq for Candidate {}

impl Ord for Candidate {
    fn cmp(&self, other: &Self) -> std::cmp::Ordering {
        //inverse: la plus petite masse en premier
        other
            .mass
            .partial_cmp(&self.mass)
            .unwrap_or(std::cmp::Ordering::Equal)
    }
}
impl PartialOrd for Candidate {
    fn partial_cmp(&self, other: &Self) -> Option<std::cmp::Ordering> {
        Some(self.cmp(other))
    }
}

/// L'empreinte d'un vecteur de multiplicités, en un u64.
///
/// ELLE DÉPEND DE L'ORDRE, et c'est délibéré: elle identifie le VECTEUR
/// d'indices, pas le multiensemble. Deux vecteurs qui ne diffèrent que par une
/// permutation sont deux états distincts pour le `seen` — donc cette fonction ne
/// fusionne PAS deux écritures du même ensemble, elle ne fait que les comparer.
///
/// C'est ce qu'il faut, parce que le `seen` du crible NE DOIT PAS fusionner les
/// écritures: il doit seulement empêcher qu'un même état soit poussé deux fois.
/// Le dédoublonnage réel est fait par le `seen` sur l'état lui-même, et il n'a
/// rien à voir avec la question « ces deux écritures sont-elles le même
/// ensemble? », à laquelle la réponse est NON tant qu'on n'a pas réordonné.
///
/// Une empreinte qui serait commutative serait ici un BUG: deux vecteurs
/// différents se veraient refuser mutuellement l'entrée dans le tas, et le
/// crible perdrait des combinaisons sans qu'aucun test de masse ni d'ordre ne
/// s'en aperçoive.
///
/// Le mélange est un Fibonacci 64 bits: une permutation des indices change le
/// résultat, ce qui est ici le comportement voulu.
fn fingerprint(counts: &[u32]) -> u64 {
    const K: u64 = 0x9E3779B97F4A7C15;
    let mut h: u64 = 0xcbf29ce484222325;
    for (index, &count) in counts.iter().enumerate() {
        if count == 0 {
            continue;
        }
        h ^= (index as u64).wrapping_mul(K);
        h = h.wrapping_mul(K);
        h ^= (count as u64).wrapping_mul(K);
        h = h.wrapping_mul(K);
    }
    h
}

/// Les bornes de multiplicité ne sont PAS calculées ici.
///
/// Elles viennent de `AttributionPlan.capsFor`, en JS, et c'est la seule façon
/// d'avoir raison: la borne d'un ADDUCT dépend de la FENÊTRE D'IONISATION, que
/// seul le plan connaît. Une brique est bornée par `maxMass // mass`; un adduit
/// est borné par la charge maximale autorisée, parce qu'un [2+] en fenêtre ±10
/// donnerait sinon un volume absurde.
///
/// Le calcul ici serait un second endroit où décider, donc un second endroit où
/// se tromper — et l'erreur serait invisible: le crible rendrait des
/// combinaisons, dans le mauvais ordre peut-être, sans qu'aucun test le voie.
///
/// `caps_for` a longtemps existé ici et faisait ce calcul. Elle a été retirée
/// après qu'un test eut Tourné en boucle indéfiniment: un adduit SANS ATOME a
/// une masse négative, donc `maxMass / mass` est négatif, donc `max(0)` donne
/// 0… et un `[2+]` en fenêtre ±3 rendait zéro combinaison, alors qu'il est
/// l'adduit le plus utile d'un plan. La borne par la charge ne se devine pas
/// depuis les masses, et c'est exactement pour ça qu'elle vit dans le plan.

/// Le crible exhaustif, par tas.
///
/// * `item_masses` la masse de chaque brique: somme des atomes pour une brique
///   de masse, masse de l'ION pour un adduit
/// * `item_charges` la charge de chaque brique; 0 pour une brique de masse
/// * `caps` la multiplicité maximale de chaque brique, calculée par le plan
/// * `max_mass` le plafond de masse totale
/// * `limit` le nombre maximal d'états rendus
///
/// La sortie est un `Vec<f64>` PLAT de `STRIDE` valeurs par état, dans l'ordre
/// du tas — donc par masse croissante. Un seul `Vec` et non un struct à getters:
/// c'est le format que le projet utilise partout (`fkmd`,
/// `persistent_homology_0d`), il n'alloue rien côté JS, et il évite le `Copy`
/// que `#[wasm_bindgen(getter)]` exige sur un champ `Vec` dans la version de
/// wasm-bindgen d'ici.
///
/// La charge totale d'un état est la SOMME des charges des briques employées, et
/// c'est elle que la fenêtre d'ionisation filtrera côté JS. Le kernel ne connaît
/// pas la fenêtre: il rend ce qui existe, et le shell décide ce qui compte — la
/// même séparation que partout ailleurs dans le projet.
///
/// Le plafond borne à la fois le nombre de COPIES d'une brique et la somme. La
/// masse ne peut qu'augmenter en ajoutant une brique, donc un état trop lourd ne
/// peut jamais s'alléger en remontant, et l'élagage est sûr.
#[wasm_bindgen]
pub fn crible_heap(
    item_masses: &[f64],
    item_charges: &[f64],
    caps: &[u32],
    max_mass: f64,
    limit: usize,
) -> Vec<f64> {
    let count = item_masses.len();
    /* Une brique sans charge, ou sans borne, n'a pas de sens: les trois
    vecteurs sont des descripteurs de la MÊME liste de briques, et une
    longueur différente est un appel erroné, pas un cas limite. On refuse
    plutôt que d'indexer hors bornes. */
    if count == 0 || item_charges.len() != count || caps.len() != count {
        return Vec::new();
    }
    if !max_mass.is_finite() || max_mass <= 0.0 {
        return Vec::new();
    }
    /* UNE BORNE INFINIE SUR UNE MASSE NON POSITIVE REFUSE ICI, et c'est le
    garde-fou qui manque quand le kernel calculait ses bornes lui-même.

    Un adduit sans atome — un [2+], qui ne perd que deux électrons — a une
    masse NÉGATIVE. Sa masse ne croît donc jamais en le répétant, donc le
    plafond de masse ne l'arrête jamais, donc une borne infinie le ferait
    boucler indéfiniment. Le plan ne produit jamais une telle borne, mais un
    shell qui appelle le kernel directement, si. Refuser est la seule
    réponse qui ne laisse pas un onglet figé: rendre le germe seul serait
    déjà une réponse, et le germe existe. */
    for i in 0..count {
        if caps[i] == u32::MAX && item_masses[i] <= 0.0 {
            return Vec::new();
        }
    }
    //aucune brique ne peut entrer: le plafond les exclut toutes
    if caps.iter().all(|&cap| cap == 0) {
        return Vec::new();
    }

    let mut seen: HashMap<u64, ()> = HashMap::new();
    let mut open: BinaryHeap<Candidate> = BinaryHeap::new();
    let mut out: Vec<f64> = Vec::new();

    let seed_sig = fingerprint(&vec![0u32; count]);
    seen.insert(seed_sig, ());
    open.push(Candidate {
        mass: 0.0,
        counts: vec![0u32; count],
        signature: seed_sig,
        parent: u64::MAX,
    });
    let mut next_id: u64 = 0;

    while let Some(candidate) = open.pop() {
        let index = next_id;
        next_id += 1;
        let charge: f64 = item_charges
            .iter()
            .zip(candidate.counts.iter())
            .map(|(&c, &n)| c * n as f64)
            .sum();
        out.push(candidate.mass);
        out.push(charge);
        //le parent est rendu en f64 via une sentinelle: u64::MAX ne tient pas
        //dans un f64 entier, donc la sentinelle passe par -1
        out.push(candidate.signature as f64);
        out.push(if candidate.parent == u64::MAX {
            -1.0
        } else {
            candidate.parent as f64
        });

        if out.len() / STRIDE >= limit {
            break;
        }

        for i in 0..count {
            if candidate.counts[i] >= caps[i] {
                continue;
            }
            let mass = candidate.mass + item_masses[i];
            if mass > max_mass {
                continue;
            }
            let mut child = candidate.counts.clone();
            child[i] += 1;
            let sig = fingerprint(&child);
            /* Le `seen` est ce qui garantit l'unicité. Il se remplit AU MOMENT
            DE POUSSER: ajouter une empreinte ici n'interdit pas de pousser cet
            état — cela interdit d'en pousser un deuxième exemplaire, ce qui
            est exactement le doublon qu'on cherche. */
            if seen.contains_key(&sig) {
                continue;
            }
            seen.insert(sig, ());
            open.push(Candidate {
                mass,
                counts: child,
                signature: sig,
                parent: index,
            });
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Les bornes que le plan donnerait, pour un test à masses données.
    ///
    /// Ce helper reproduit la règle de `AttributionPlan.capsFor` — la brique de
    /// masse est bornée par le plafond, l'adduit par la charge — pour que les
    /// tests Rust exercent le MÊME contrat que le shell. Il est volontairement
    /// écrit à la main plutôt qu'appelé: c'est un second chemin, et c'est
    /// justement le fait d'en avoir deux qui permet de dire qu'ils s'accordent.
    fn caps(masses: &[f64], charges: &[f64], max_mass: f64, charge_max: f64) -> Vec<u32> {
        masses
            .iter()
            .zip(charges.iter())
            .map(|(&mass, &charge)| {
                let by_mass = if mass > 0.0 {
                    (max_mass / mass).floor().max(0.0) as u32
                } else {
                    u32::MAX
                };
                let by_charge = if charge != 0.0 {
                    (charge_max / charge.abs()).floor() as u32
                } else {
                    u32::MAX
                };
                by_mass.min(by_charge)
            })
            .collect()
    }

    /// Les masses du résultat, lues dans la sortie plate.
    fn masses_of(flat: &[f64]) -> Vec<f64> {
        flat.iter().step_by(STRIDE).copied().collect()
    }
    fn charges_of(flat: &[f64]) -> Vec<f64> {
        flat.iter().skip(1).step_by(STRIDE).copied().collect()
    }
    fn signatures_of(flat: &[f64]) -> Vec<f64> {
        flat.iter().skip(2).step_by(STRIDE).copied().collect()
    }

    /// Le nombre d'états sous un plafond, par force brute, avec les MÊMES bornes.
    /// C'est l'oracle, et il est volontairement naïf: son seul travail est de ne
    /// pas manquer une combinaison.
    fn brute_force(masses: &[f64], charges: &[f64], caps: &[u32], max_mass: f64) -> usize {
        let mut counts = vec![0u32; masses.len()];
        fn walk(
            i: usize,
            mass: f64,
            caps: &[u32],
            masses: &[f64],
            max_mass: f64,
            counts: &mut Vec<u32>,
        ) -> usize {
            if i == masses.len() {
                return if mass <= max_mass { 1 } else { 0 };
            }
            let mut n = 0;
            for k in 0..=caps[i] {
                counts[i] = k;
                n += walk(
                    i + 1,
                    mass + k as f64 * masses[i],
                    caps,
                    masses,
                    max_mass,
                    counts,
                );
            }
            counts[i] = 0;
            n
        }
        walk(0, 0.0, caps, masses, max_mass, &mut counts)
    }

    #[test]
    fn le_crible_trouve_ce_que_la_force_brute_trouve() {
        let m = vec![14.0, 16.0, 1.0];
        let c = vec![0.0, 0.0, 1.0];
        let bounds = caps(&m, &c, 300.0, 1.0);
        let flat = crible_heap(&m, &c, &bounds, 300.0, usize::MAX);
        let expected = brute_force(&m, &c, &bounds, 300.0);
        assert!(expected > 0, "the oracle must produce something to compare");
        assert_eq!(masses_of(&flat).len(), expected);
    }

    #[test]
    fn le_plafond_borne_le_compte_de_copies() {
        //10.0 * 31 = 310 > 300, donc 30 copies au plus
        assert_eq!(caps(&[10.0], &[0.0], 300.0, 1.0)[0], 30);
        let bounds = vec![30u32];
        let flat = crible_heap(&[10.0], &[0.0], &bounds, 300.0, usize::MAX);
        for mass in masses_of(&flat) {
            assert!(mass <= 300.0, "{} exceeds the ceiling", mass);
        }
    }

    #[test]
    fn les_masses_sortent_par_ordre_croissant() {
        let m = vec![14.0, 16.0, 1.0];
        let c = vec![0.0, 0.0, 1.0];
        let bounds = caps(&m, &c, 300.0, 1.0);
        let masses = masses_of(&crible_heap(&m, &c, &bounds, 300.0, usize::MAX));
        for i in 1..masses.len() {
            assert!(
                masses[i - 1] <= masses[i],
                "rank {} is lighter than rank {}",
                i,
                i - 1
            );
        }
    }

    #[test]
    fn aucune_combinaison_nest_rendue_deux_fois() {
        let m = vec![14.0, 16.0, 1.0];
        let c = vec![0.0, 0.0, 1.0];
        let bounds = caps(&m, &c, 200.0, 1.0);
        let mut sigs = signatures_of(&crible_heap(&m, &c, &bounds, 200.0, usize::MAX));
        let before = sigs.len();
        sigs.sort_by(|a, b| a.partial_cmp(b).unwrap());
        sigs.dedup();
        assert_eq!(before, sigs.len(), "a fingerprint was rendered twice");
    }

    #[test]
    fn le_germe_est_le_premier_a_masse_nulle() {
        let flat = crible_heap(&[14.0], &[0.0], &[7], 100.0, usize::MAX);
        assert_eq!(masses_of(&flat)[0], 0.0);
    }

    #[test]
    fn la_charge_totale_est_la_somme_des_adduits_employes() {
        //un [2+] et rien d'autre: le germe porte 0, l'adduit porte 2
        let flat = crible_heap(&[-0.001097], &[2.0], &[1], 10.0, usize::MAX);
        let charges = charges_of(&flat);
        assert!(charges.contains(&2.0), "the adduct charge must show up");
        assert!(charges.contains(&0.0), "the germe carries no charge");
    }

    #[test]
    fn une_borne_infinie_sur_un_adduit_sans_atome_est_refusee() {
        //C'EST LE BUG QUE CE TEST GARDE: un [2+] a une masse négative, donc la
        //répéter ne fait jamais croître la masse, donc le plafond de masse ne
        //l'arrête jamais. Avec une borne infinie, la marche ne finit pas. Le
        //kernel refuse donc, plutôt que de laisser l'onglet figé.
        let flat = crible_heap(&[-0.001097], &[2.0], &[u32::MAX], 10.0, usize::MAX);
        assert!(
            flat.is_empty(),
            "an unbounded massless adduct must be refused"
        );
    }

    #[test]
    fn le_plafond_tronque_au_lieu_de_renaître() {
        let m = vec![14.0, 16.0];
        let c = vec![0.0, 0.0];
        let bounds = caps(&m, &c, 500.0, 1.0);
        let flat = crible_heap(&m, &c, &bounds, 500.0, 5);
        assert_eq!(flat.len() / STRIDE, 5, "the limit was not honoured");
    }

    #[test]
    fn une_brique_trop_lourde_pour_le_plafond_nentre_pas() {
        //une brique de 500 sous un plafond de 100: sa borne est 0, donc le
        //crible rend RIEN — pas même le germe, qui n'est pas une combinaison
        let flat = crible_heap(&[500.0], &[0.0], &[0], 100.0, usize::MAX);
        assert!(
            flat.is_empty(),
            "no brick, no combination, not even the germe"
        );
    }

    #[test]
    fn le_fingerprint_identifie_le_vecteur_pas_le_multiensemble() {
        //[1,0,2] et [2,0,1] sont le MEME ensemble de briques, mais deux etats
        //differents du crible: le seen ne les confond pas, et c est ce qu il
        //faut, car une empreinte commutative ferait perdre des combinaisons
        assert_ne!(fingerprint(&[1, 0, 2]), fingerprint(&[2, 0, 1]));
        //le meme vecteur donne evidemment la meme empreinte
        assert_eq!(fingerprint(&[1, 0, 2]), fingerprint(&[1, 0, 2]));
        //et un compte different au meme endroit donne autre chose
        assert_ne!(fingerprint(&[1, 0, 0]), fingerprint(&[0, 0, 1]));
    }

    #[test]
    fn un_plafond_invalide_rend_rien() {
        for bad in [0.0, -1.0, f64::NAN, f64::INFINITY] {
            assert!(
                crible_heap(&[14.0], &[0.0], &[7], bad, usize::MAX).is_empty(),
                "a ceiling that is not a positive number must be refused"
            );
        }
    }

    #[test]
    fn des_descripteurs_de_longueurs_differentes_sont_refuses() {
        //deux masses, une charge: on ne peut pas indexer la seconde
        assert!(crible_heap(&[14.0, 16.0], &[1.0], &[7, 7], 300.0, usize::MAX).is_empty());
        //deux masses, deux charges, une seule borne
        assert!(crible_heap(&[14.0, 16.0], &[0.0, 0.0], &[7], 300.0, usize::MAX).is_empty());
    }

    #[test]
    fn la_sortie_est_toujours_un_multiple_du_pas() {
        //le pas est ce que JS découpe: une sortie qui n en est pas multiple
        //serait lue de travers, silencieusement
        for limit in [1usize, 7, 100] {
            let m = vec![14.0, 16.0, 1.0];
            let c = vec![0.0, 0.0, 1.0];
            let bounds = caps(&m, &c, 200.0, 1.0);
            let flat = crible_heap(&m, &c, &bounds, 200.0, limit);
            assert_eq!(flat.len() % STRIDE, 0, "a partial state came out");
        }
    }

    #[test]
    fn un_adduit_sans_atome_est_borne_par_la_charge_et_non_par_la_masse() {
        //le cas qui a fait boucler le kernel: une masse négative ne se borne
        //pas par le plafond, donc seule la borne par la charge peut arrêter
        //la marche — et elle vient du plan
        let m = vec![-0.001097];
        let c = vec![2.0];
        let bounds = caps(&m, &c, 10.0, 6.0);
        assert_eq!(bounds[0], 3, "a [2+] in a +6 window is three copies");
        let flat = crible_heap(&m, &c, &bounds, 10.0, usize::MAX);
        assert_eq!(masses_of(&flat).len(), 4, "the germe and three adducts");
    }
}
