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
    listing(&path, path.parent().map(display), roots)
}

pub fn browse_runtime(root: &Path, state: &Path, requested: &str) -> Result<DirectoryView> {
    let path = if requested.is_empty() {
        root.to_path_buf()
    } else {
        PathBuf::from(requested)
    };
    ensure!(path.is_absolute(), "Select an absolute folder path");
    let path = path
        .canonicalize()
        .context("Folder is unavailable or access was denied")?;
    ensure!(
        path.starts_with(root),
        "Folder is outside the runtime's registered root"
    );
    ensure!(
        !path.starts_with(state)
            && !path.components().any(|c| {
                let name = c.as_os_str().to_string_lossy().to_lowercase();
                name == ".state" || name == ".git" || name.starts_with(".env")
            }),
        "Internal or sensitive folders cannot be browsed"
    );
    let mut view = listing(
        &path,
        path.parent().filter(|p| p.starts_with(root)).map(display),
        vec![Folder {
            name: "Runtime root".into(),
            path: display(root),
        }],
    )?;
    view.folders.retain(|f| {
        !Path::new(&f.path)
            .canonicalize()
            .is_ok_and(|p| p.starts_with(state))
    });
    Ok(view)
}

fn listing(path: &Path, parent: Option<String>, roots: Vec<Folder>) -> Result<DirectoryView> {
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
        parent,
        roots,
        folders,
    })
}

#[cfg(test)]
mod tests {
    #[test]
    fn runtime_browser_stays_inside_registered_root() -> anyhow::Result<()> {
        let temp = tempfile::tempdir()?;
        let root = temp.path().join("root");
        let state = root.join("worker-state");
        let project = root.join("project");
        for path in [
            &state,
            &project,
            &root.join(".state"),
            &root.join(".env-private"),
        ] {
            std::fs::create_dir_all(path)?;
        }
        let root = root.canonicalize()?;
        let state = state.canonicalize()?;
        let view = super::browse_runtime(&root, &state, "")?;
        assert!(view.parent.is_none());
        assert_eq!(view.roots.len(), 1);
        assert_eq!(
            view.folders
                .iter()
                .map(|f| f.name.as_str())
                .collect::<Vec<_>>(),
            vec!["project"]
        );
        let child = super::browse_runtime(&root, &state, project.to_str().unwrap())?;
        assert_eq!(child.parent, Some(view.path));
        for path in [
            temp.path().to_path_buf(),
            state.clone(),
            root.join(".state"),
            root.join(".env-private"),
            root.join("missing"),
        ] {
            assert!(super::browse_runtime(&root, &state, path.to_str().unwrap()).is_err());
        }
        assert!(super::browse_runtime(&root, &state, "relative").is_err());
        #[cfg(unix)]
        {
            let link = root.join("escape");
            std::os::unix::fs::symlink(temp.path(), &link)?;
            assert!(super::browse_runtime(&root, &state, link.to_str().unwrap()).is_err());
        }
        Ok(())
    }
}
