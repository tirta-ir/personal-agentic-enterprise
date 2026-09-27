use crate::{
    App, api,
    model::{Run, Workspace},
    security::{self, ApiError},
};
use anyhow::{Context, Result, ensure};
use axum::{
    extract::{Path, Query, State},
    http::header,
    response::{IntoResponse, Response},
};
use serde::Deserialize;
use std::path::{Component, Path as FilePath, PathBuf};
use tokio::io::AsyncReadExt;

const MAX_FILE_BYTES: u64 = 25 * 1024 * 1024;

#[derive(Deserialize)]
pub struct FileQuery {
    path: String,
}

fn resolve(workspace: &Workspace, reference: &str) -> Result<PathBuf> {
    security::revalidate(workspace)?;
    ensure!(
        !reference.is_empty() && !reference.chars().any(char::is_control),
        "Invalid file path"
    );
    let reference = reference.replace('\\', "/");
    let reference = if reference.to_ascii_lowercase().starts_with("file:") {
        let url = url::Url::parse(&reference)?;
        ensure!(
            url.host_str().is_none_or(|host| host == "localhost"),
            "Network file paths are not supported"
        );
        url.to_file_path()
            .map_err(|_| anyhow::anyhow!("Invalid local file URL"))?
    } else {
        let reference = reference.strip_prefix("//?/").unwrap_or(&reference);
        ensure!(
            !reference.starts_with("//"),
            "Network file paths are not supported"
        );
        // Codex sometimes emits /C:/path as a Markdown destination on Windows.
        let reference = if cfg!(windows)
            && reference.starts_with('/')
            && reference.as_bytes().get(2) == Some(&b':')
        {
            &reference[1..]
        } else {
            reference
        };
        PathBuf::from(reference)
    };
    ensure!(
        !reference
            .components()
            .any(|part| matches!(part, Component::ParentDir)),
        "Path escapes workspace"
    );
    api::visible_file_path(&reference)?;
    let base = FilePath::new(&workspace.canonical_path);
    let relative = if reference.is_absolute() {
        reference
            .canonicalize()
            .context("Linked file is unavailable")?
            .strip_prefix(base)
            .context("File is outside this run's attached workdir")?
            .to_owned()
    } else {
        reference
    };
    api::contained(base, relative.to_str().context("File path is not UTF-8")?)
}

fn content_type(path: &FilePath) -> (&'static str, &'static str) {
    match path
        .extension()
        .and_then(|ext| ext.to_str())
        .unwrap_or("")
        .to_ascii_lowercase()
        .as_str()
    {
        "png" => ("image/png", "inline"),
        "jpg" | "jpeg" => ("image/jpeg", "inline"),
        "webp" => ("image/webp", "inline"),
        "gif" => ("image/gif", "inline"),
        "bmp" => ("image/bmp", "inline"),
        "avif" => ("image/avif", "inline"),
        "md" | "txt" | "log" | "json" | "csv" | "yaml" | "yml" | "toml" | "rs" | "py" | "ts"
        | "tsx" | "js" | "jsx" | "css" | "sh" | "ps1" | "sql" | "xml" => {
            ("text/plain; charset=utf-8", "inline")
        }
        _ => ("application/octet-stream", "attachment"),
    }
}

pub async fn read(
    State(app): State<App>,
    Path(id): Path<String>,
    Query(query): Query<FileQuery>,
) -> Result<Response, ApiError> {
    let run: Run = app.store.get("runs", &id)?;
    let workspace = run
        .profile
        .workdir
        .as_ref()
        .context("This run has no attached workdir")?;
    if let Some(host) = workspace.ssh_host.clone() {
        let mut request = crate::remote::request(workspace, "file");
        request["reference"] = query.path.clone().into();
        let bytes = tokio::task::spawn_blocking(move || crate::remote::call_raw(&host, request))
            .await
            .map_err(anyhow::Error::from)??;
        let (mime, disposition) = content_type(FilePath::new(&query.path));
        return Ok((
            [
                (header::CONTENT_TYPE, mime),
                (header::CONTENT_DISPOSITION, disposition),
            ],
            bytes,
        )
            .into_response());
    }
    let path = resolve(workspace, &query.path)?;
    let file = tokio::fs::File::open(&path)
        .await
        .map_err(anyhow::Error::from)?;
    let metadata = file.metadata().await.map_err(anyhow::Error::from)?;
    if !metadata.is_file() {
        return Err(anyhow::anyhow!("Link must point to a file").into());
    }
    if metadata.len() > MAX_FILE_BYTES {
        return Err(anyhow::anyhow!("File exceeds the 25 MiB viewer limit").into());
    }
    let mut bytes = Vec::new();
    file.take(MAX_FILE_BYTES + 1)
        .read_to_end(&mut bytes)
        .await
        .map_err(anyhow::Error::from)?;
    if bytes.len() as u64 > MAX_FILE_BYTES {
        return Err(anyhow::anyhow!("File exceeds the 25 MiB viewer limit").into());
    }
    let (mime, disposition) = content_type(&path);
    let filename = path
        .file_name()
        .context("Missing filename")?
        .to_string_lossy();
    let filename = url::form_urlencoded::byte_serialize(filename.as_bytes())
        .collect::<String>()
        .replace('+', "%20");
    Ok((
        [
            (header::CONTENT_TYPE, mime.to_owned()),
            (
                header::CONTENT_DISPOSITION,
                format!("{disposition}; filename*=UTF-8''{filename}"),
            ),
        ],
        bytes,
    )
        .into_response())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn file_links_stay_in_the_saved_workdir() -> Result<()> {
        let directory = tempfile::tempdir()?;
        let root = directory.path().join("workdir with spaces");
        std::fs::create_dir_all(root.join(".assistant"))?;
        let image = root.join(".assistant/screenshot.png");
        std::fs::write(&image, b"file path fixture")?;
        std::fs::write(root.join(".env"), b"DENIED=fixture")?;
        std::fs::write(directory.path().join("outside.txt"), b"outside")?;
        let workspace = security::validate_workspace(root.to_str().unwrap())?;
        let expected = image.canonicalize()?;
        assert_eq!(resolve(&workspace, ".assistant/screenshot.png")?, expected);
        assert_eq!(resolve(&workspace, image.to_str().unwrap())?, expected);
        assert_eq!(
            resolve(
                &workspace,
                url::Url::from_file_path(&image).unwrap().as_str()
            )?,
            expected
        );
        for forbidden in [
            "../outside.txt",
            ".env",
            ".git/config",
            ".state/owner.key",
            "report.md:secret",
            "file://remote/share/image.png",
            "//remote/share/image.png",
        ] {
            assert!(resolve(&workspace, forbidden).is_err(), "{forbidden}");
        }
        assert!(
            resolve(
                &workspace,
                directory.path().join("outside.txt").to_str().unwrap()
            )
            .is_err()
        );
        assert!(resolve(&workspace, "missing.png").is_err());
        assert_eq!(
            content_type(FilePath::new("report.md")),
            ("text/plain; charset=utf-8", "inline")
        );
        assert_eq!(
            content_type(FilePath::new("active.svg")),
            ("application/octet-stream", "attachment")
        );
        Ok(())
    }
}
