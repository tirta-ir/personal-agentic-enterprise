use crate::App;
use anyhow::{Context, Result, ensure};
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use ts_rs::TS;

#[derive(Serialize, Deserialize, TS)]
#[ts(export)]
pub struct Folder {
    pub name: String,
    pub path: String,
}
#[derive(Serialize, Deserialize, TS)]
#[ts(export)]
pub struct DirectoryView {
    pub path: String,
    pub parent: Option<String>,
    pub roots: Vec<Folder>,
    pub folders: Vec<Folder>,
}

fn display(path: &Path) -> String {
    let value = path.to_string_lossy();
    if let Some(unc) = value.strip_prefix(r"\\?\UNC\") {
        format!(r"\\{unc}")
    } else {
        value.strip_prefix(r"\\?\").unwrap_or(&value).into()
    }
}
pub fn browse(app: &App, requested: &str) -> Result<DirectoryView> {
    let project = app
        .store
        .org
        .parent()
        .context("Organization has no parent directory")?;
    let path = if requested.is_empty() {
        project.to_path_buf()
    } else {
        PathBuf::from(requested)
    };
    ensure!(path.is_absolute(), "Select an absolute folder path");
    let path = path
        .canonicalize()
        .context("Folder is unavailable or access was denied")?;
    ensure!(
        !path
            .components()
            .any(|c| c.as_os_str().eq_ignore_ascii_case(".state")),
        "Internal organization state cannot be browsed"
    );
    ensure!(path.is_dir(), "Select a folder, not a file");
    let mut roots = vec![Folder {
        name: "Project folder".into(),
        path: display(project),
    }];
    if let Some(home) = std::env::var_os(if cfg!(windows) { "USERPROFILE" } else { "HOME" }) {
        roots.push(Folder {
            name: "Home".into(),
            path: display(Path::new(&home)),
        });
    }
    #[cfg(windows)]
    for drive in b'A'..=b'Z' {
        let root = format!("{}:\\", char::from(drive));
        if Path::new(&root).is_dir() {
            roots.push(Folder {
                name: root.clone(),
                path: root,
            });
        }
    }
    #[cfg(not(windows))]
    roots.push(Folder {
        name: "Filesystem".into(),
        path: "/".into(),
    });
    let mut folders = Vec::new();
    // ponytail: cap scans at 10,000 entries; paginate if very large folders become common.
    for (count, entry) in std::fs::read_dir(&path)
        .context("Cannot read this folder")?
        .enumerate()
    {
        ensure!(
            count < 10000,
            "This folder has too many entries; enter a more specific path"
        );
        let entry = entry?;
        let name = entry.file_name().to_string_lossy().into_owned();
        if name == ".state" || name == ".git" || name.starts_with(".env") {
            continue;
        }
        if entry.file_type()?.is_dir() {
            folders.push(Folder {
                name,
                path: display(&entry.path()),
            });
        }
    }
    folders.sort_by_cached_key(|f| f.name.to_lowercase());
    Ok(DirectoryView {
        path: display(&path),
        parent: path.parent().map(display),
        roots,
        folders,
    })
}
