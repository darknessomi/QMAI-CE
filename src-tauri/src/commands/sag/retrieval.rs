// Adapted from SAG-Wiki b6940ac834b3b1ec651c0b49dc1b0c45d4d74c4a (MIT, see LICENSE).
#[derive(Clone, Debug)]
pub(super) struct Term {
    pub term: String,
    pub kind: String,
    pub score: f64,
}
use super::{
    store::Store,
    text::{match_query, quote, tokenize},
    Candidate,
};
use anyhow::{bail, Result};
use fancy_regex::Regex;
use icu_collator::{Collator, CollatorOptions};
use icu_locid::locale;
use indexmap::IndexMap;
use std::{
    collections::{HashMap, HashSet},
    future::Future,
    sync::LazyLock,
};
use tokio_util::sync::CancellationToken;

static NAMES: LazyLock<Regex> = LazyLock::new(|| {
    let word = r"(?:\p{Lu}\.|\p{Lu}[\p{L}\p{M}]*(?:[-’']\p{Lu}[\p{L}\p{M}]*)*)";
    Regex::new(&format!(
        r"(?<![\p{{L}}\p{{N}}]){word}(?:[ \t]+{word})+(?![\p{{L}}\p{{N}}])"
    ))
    .unwrap()
});
static SENTENCES: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?<!\b[A-Z])[.!?]\s+|[。！？]+\s*|\n+").unwrap());

pub fn name_phrases(s: &str) -> Result<Vec<(usize, usize, String)>> {
    NAMES
        .find_iter(s)
        .map(|r| {
            let m = r?;
            Ok((m.start(), m.end(), tokenize(m.as_str()).join(" ")))
        })
        .collect()
}
fn sentences(text: &str) -> Result<Vec<&str>> {
    let mut out = vec![];
    let mut end = 0;
    for m in SENTENCES.find_iter(text) {
        let m = m?;
        out.push(&text[end..m.start()]);
        end = m.end()
    }
    out.push(&text[end..]);
    Ok(out)
}
pub fn expansion_terms(
    store: &Store,
    query: &str,
    seeds: &[Candidate],
    limit: usize,
) -> Result<Vec<Term>> {
    let query_words = tokenize(query);
    let query_set: HashSet<_> = query_words.iter().cloned().collect();
    let max_score = seeds.iter().map(|s| s.score).fold(0., f64::max);
    let mut passages = vec![];
    let mut vocabulary: HashSet<String> = query_set.clone();
    for seed in seeds {
        let mut parts = vec![];
        for sentence in sentences(&seed.content)? {
            let names = name_phrases(sentence)?;
            let mut ungrouped = String::new();
            let mut end = 0;
            for (start, stop, _) in &names {
                ungrouped.push_str(&sentence[end..*start]);
                ungrouped.push(' ');
                end = *stop;
            }
            ungrouped.push_str(&sentence[end..]);
            let mut words = tokenize(&ungrouped);
            words.extend(names.iter().map(|(_, _, term)| term.clone()));
            vocabulary.extend(words.iter().cloned());
            parts.push((sentence.to_owned(), words, names));
        }
        passages.push((seed, parts));
    }
    let total = store.chunk_count()? as f64;
    let vocabulary: Vec<_> = vocabulary.into_iter().collect();
    let frequencies: HashMap<_, _> = store
        .frequencies(&vocabulary)?
        .into_iter()
        .map(|(term, count)| (term, count as f64))
        .collect();
    let idf = |term: &str| {
        let df = frequencies[term];
        (1. + (total - df + 0.5) / (df + 0.5)).ln()
    };
    let mut ranked: HashMap<String, Term> = HashMap::new();
    for (seed, parts) in passages {
        let weight = 0.5
            + 0.5
                * if max_score > 0. {
                    seed.score / max_score
                } else {
                    0.
                };
        let mut counts: IndexMap<String, usize> = IndexMap::new();
        let mut contexts: HashMap<String, f64> = HashMap::new();
        let mut name_terms = HashSet::new();
        for (sentence, words, names) in &parts {
            let mut unique = HashSet::new();
            let mut context = 0.;
            for word in tokenize(sentence) {
                if unique.insert(word.clone()) && query_set.contains(&word) {
                    context += idf(&word)
                }
            }
            for word in words {
                *counts.entry(word.clone()).or_default() += 1;
                let old = contexts.entry(word.clone()).or_default();
                *old = old.max(context);
            }
            name_terms.extend(names.iter().map(|(_, _, term)| term.clone()));
        }
        for (term, tf) in counts {
            if tokenize(&term).iter().all(|w| query_set.contains(w)) || frequencies[&term] == 0. {
                continue;
            }
            let score = (1. + (tf as f64).ln()) * idf(&term) * (1. + contexts[&term]) * weight;
            if !ranked.contains_key(&term) || score > ranked[&term].score {
                ranked.insert(
                    term.clone(),
                    Term {
                        kind: if name_terms.contains(&term) {
                            "name_phrase"
                        } else {
                            "word"
                        }
                        .into(),
                        term,
                        score,
                    },
                );
            }
        }
    }
    let collator = Collator::try_new(&locale!("en").into(), CollatorOptions::new())
        .map_err(|e| anyhow::anyhow!("词项排序初始化失败：{e:?}"))?;
    let mut terms: Vec<Term> = ranked.into_values().collect();
    terms.sort_by(|a, b| {
        b.score
            .total_cmp(&a.score)
            .then_with(|| collator.compare(&a.term, &b.term))
    });
    terms.truncate(limit);
    Ok(terms)
}
pub fn interleave(lists: Vec<Vec<Candidate>>, limit: usize) -> Vec<Candidate> {
    let mut seen = HashSet::new();
    let mut result = vec![];
    for rank in 0..limit {
        for list in &lists {
            if let Some(c) = list.get(rank) {
                if seen.insert(c.id) {
                    let mut c = c.clone();
                    c.order = result.len();
                    result.push(c);
                    if result.len() == limit {
                        return result;
                    }
                }
            }
        }
    }
    result
}
fn rank(mut candidates: Vec<Candidate>) -> Vec<Candidate> {
    candidates.sort_by(|a, b| {
        b.score
            .total_cmp(&a.score)
            .then(a.order.cmp(&b.order))
            .then(a.id.cmp(&b.id))
    });
    candidates
}

#[derive(Clone, Copy, serde::Deserialize)]
pub(super) struct Options {
    pub candidate_k: usize,
    pub seed_k: usize,
    pub expansion_term_limit: usize,
    pub max_hops: usize,
}
impl Default for Options {
    fn default() -> Self {
        Self {
            candidate_k: 50,
            seed_k: 10,
            expansion_term_limit: 20,
            max_hops: 2,
        }
    }
}

pub(super) async fn retrieve<F, Fut>(
    store: &Store,
    query: &str,
    top_k: usize,
    options: Options,
    cancel: &CancellationToken,
    mut score: F,
    mut on_round: impl FnMut(usize, &[Candidate], &[Term]),
) -> Result<Vec<Candidate>>
where
    F: FnMut(Vec<Candidate>, Vec<Candidate>) -> Fut,
    Fut: Future<Output = Result<Vec<Candidate>>>,
{
    if options.max_hops > 2 {
        bail!("SAG2 V10 最多扩展两轮")
    }
    if cancel.is_cancelled() {
        bail!("已停止")
    }
    let corpus = &store.corpus;
    let repaired = corpus.repair(query, |term| store.has_match(&quote(term), &[]))?;
    let expression = match_query(&repaired);
    if expression.is_empty() {
        return Ok(vec![]);
    };
    let mut retained: Vec<Candidate> = vec![];
    let mut frontier = vec![];
    let mut expanded = HashSet::new();
    let mut seen = HashSet::new();
    let mut carried = IndexMap::new();
    let mut protected = IndexMap::new();
    let mut latest = IndexMap::<i64, Candidate>::new();
    for hop in 0..=options.max_hops {
        if cancel.is_cancelled() {
            bail!("已停止")
        };

        if hop > 0 && frontier.is_empty() {
            break;
        }
        let mut terms = if hop > 0 {
            expansion_terms(store, query, &frontier, options.expansion_term_limit)?
        } else {
            vec![]
        };
        if hop > 0 && terms.is_empty() {
            break;
        };
        let excluded: Vec<i64> = seen.iter().copied().collect();
        corpus.resolve_terms_in_scope(store, &mut terms, &excluded)?;
        let candidates = if hop == 0 {
            let hits = store.writing_candidates(
                query,
                &expression,
                None,
                &excluded,
                options.candidate_k,
            )?;
            for c in hits.iter().take(5) {
                protected.insert(c.id, c.clone());
            }
            hits
        } else {
            let ranking = format!(
                "{} OR ({expression})",
                terms
                    .iter()
                    .map(|t| quote(&t.term))
                    .collect::<Vec<_>>()
                    .join(" OR ")
            );
            let lists = terms
                .iter()
                .map(|term| {
                    store.writing_candidates(
                        &term.term,
                        &ranking,
                        Some(&quote(&term.term)),
                        &excluded,
                        options.candidate_k,
                    )
                })
                .collect::<Result<_>>()?;
            interleave(lists, options.candidate_k)
        };
        if candidates.is_empty() {
            break;
        };
        on_round(hop, &candidates, &terms);
        for c in &frontier {
            carried.insert(c.id, c.clone());
        }
        let mut pool = IndexMap::new();
        if hop > 0 {
            pool.extend(protected.iter().map(|(id, c)| (*id, c.clone())));
            pool.extend(carried.iter().map(|(id, c)| (*id, c.clone())));
        }
        pool.extend(candidates.iter().map(|c| (c.id, c.clone())));
        let mut evidence = if hop > 0 {
            let mut e = carried.clone();
            e.extend(
                candidates
                    .iter()
                    .take(options.seed_k)
                    .map(|c| (c.id, c.clone())),
            );
            e.into_values().collect()
        } else {
            vec![]
        };
        if hop == 2 {
            let count = pool.len();
            let mut history: IndexMap<i64, Candidate> = pool
                .iter()
                .filter(|(id, _)| latest.contains_key(*id))
                .map(|(id, c)| (*id, c.clone()))
                .collect();
            let incoming: Vec<_> = pool
                .values()
                .filter(|c| !latest.contains_key(&c.id))
                .take(20)
                .cloned()
                .collect();
            let mut previous: Vec<_> = latest.values().cloned().collect();
            previous.sort_by(|a, b| b.score.total_cmp(&a.score).then(a.id.cmp(&b.id)));
            history.extend(previous.into_iter().map(|c| (c.id, c)));
            pool = history
                .into_iter()
                .take(count - incoming.len())
                .chain(incoming.into_iter().map(|c| (c.id, c)))
                .collect();
            evidence = retained
                .iter()
                .take(10)
                .cloned()
                .map(|mut c| {
                    c.previous_score = Some(c.score);
                    c
                })
                .collect();
        }
        retained = rank(score(pool.into_values().collect(), evidence).await?);
        latest.extend(retained.iter().map(|c| (c.id, c.clone())));
        if cancel.is_cancelled() {
            bail!("已停止")
        };

        seen.extend(retained.iter().map(|c| c.id));
        frontier = retained
            .iter()
            .filter(|c| !expanded.contains(&c.id))
            .take(options.seed_k)
            .cloned()
            .collect();
        expanded.extend(frontier.iter().map(|c| c.id));
    }
    retained.truncate(top_k.min(options.candidate_k));
    Ok(retained)
}
