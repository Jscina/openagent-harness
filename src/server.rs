use crate::dag::{AgentNotFound, AppState};
use crate::events::PluginEvent;
use crate::types::{CreateTaskRequest, CreateTaskResponse};

use axum::{
    extract::{Json, Path, State},
    http::StatusCode,
    response::{IntoResponse, Response},
    routing::{delete, get, post},
    Router,
};
use std::sync::Arc;
use uuid::Uuid;

pub enum AppError {
    BadRequest(anyhow::Error),
    Internal(anyhow::Error),
}

impl AppError {
    pub fn bad_request(e: impl Into<anyhow::Error>) -> Self {
        Self::BadRequest(e.into())
    }
}

impl IntoResponse for AppError {
    fn into_response(self) -> Response {
        match self {
            AppError::BadRequest(e) => {
                (StatusCode::BAD_REQUEST, format!("error: {}", e)).into_response()
            }
            AppError::Internal(e) => {
                (StatusCode::INTERNAL_SERVER_ERROR, format!("error: {}", e)).into_response()
            }
        }
    }
}

impl<E> From<E> for AppError
where
    E: Into<anyhow::Error>,
{
    fn from(err: E) -> Self {
        Self::Internal(err.into())
    }
}

pub fn router(state: Arc<AppState>) -> Router {
    Router::new()
        .route("/events", post(handle_event))
        .route("/tasks", post(create_task))
        .route("/tasks", get(list_tasks))
        .route("/tasks/{id}", get(get_task))
        .route("/tasks/{id}", delete(cancel_task))
        .with_state(state)
}

async fn handle_event(
    State(state): State<Arc<AppState>>,
    Json(event): Json<PluginEvent>,
) -> Result<StatusCode, AppError> {
    tracing::debug!(event_type = %event.event_type, "plugin event received");
    state.process_event(&event).await;
    Ok(StatusCode::NO_CONTENT)
}

async fn create_task(
    State(state): State<Arc<AppState>>,
    Json(req): Json<CreateTaskRequest>,
) -> Result<(StatusCode, Json<CreateTaskResponse>), AppError> {
    let id = state.add_task(req).await.map_err(|e| {
        if e.is::<AgentNotFound>() {
            AppError::bad_request(e)
        } else {
            AppError::Internal(e)
        }
    })?;
    Ok((StatusCode::CREATED, Json(CreateTaskResponse { id })))
}

async fn list_tasks(
    State(state): State<Arc<AppState>>,
) -> Result<Json<Vec<crate::types::Task>>, AppError> {
    let tasks = state.list_tasks().await;
    Ok(Json(tasks))
}

async fn get_task(
    State(state): State<Arc<AppState>>,
    Path(id): Path<Uuid>,
) -> Result<Response, AppError> {
    match state.get_task(id).await {
        Some(task) => Ok(Json(task).into_response()),
        None => Ok(StatusCode::NOT_FOUND.into_response()),
    }
}

async fn cancel_task(
    State(state): State<Arc<AppState>>,
    Path(id): Path<Uuid>,
) -> Result<StatusCode, AppError> {
    state.cancel_task(id).await?;
    Ok(StatusCode::NO_CONTENT)
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::{
        body::Body,
        http::{Method, Request},
    };
    use tower::ServiceExt;

    fn test_app() -> Router {
        let acp = crate::acp::AcpClient::new("http://localhost:1".to_string(), None);
        let state = Arc::new(AppState::new(acp));
        router(state)
    }

    #[tokio::test]
    async fn post_tasks_returns_201_with_id() {
        let app = test_app();
        let body = serde_json::json!({"prompt": "hello world"});
        let resp = app
            .oneshot(
                Request::builder()
                    .method(Method::POST)
                    .uri("/tasks")
                    .header("content-type", "application/json")
                    .body(Body::from(serde_json::to_string(&body).unwrap()))
                    .unwrap(),
            )
            .await
            .unwrap();

        assert_eq!(resp.status(), StatusCode::CREATED);
        let bytes = axum::body::to_bytes(resp.into_body(), usize::MAX)
            .await
            .unwrap();
        let resp_json: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
        assert!(resp_json["id"].is_string());
    }

    #[tokio::test]
    async fn post_tasks_with_agent_unreachable_acp_returns_500() {
        let app = test_app();
        let body = serde_json::json!({"prompt": "do work", "agent": "explorer"});
        let resp = app
            .oneshot(
                Request::builder()
                    .method(Method::POST)
                    .uri("/tasks")
                    .header("content-type", "application/json")
                    .body(Body::from(serde_json::to_string(&body).unwrap()))
                    .unwrap(),
            )
            .await
            .unwrap();

        assert_eq!(resp.status(), StatusCode::INTERNAL_SERVER_ERROR);
    }

    #[tokio::test]
    async fn get_tasks_returns_created_task() {
        let acp = crate::acp::AcpClient::new("http://localhost:1".to_string(), None);
        let state = Arc::new(AppState::new(acp));
        let app = router(Arc::clone(&state));

        let req_body = serde_json::json!({"prompt": "test prompt"});
        app.clone()
            .oneshot(
                Request::builder()
                    .method(Method::POST)
                    .uri("/tasks")
                    .header("content-type", "application/json")
                    .body(Body::from(serde_json::to_string(&req_body).unwrap()))
                    .unwrap(),
            )
            .await
            .unwrap();

        let resp = router(Arc::clone(&state))
            .oneshot(
                Request::builder()
                    .method(Method::GET)
                    .uri("/tasks")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();

        assert_eq!(resp.status(), StatusCode::OK);
        let bytes = axum::body::to_bytes(resp.into_body(), usize::MAX)
            .await
            .unwrap();
        let tasks: Vec<serde_json::Value> = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(tasks.len(), 1);
        assert_eq!(tasks[0]["prompt"], "test prompt");
    }

    #[tokio::test]
    async fn get_task_by_id_not_found_returns_404() {
        let app = test_app();
        let fake_id = Uuid::new_v4();
        let resp = app
            .oneshot(
                Request::builder()
                    .method(Method::GET)
                    .uri(format!("/tasks/{}", fake_id))
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();

        assert_eq!(resp.status(), StatusCode::NOT_FOUND);
    }

    #[tokio::test]
    async fn post_events_returns_204() {
        let app = test_app();
        let event = serde_json::json!({
            "type": "session.idle",
            "session_id": "ses_unknown_123"
        });
        let resp = app
            .oneshot(
                Request::builder()
                    .method(Method::POST)
                    .uri("/events")
                    .header("content-type", "application/json")
                    .body(Body::from(serde_json::to_string(&event).unwrap()))
                    .unwrap(),
            )
            .await
            .unwrap();

        assert_eq!(resp.status(), StatusCode::NO_CONTENT);
    }
}
