// SPDX-FileCopyrightText: Copyright (c) 2026, NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

//! Versioned, bounded control messages. Provider bodies never pass through these queues.
use super::{
    control::*,
    protocol::{BrokerDirective, ComponentRole, SensitiveString},
};
use crate::error::CliError;
use futures_util::{SinkExt, StreamExt};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::sync::Arc;
use std::time::Duration;
use tokio::sync::{Mutex, mpsc};
use tokio_tungstenite::tungstenite::{Message, protocol::WebSocketConfig};

pub(crate) const MCP_SOCKET_PATH: &str = "/_nemo-relay/control/v2/mcp";
pub(crate) const WORKER_SOCKET_PATH: &str = "/_nemo-relay/control/v2/worker";
pub(crate) const QUEUE_CAPACITY: usize = 64;
pub(crate) const GRACE: Duration = Duration::from_secs(30);
pub(crate) const ATTEMPT_TIMEOUT: Duration = Duration::from_secs(5);

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", content = "payload", rename_all = "snake_case")]
pub(crate) enum Command {
    Challenge(ChallengeRequest),
    RegisterMcp {
        request: McpRegisterRequest,
        credential: SensitiveString,
    },
    RegisterWorker(WorkerRegisterRequest),
    RecoverWorker(WorkerRecoverRequest),
    Ready(SessionRequest<WorkerReadyPayload>),
    Release(SessionRequest<EmptyPayload>),
    ActivationFailed(SessionRequest<ActivationFailedPayload>),
    Acknowledge {
        request_id: String,
    },
}
#[derive(Debug, Clone, Serialize, Deserialize)]
pub(crate) struct Request {
    pub(crate) request_id: String,
    pub(crate) command: Command,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub(crate) enum Event {
    Reply {
        request_id: String,
        status: u16,
        payload: Value,
    },
    Directive {
        request_id: String,
        directive: BrokerDirective,
    },
    Drain {
        request_id: String,
        request: WorkerDrainRequest,
    },
}

struct Connection {
    send: mpsc::Sender<Request>,
    receive: mpsc::Receiver<Event>,
    pending: std::collections::VecDeque<Event>,
    task: tokio::task::JoinHandle<()>,
    disconnected: Arc<std::sync::Mutex<Option<tokio::time::Instant>>>,
}
impl Drop for Connection {
    fn drop(&mut self) {
        self.task.abort();
    }
}
#[derive(Clone, Default)]
pub(crate) struct Client(Arc<Mutex<Option<Connection>>>);

impl Client {
    pub(crate) async fn connect(&self, origin: &str, role: ComponentRole) -> Result<(), CliError> {
        let mut url = super::address::daemon_url(origin)?;
        let scheme = if url.scheme() == "https" { "wss" } else { "ws" };
        url.set_scheme(scheme)
            .map_err(|()| failure("invalid WebSocket scheme"))?;
        url.set_path(if role == ComponentRole::Mcp {
            MCP_SOCKET_PATH
        } else {
            WORKER_SOCKET_PATH
        });
        let config = WebSocketConfig::default()
            .max_message_size(Some(MAX_CONTROL_BODY_BYTES))
            .max_frame_size(Some(MAX_CONTROL_BODY_BYTES));
        // Multiple rustls backends are enabled in the workspace. Select Relay's provider
        // before the WSS connector builds its TLS configuration, as pooled_client does.
        let _ = rustls::crypto::ring::default_provider().install_default();
        let (socket, _) = tokio::time::timeout(
            ATTEMPT_TIMEOUT,
            tokio_tungstenite::connect_async_with_config(url.as_str(), Some(config), true),
        )
        .await
        .map_err(|_| failure("control connection timed out"))?
        .map_err(|error| {
            failure(format!(
                "control protocol v2 WebSocket connection failed: {error}"
            ))
        })?;
        let (send, mut requests) = mpsc::channel::<Request>(QUEUE_CAPACITY);
        let (events, receive) = mpsc::channel(QUEUE_CAPACITY);
        let disconnected = Arc::new(std::sync::Mutex::new(None));
        let connection_loss = disconnected.clone();
        let task = tokio::spawn(async move {
            let (mut writer, mut reader) = socket.split();
            loop {
                tokio::select! {
                    request = requests.recv() => {
                        let Some(request) = request else { break };
                        let Ok(encoded) = serde_json::to_string(&request) else { break };
                        if encoded.len() > MAX_CONTROL_BODY_BYTES { break; }
                        if !matches!(tokio::time::timeout(ATTEMPT_TIMEOUT, writer.send(Message::Text(encoded.into()))).await, Ok(Ok(()))) { break; }
                    }
                    message = reader.next() => match message {
                        Some(Ok(Message::Text(text))) => {
                            let Ok(event) = serde_json::from_str::<Event>(&text) else { break };
                            if events.try_send(event).is_err() { break; }
                        }
                        Some(Ok(Message::Ping(bytes))) => {
                            if !matches!(tokio::time::timeout(ATTEMPT_TIMEOUT, writer.send(Message::Pong(bytes))).await, Ok(Ok(()))) { break; }
                        }
                        Some(Ok(Message::Pong(_))) => {},
                        _ => break,
                    }
                }
            }
            // Record transport loss before closing the event channel. Consumers may still
            // have queued directives to process when they observe its eventual EOF.
            *connection_loss
                .lock()
                .unwrap_or_else(|error| error.into_inner()) = Some(tokio::time::Instant::now());
        });
        *self.0.lock().await = Some(Connection {
            send,
            receive,
            pending: Default::default(),
            task,
            disconnected,
        });
        Ok(())
    }
    pub(crate) async fn recovery_deadline(&self) -> tokio::time::Instant {
        let guard = self.0.lock().await;
        let disconnected = guard.as_ref().and_then(|connection| {
            *connection
                .disconnected
                .lock()
                .unwrap_or_else(|error| error.into_inner())
        });
        disconnected.unwrap_or_else(tokio::time::Instant::now) + GRACE
    }
    pub(crate) async fn request<R: serde::de::DeserializeOwned>(
        &self,
        command: Command,
    ) -> Result<R, CliError> {
        let mut guard = self.0.lock().await;
        let connection = guard
            .as_mut()
            .ok_or_else(|| failure("control connection is closed"))?;
        let request_id = uuid::Uuid::now_v7().to_string();
        connection
            .send
            .try_send(Request {
                request_id: request_id.clone(),
                command,
            })
            .map_err(|_| failure("control writer unavailable"))?;
        tokio::time::timeout(ATTEMPT_TIMEOUT, async {
            loop {
                let event = connection
                    .receive
                    .recv()
                    .await
                    .ok_or_else(|| failure("control connection lost"))?;
                match event {
                    Event::Reply {
                        request_id: id,
                        status,
                        payload,
                    } if id == request_id => {
                        if !(200..300).contains(&status) {
                            let message = payload
                                .pointer("/error/message")
                                .and_then(Value::as_str)
                                .unwrap_or("control command rejected");
                            return Err(if status == 401 {
                                CliError::Unauthorized(message.into())
                            } else {
                                failure(message)
                            });
                        }
                        return serde_json::from_value(payload)
                            .map_err(|error| failure(format!("invalid control reply: {error}")));
                    }
                    Event::Reply { .. } => {}
                    event => {
                        if connection.pending.len() == QUEUE_CAPACITY {
                            return Err(failure("control event queue overflow"));
                        }
                        connection.pending.push_back(event);
                    }
                }
            }
        })
        .await
        .map_err(|_| failure("control operation timed out"))?
    }
    pub(crate) async fn next(&self) -> Result<Event, CliError> {
        let mut guard = self.0.lock().await;
        let connection = guard
            .as_mut()
            .ok_or_else(|| failure("control connection is closed"))?;
        loop {
            let event = match connection.pending.pop_front() {
                Some(event) => event,
                None => connection
                    .receive
                    .recv()
                    .await
                    .ok_or_else(|| failure("control connection lost"))?,
            };
            if !matches!(event, Event::Reply { .. }) {
                return Ok(event);
            }
        }
    }
    /// Registration replies are ordered after any pending drain intent on the same socket.
    pub(crate) async fn pending_event(&self) -> Option<Event> {
        self.0.lock().await.as_mut()?.pending.pop_front()
    }
    pub(crate) async fn acknowledge(&self, request_id: String) -> Result<(), CliError> {
        self.request(Command::Acknowledge { request_id }).await
    }
}
pub(crate) fn failure(message: impl Into<String>) -> CliError {
    CliError::Launch(message.into())
}

pub(crate) async fn retry<T, F, Fut>(operation: F) -> Result<T, CliError>
where
    F: FnMut() -> Fut,
    Fut: std::future::Future<Output = Result<T, CliError>>,
{
    retry_until(tokio::time::Instant::now() + GRACE, operation).await
}

pub(crate) async fn retry_until<T, F, Fut>(
    deadline: tokio::time::Instant,
    mut operation: F,
) -> Result<T, CliError>
where
    F: FnMut() -> Fut,
    Fut: std::future::Future<Output = Result<T, CliError>>,
{
    let mut delay = Duration::from_millis(250);
    loop {
        if tokio::time::Instant::now() >= deadline {
            return Err(failure("control reconnect grace period expired"));
        }
        let result = tokio::time::timeout_at(
            deadline.min(tokio::time::Instant::now() + ATTEMPT_TIMEOUT),
            operation(),
        )
        .await;
        let error = match result {
            Ok(Ok(value)) => return Ok(value),
            Ok(Err(error)) => error,
            Err(_) => failure("control connection/authentication attempt timed out"),
        };
        if tokio::time::Instant::now() >= deadline {
            return Err(failure(format!(
                "control reconnect grace period expired: {error}"
            )));
        }
        let jitter = u64::from(uuid::Uuid::now_v7().as_bytes()[15]) % 100;
        tokio::time::sleep_until(deadline.min(
            tokio::time::Instant::now() + delay.saturating_sub(Duration::from_millis(jitter)),
        ))
        .await;
        delay = (delay * 2).min(Duration::from_secs(2));
    }
}

#[cfg(test)]
#[path = "../../../tests/coverage/daemon/client_tests.rs"]
mod tests;
