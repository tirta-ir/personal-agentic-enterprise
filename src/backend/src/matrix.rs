//! Bidirectional room bridge using matrix-rust-sdk. Matrix event IDs and transaction
//! IDs make reconnects idempotent; the platform still authorizes every invocation.
use crate::{
    App,
    api::SendInput,
    model::{Group, Message},
    platform::{Identity, Platform},
    store,
};
use anyhow::{Context, Result, ensure};
use matrix_sdk::{
    Client, Room, RoomMemberships,
    config::SyncSettings,
    ruma::{
        OwnedTransactionId, RoomId, UserId,
        api::client::room::create_room::v3::{Request as CreateRoom, RoomPreset},
        events::room::message::{
            MessageType, OriginalSyncRoomMessageEvent, RoomMessageEventContent,
        },
    },
};
use rusqlite::OptionalExtension;
use sha2::{Digest, Sha256};
use std::{sync::Arc, time::Duration};

fn metadata(app: &App, key: &str) -> Result<Option<String>> {
    app.store.read(|db| {
        Ok(db
            .query_row("SELECT value FROM metadata WHERE key=?", [key], |r| {
                r.get(0)
            })
            .optional()?)
    })
}
fn save(app: &App, key: &str, value: &str) -> Result<()> {
    app.store.write(|db| {
        db.execute(
            "INSERT INTO metadata VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
            [key, value],
        )?;
        Ok(())
    })
}

pub async fn start(platform: Arc<Platform>) -> Result<()> {
    let Some(homeserver) = &platform.homeserver else {
        return Ok(());
    };
    let username = std::env::var("AE_MATRIX_BOT_USERNAME")
        .context("AE_MATRIX_BOT_USERNAME is required for Matrix rooms")?;
    let password = std::env::var("AE_MATRIX_BOT_PASSWORD")
        .context("AE_MATRIX_BOT_PASSWORD is required for Matrix rooms")?;
    let client = Client::builder()
        .homeserver_url(homeserver)
        .request_config(
            matrix_sdk::config::RequestConfig::new()
                .retry_limit(2)
                .timeout(Duration::from_secs(40)),
        )
        .build()
        .await?;
    client
        .matrix_auth()
        .login_username(&username, &password)
        .initial_device_display_name("Agentic Enterprise room bridge")
        .await?;
    let ingest_platform = platform.clone();
    let bot = client
        .user_id()
        .context("Missing bridge identity")?
        .to_owned();
    client.add_event_handler(move |event: OriginalSyncRoomMessageEvent, room: Room| {
        let p = ingest_platform.clone();
        let bot = bot.clone();
        async move {
            if event.sender == bot {
                return;
            }
            if let Err(error) = ingest(&p, &room, event) {
                tracing::warn!("Matrix incoming message rejected: {error}");
            }
        }
    });
    let sync_client = client.clone();
    let sync_platform = platform.clone();
    tokio::spawn(async move {
        let mut token = metadata(&sync_platform.base, "matrix_sync_token")
            .ok()
            .flatten();
        loop {
            let mut settings = SyncSettings::default().timeout(Duration::from_secs(30));
            if let Some(t) = &token {
                settings = settings.token(t.clone());
            }
            match sync_client.sync_once(settings).await {
                Ok(response) => {
                    token = Some(response.next_batch);
                    if let Some(t) = &token {
                        if let Err(e) = save(&sync_platform.base, "matrix_sync_token", t) {
                            tracing::error!("Persist Matrix cursor: {e}");
                        }
                    }
                }
                Err(e) => {
                    tracing::warn!("Matrix sync unavailable: {e}");
                    tokio::time::sleep(Duration::from_secs(5)).await;
                }
            }
        }
    });
    tokio::spawn(async move {
        loop {
            if let Err(e) = publish(&platform, &client).await {
                tracing::warn!("Matrix room delivery pending: {e}");
            }
            tokio::time::sleep(Duration::from_secs(2)).await;
        }
    });
    Ok(())
}
fn ingest(platform: &Platform, room: &Room, event: OriginalSyncRoomMessageEvent) -> Result<()> {
    let MessageType::Text(text) = event.content.msgtype else {
        return Ok(());
    };
    let apps: Vec<_> = platform
        .apps
        .lock()
        .map_err(|_| anyhow::anyhow!("Workspace registry unavailable"))?
        .iter()
        .map(|(id, app)| (id.clone(), app.clone()))
        .collect();
    for (tenant, mut app) in apps {
        if !app.enabled.load(std::sync::atomic::Ordering::Relaxed) {
            continue;
        }
        for group in app.store.list::<Group>("groups")? {
            if metadata(&app, &format!("matrix_room:{}", group.id))?.as_deref()
                != Some(room.room_id().as_str())
            {
                continue;
            }
            let user = event.sender.to_string();
            let person = platform
                .members(&tenant)?
                .into_iter()
                .find(|p| p["user"] == user)
                .context("Sender is not a workspace member")?;
            app.identity = Some(Identity {
                user: user.clone(),
                role: person["role"].as_str().unwrap_or("member").into(),
            });
            ensure!(
                crate::platform::can_read(&app, &group),
                "Sender is not invited to this group"
            );
            group.ensure_active()?;
            // Native room posts cannot invoke privileged slash commands.
            ensure!(
                !text.body.trim_start().starts_with('/'),
                "Use the platform for chat commands"
            );
            let id = format!("{:x}", Sha256::digest(event.event_id.as_bytes()));
            let input = SendInput {
                id: id.clone(),
                group_id: group.id.clone(),
                side_chat_id: None,
                body: text.body.clone(),
                recipients: mentions(&app, &group, &text.body)?,
                reply_to: None,
                artifacts: vec![],
            };
            app.store.write(|tx| {
                let mut message = crate::api::submit_message_as(tx, input, None, &user)?;
                message.sender = user;
                store::put(tx, "messages", &message.id, &message)?;
                tx.execute(
                    "INSERT OR IGNORE INTO metadata VALUES(?,?)",
                    [format!("matrix_sent:{id}"), event.event_id.to_string()],
                )?;
                Ok(())
            })?;
            app.wake.notify_one();
            return Ok(());
        }
    }
    Ok(())
}
pub fn mentions(app: &App, group: &Group, body: &str) -> Result<Vec<String>> {
    app.store
        .read(|db| crate::group_scope::mentions(db, group, body))
}
async fn publish(platform: &Platform, client: &Client) -> Result<()> {
    let apps: Vec<_> = platform
        .apps
        .lock()
        .map_err(|_| anyhow::anyhow!("Workspace registry unavailable"))?
        .iter()
        .map(|(id, app)| (id.clone(), app.clone()))
        .collect();
    for (tenant, app) in apps {
        let enabled = app.enabled.load(std::sync::atomic::Ordering::Relaxed);
        let members = platform.members(&tenant)?;
        for group in app.store.list::<Group>("groups")? {
            let result: Result<()> = async {
                let closed = !enabled || group.ensure_active().is_err();
                if closed && metadata(&app, &format!("matrix_room:{}", group.id))?.is_none() {
                    return Ok(());
                }
                let desired: Vec<_> = members
                    .iter()
                    .filter(|p| {
                        p["role"] == "owner"
                            || group.human_ids.as_ref().is_none_or(|ids| {
                                ids.iter().any(|id| Some(id.as_str()) == p["user"].as_str())
                            })
                    })
                    .filter_map(|p| p["user"].as_str())
                    .filter(|u| *u != "owner" && enabled && group.deleted_at.is_none())
                    .map(UserId::parse)
                    .collect::<std::result::Result<_, _>>()?;
                let key = format!("matrix_room:{}", group.id);
                let room = if let Some(id) = metadata(&app, &key)? {
                    let id = RoomId::parse(id)?;
                    if let Some(room) = client.get_room(&id) {
                        room
                    } else {
                        client.join_room_by_id(&id).await?
                    }
                } else {
                    let mut request = CreateRoom::new();
                    request.name = Some(format!("{tenant} · {}", group.name));
                    request.topic = Some(group.description.clone());
                    request.preset = Some(RoomPreset::PrivateChat);
                    request.power_level_content_override = Some(serde_json::from_value(
                        serde_json::json!({"invite":100,"kick":100,"ban":100,"state_default":100}),
                    )?);
                    request.invite = desired.clone();
                    let room = client.create_room(request).await?;
                    save(&app, &key, room.room_id().as_str())?;
                    room
                };
                let bot = client.user_id().context("Bridge identity unavailable")?;
                let power: matrix_sdk::ruma::events::room::power_levels::RoomPowerLevelsEventContent =
                    serde_json::from_value(
                        serde_json::json!({"users":{bot.as_str():100},"events_default":if closed{100}else{0},"state_default":100,"invite":100,"kick":100,"ban":100,"redact":100}),
                    )?;
                let power_key = format!("matrix_power:{}", group.id);
                let serialized = serde_json::to_string(&power)?;
                if metadata(&app, &power_key)?.as_deref() != Some(&serialized) {
                    room.send_state_event(power).await?;
                    save(&app, &power_key, &serialized)?;
                }
                let joined = room
                    .members(RoomMemberships::JOIN | RoomMemberships::INVITE)
                    .await?;
                for member in joined {
                    if Some(member.user_id()) != client.user_id()
                        && !desired.iter().any(|id| id == member.user_id())
                    {
                        room.kick_user(
                            member.user_id(),
                            Some("Workspace or group membership removed"),
                        )
                        .await?;
                    }
                }
                // Invite endpoints are idempotent for existing invitations/membership.
                for user in &desired {
                    let present = room.get_member_no_sync(user).await?;
                    if present.as_ref().is_none_or(|m| {
                        !matches!(
                            m.membership(),
                            matrix_sdk::ruma::events::room::member::MembershipState::Join
                                | matrix_sdk::ruma::events::room::member::MembershipState::Invite
                        )
                    }) {
                        room.invite_user_by_id(user).await?;
                    }
                }
                if closed {
                    return Ok(());
                }
                for message in app
                    .store
                    .list::<Message>("messages")?
                    .into_iter()
                    .filter(|m| m.group_id == group.id && m.side_chat_id.is_none())
                {
                    let sent = format!("matrix_sent:{}", message.id);
                    if metadata(&app, &sent)?.is_some() {
                        continue;
                    }
                    let sender = app
                        .store
                        .get::<crate::model::Agent>("agents", &message.sender)
                        .map(|a| a.name)
                        .unwrap_or_else(|_| message.sender.clone());
                    let content =
                        RoomMessageEventContent::text_plain(format!("{sender}: {}", message.body));
                    let txn: OwnedTransactionId = format!("ae-{tenant}-{}", message.id).into();
                    let event = room.send(content).with_transaction_id(txn).await?;
                    save(&app, &sent, event.response.event_id.as_str())?;
                }
                Ok(())
            }.await;
            if let Err(error) = result {
                tracing::warn!(workspace=%tenant,group=%group.id,"Matrix room delivery pending: {error}");
            }
        }
    }
    Ok(())
}
