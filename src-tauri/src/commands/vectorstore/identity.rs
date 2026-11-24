//! A path migration only edits IDs. The embeddings and their model input stay intact.
mod proof;
use super::*;
use crate::commands::fs::{do_list_directory, do_write_file_atomic};
use crate::types::wiki::FileNode;
use futures::TryStreamExt;
use lancedb::query::Select;
use std::collections::{BTreeMap, HashSet};
use std::path::Path;

struct Owner {
    id: String,
    path: String,
}

type Renames = BTreeMap<String, String>;

#[derive(Serialize, Deserialize)]
#[serde(tag = "state")]
enum Migration {
    Pending { v1: Renames, v2: Renames },
    Complete,
}

fn collect_paths(nodes: Vec<FileNode>, parent: &str, owners: &mut BTreeMap<String, Vec<Owner>>) {
    for node in nodes {
        let path = format!("{parent}/{}", node.name);
        if let Some(children) = node.children {
            collect_paths(children, &path, owners);
        } else if !node.is_dir {
            if let Some(stem) = node.name.strip_suffix(".md") {
                if stem.is_empty() {
                    continue;
                }
                let id = path
                    .strip_suffix(".md")
                    .unwrap()
                    .replace('%', "%25")
                    .replace('\'', "%27");
                owners.entry(stem.to_owned()).or_default().push(Owner {
                    id,
                    path: node.path,
                });
            }
        }
    }
}

async fn page_ids(table: &lancedb::Table) -> Result<HashSet<String>, String> {
    read_ids(table.query()).await
}

async fn read_ids(query: lancedb::query::Query) -> Result<HashSet<String>, String> {
    let mut ids = HashSet::new();
    let mut batches = query
        .select(Select::columns(&["page_id"]))
        .execute()
        .await
        .map_err(|e| e.to_string())?;
    while let Some(batch) = batches.try_next().await.map_err(|e| e.to_string())? {
        let column = batch
            .column(0)
            .as_any()
            .downcast_ref::<StringArray>()
            .ok_or("页标识列格式错误")?;
        ids.extend(column.iter().flatten().map(str::to_owned));
    }
    Ok(ids)
}

pub(super) fn has_marker(project: &str) -> bool {
    Path::new(&db_path(project))
        .join("page-ids-v1.json")
        .is_file()
}

pub(super) async fn indexed_v2_pages(
    project: &str,
    candidates: &[VectorSearchResult],
) -> Result<HashSet<String>, String> {
    if candidates.is_empty() || !table_dir(project, TABLE_V2).is_dir() {
        return Ok(HashSet::new());
    }
    let keys: Vec<_> = candidates
        .iter()
        .filter(|p| p.page_id.starts_with("wiki/") && validate_page_id(&p.page_id).is_ok())
        .map(|p| format!("'{}'", p.page_id))
        .collect();
    if keys.is_empty() {
        return Ok(HashSet::new());
    }
    let table = open_project_db(project)
        .await?
        .open_table(TABLE_V2)
        .execute()
        .await
        .map_err(|e| e.to_string())?;
    read_ids(
        table
            .query()
            .only_if(format!("page_id IN ({})", keys.join(","))),
    )
    .await
}

async fn plan_table(
    db: &Connection,
    table_name: &str,
    owners: &BTreeMap<String, Vec<Owner>>,
) -> Result<Renames, String> {
    let table = db
        .open_table(table_name)
        .execute()
        .await
        .map_err(|e| e.to_string())?;
    let ids = page_ids(&table).await?;
    let mut moves = Renames::new();
    for old in &ids {
        if old.contains('/') || old.starts_with("community:") || validate_page_id(old).is_err() {
            continue;
        }
        let Some(candidates) = owners.get(old) else {
            continue;
        };
        let owner = match candidates.as_slice() {
            [only] => Some(only),
            many if table_name == TABLE_V2 => proof::unique_owner(&table, old, many).await?,
            _ => None,
        };
        if let Some(owner) = owner {
            if !ids.contains(&owner.id) && validate_page_id(&owner.id).is_ok() {
                moves.insert(old.clone(), owner.id.clone());
            }
        }
    }
    Ok(moves)
}

// Each batch is one Lance transaction. The persisted intent makes replay safe
// even after one table was committed but its manifest was not updated yet.
async fn apply_table(db: &Connection, name: &str, moves: &Renames) -> Result<(), String> {
    if moves.is_empty() {
        return Ok(());
    }
    let table = db
        .open_table(name)
        .execute()
        .await
        .map_err(|e| e.to_string())?;
    // Most pages share a directory. Lance supports scalar functions in update
    // expressions but not SQL CASE, so group pages by their common new prefix.
    let mut groups: BTreeMap<(String, bool), Vec<&str>> = BTreeMap::new();
    for (old, new) in moves {
        validate_page_id(old)?;
        validate_page_id(new)?;
        let group = match new.strip_suffix(old) {
            Some(prefix) if !old.contains('%') => (prefix.to_owned(), true),
            _ => (new.clone(), false),
        };
        groups.entry(group).or_default().push(old);
    }
    for ((prefix, prepend), ids) in groups {
        for batch in ids.chunks(100) {
            let keys: Vec<_> = batch.iter().map(|id| format!("'{id}'")).collect();
            let id_expr = if prepend {
                format!("concat('{prefix}', page_id)")
            } else {
                format!("'{prefix}'")
            };
            let mut update = table
                .update()
                .only_if(format!("page_id IN ({})", keys.join(",")))
                .column("page_id", id_expr);
            if name == TABLE_V2 {
                let chunk_expr = if prepend {
                    format!("concat('{prefix}', chunk_id)")
                } else {
                    format!("concat('{prefix}#', cast(chunk_index as varchar))")
                };
                update = update.column("chunk_id", chunk_expr);
            }
            update
                .execute()
                .await
                .map_err(|e| format!("更新向量页面标识失败：{e}"))?;
        }
    }
    Ok(())
}

fn persist(path: &Path, state: &Migration) -> Result<(), String> {
    let text = serde_json::to_string(state).map_err(|e| e.to_string())?;
    do_write_file_atomic(&path.to_string_lossy(), &text)
}

fn migrate_manifest(project: &str, moves: &Renames) -> Result<(), String> {
    let path = Path::new(project).join(".qmai/embedding-index.json");
    let Some(text) = read_optional(&path)? else {
        return Ok(());
    };
    let Ok(mut manifest) = serde_json::from_str::<serde_json::Value>(&text) else {
        return Ok(());
    };
    let Some(pages) = manifest.get_mut("pages").and_then(|v| v.as_object_mut()) else {
        return Ok(());
    };
    let mut changed = false;
    for (old, new) in moves {
        if let Some(hash) = pages.remove(old) {
            pages.entry(new).or_insert(hash);
            changed = true;
        }
    }
    if changed {
        do_write_file_atomic(&path.to_string_lossy(), &manifest.to_string())?;
    }
    Ok(())
}

fn read_optional(path: &Path) -> Result<Option<String>, String> {
    match std::fs::read_to_string(path) {
        Ok(text) => Ok(Some(text)),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(e.to_string()),
    }
}

pub(super) async fn prepare(project: &str) -> Result<(), String> {
    let db_root = PathBuf::from(db_path(project));
    if !db_root.is_dir() {
        return Ok(());
    }
    let marker = db_root.join("page-ids-v1.json");
    static LOCK: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());
    let _guard = LOCK.lock().await;
    let saved = read_optional(&marker)?
        .map(|s| serde_json::from_str::<Migration>(&s))
        .transpose()
        .map_err(|e| e.to_string())?;
    if matches!(saved, Some(Migration::Complete)) {
        return Ok(());
    }
    let logical_root = format!("{}/wiki", project.trim_end_matches('/'));
    if !Path::new(&crate::commands::fs::resolve_project_storage_path(
        &logical_root,
    ))
    .is_dir()
    {
        return Ok(());
    }
    let db = open_project_db(project).await?;
    let state = match saved {
        Some(state) => state,
        None => {
            let names = db
                .table_names()
                .execute()
                .await
                .map_err(|e| e.to_string())?;
            let mut owners = BTreeMap::new();
            if names.iter().any(|n| n == TABLE_V1 || n == TABLE_V2) {
                collect_paths(
                    do_list_directory(&logical_root, false, 30)?,
                    "wiki",
                    &mut owners,
                );
            }
            let mut v1 = Renames::new();
            let mut v2 = Renames::new();
            if names.iter().any(|n| n == TABLE_V1) {
                v1 = plan_table(&db, TABLE_V1, &owners).await?;
            }
            if names.iter().any(|n| n == TABLE_V2) {
                v2 = plan_table(&db, TABLE_V2, &owners).await?;
            }
            let pending = Migration::Pending { v1, v2 };
            persist(&marker, &pending)?;
            pending
        }
    };
    if let Migration::Pending { v1, v2 } = state {
        apply_table(&db, TABLE_V1, &v1).await?;
        apply_table(&db, TABLE_V2, &v2).await?;
        migrate_manifest(project, &v2)?;
    }
    persist(&marker, &Migration::Complete)
}
