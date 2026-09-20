// Table and nearest-neighbour query adapted from LanceDB's Apache-2.0 simple.rs example.
use anyhow::{Context, Result};
use arrow_array::{
    Array, FixedSizeListArray, Float32Array, RecordBatch, StringArray, types::Float32Type,
};
use arrow_schema::{DataType, Field, Schema};
use fastembed::{
    EmbeddingModel, ImageEmbedding, ImageEmbeddingModel, ImageInitOptions, TextEmbedding,
    TextInitOptions,
};
use futures::TryStreamExt;
use lancedb::query::{ExecutableQuery, QueryBase};
use std::{
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
};

pub struct Knowledge {
    root: PathBuf,
    models: Mutex<Models>,
    writer: tokio::sync::Mutex<()>,
}
#[derive(Default)]
struct Models {
    text: Option<TextEmbedding>,
    image: Option<ImageEmbedding>,
    last_used: Option<std::time::Instant>,
}
impl Knowledge {
    pub fn release_idle_models(&self) {
        if let Ok(mut models) = self.models.try_lock() {
            if models
                .last_used
                .is_some_and(|t| t.elapsed().as_secs() >= 60)
            {
                *models = Models::default();
            }
        }
    }
    pub fn new(root: PathBuf) -> Self {
        Self {
            root,
            models: Mutex::new(Models::default()),
            writer: tokio::sync::Mutex::new(()),
        }
    }
    fn text_vector(&self, text: &str) -> Result<Vec<f32>> {
        let mut models = self
            .models
            .lock()
            .map_err(|_| anyhow::anyhow!("Embedding model lock unavailable"))?;
        models.last_used = Some(std::time::Instant::now());
        if models.text.is_none() {
            models.text = Some(TextEmbedding::try_new(
                TextInitOptions::new(EmbeddingModel::ClipVitB32)
                    .with_cache_dir(self.root.join("models"))
                    .with_intra_threads(2)
                    .with_show_download_progress(false),
            )?);
        }
        models
            .text
            .as_mut()
            .context("Text model unavailable")?
            .embed(vec![text], None)?
            .into_iter()
            .next()
            .context("No text embedding produced")
    }
    fn image_vector(&self, path: &Path) -> Result<Vec<f32>> {
        let mut models = self
            .models
            .lock()
            .map_err(|_| anyhow::anyhow!("Embedding model lock unavailable"))?;
        models.last_used = Some(std::time::Instant::now());
        if models.image.is_none() {
            models.image = Some(ImageEmbedding::try_new(
                ImageInitOptions::new(ImageEmbeddingModel::ClipVitB32)
                    .with_cache_dir(self.root.join("models"))
                    .with_intra_threads(2)
                    .with_show_download_progress(false),
            )?);
        }
        models
            .image
            .as_mut()
            .context("Image model unavailable")?
            .embed_bytes(&[&std::fs::read(path)?], None)?
            .into_iter()
            .next()
            .context("No image embedding produced")
    }
    async fn table(&self) -> Result<lancedb::Table> {
        let db = lancedb::connect(
            self.root
                .join("lancedb")
                .to_str()
                .context("Invalid index path")?,
        )
        .execute()
        .await?;
        if db
            .table_names()
            .execute()
            .await?
            .iter()
            .any(|s| s == "artifacts")
        {
            Ok(db.open_table("artifacts").execute().await?)
        } else {
            Ok(db
                .create_empty_table("artifacts", schema())
                .execute()
                .await?)
        }
    }
    pub async fn index(
        self: Arc<Self>,
        id: String,
        group: String,
        path: PathBuf,
        image: bool,
    ) -> Result<()> {
        let own = self.clone();
        let vectors = tokio::task::spawn_blocking(move || -> Result<Vec<(String, Vec<f32>)>> {
            if image {
                Ok(vec![(String::new(), own.image_vector(&path)?)])
            } else {
                let text = std::fs::read_to_string(path)?;
                let words: Vec<_> = text.split_whitespace().collect();
                let mut output = Vec::new();
                for chunk in words.chunks(48) {
                    let text = chunk.join(" ");
                    output.push((text.clone(), own.text_vector(&text)?));
                }
                anyhow::ensure!(!output.is_empty(), "Document is empty");
                Ok(output)
            }
        })
        .await??;
        let _guard = self.writer.lock().await;
        let table = self.table().await?;
        table
            .delete(&format!("id = '{}'", id.replace('\'', "''")))
            .await?;
        let n = vectors.len();
        let batch = RecordBatch::try_new(
            schema(),
            vec![
                Arc::new(StringArray::from(vec![id.as_str(); n])),
                Arc::new(StringArray::from(vec![group.as_str(); n])),
                Arc::new(StringArray::from(
                    vectors.iter().map(|(s, _)| s.as_str()).collect::<Vec<_>>(),
                )),
                Arc::new(
                    FixedSizeListArray::from_iter_primitive::<Float32Type, _, _>(
                        vectors
                            .iter()
                            .map(|(_, v)| Some(v.iter().copied().map(Some).collect::<Vec<_>>())),
                        512,
                    ),
                ),
            ],
        )?;
        table.add(batch).execute().await?;
        Ok(())
    }
    pub async fn search(
        self: Arc<Self>,
        query: String,
        group: String,
        images: bool,
    ) -> Result<Vec<serde_json::Value>> {
        let own = self.clone();
        let vector = tokio::task::spawn_blocking(move || own.text_vector(&query)).await??;
        let _guard = self.writer.lock().await;
        let table = self.table().await?;
        let batches = table
            .query()
            .nearest_to(vector)?
            .only_if(format!(
                "group_id = '{}' AND text {} ''",
                group.replace('\'', "''"),
                if images { "=" } else { "!=" }
            ))
            .limit(20)
            .execute()
            .await?
            .try_collect::<Vec<_>>()
            .await?;
        let mut output = Vec::new();
        let mut seen = std::collections::HashSet::new();
        for batch in batches {
            let ids = batch
                .column_by_name("id")
                .context("Index id column missing")?
                .as_any()
                .downcast_ref::<StringArray>()
                .context("Invalid id column")?;
            let snippets = batch
                .column_by_name("text")
                .context("Index text column missing")?
                .as_any()
                .downcast_ref::<StringArray>()
                .context("Invalid text column")?;
            let distances = batch
                .column_by_name("_distance")
                .and_then(|c| c.as_any().downcast_ref::<Float32Array>());
            for i in 0..batch.num_rows() {
                if seen.insert(ids.value(i).to_owned()) {
                    output.push(serde_json::json!({"id":ids.value(i),"snippet":snippets.value(i),"distance":distances.map(|d|d.value(i)),"model":"CLIP ViT-B/32"}));
                }
            }
        }
        Ok(output)
    }
    pub async fn delete(&self, id: &str) -> Result<()> {
        let _guard = self.writer.lock().await;
        self.table()
            .await?
            .delete(&format!("id = '{}'", id.replace('\'', "''")))
            .await?;
        Ok(())
    }
}
fn schema() -> Arc<Schema> {
    Arc::new(Schema::new(vec![
        Field::new("id", DataType::Utf8, false),
        Field::new("group_id", DataType::Utf8, false),
        Field::new("text", DataType::Utf8, false),
        Field::new(
            "vector",
            DataType::FixedSizeList(Arc::new(Field::new("item", DataType::Float32, true)), 512),
            true,
        ),
    ]))
}
