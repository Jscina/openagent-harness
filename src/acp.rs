use anyhow::{Context, Result};
use reqwest::Client;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;

#[derive(Clone)]
pub struct AcpClient {
    client: Client,
    base_url: String,
    password: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct AcpSession {
    pub id: String,
}

#[derive(Debug, Deserialize)]
#[allow(dead_code)]
pub struct AcpSessionStatus {
    #[serde(rename = "type")]
    pub status_type: String,
}

#[derive(Debug, Serialize)]
struct PromptAsyncBody {
    parts: Vec<MessagePart>,
    #[serde(skip_serializing_if = "Option::is_none")]
    model: Option<ModelSpec>,
}

#[derive(Debug, Serialize)]
struct MessagePart {
    #[serde(rename = "type")]
    part_type: String,
    text: String,
}

#[derive(Debug, Serialize)]
struct ModelSpec {
    #[serde(rename = "providerID")]
    provider_id: String,
    #[serde(rename = "modelID")]
    model_id: String,
}

impl AcpClient {
    pub fn new(base_url: String, password: Option<String>) -> Self {
        Self {
            client: Client::new(),
            base_url,
            password,
        }
    }

    fn request(&self, method: reqwest::Method, path: &str) -> reqwest::RequestBuilder {
        let url = format!("{}{}", self.base_url, path);
        let mut req = self.client.request(method, &url);
        if let Some(ref pw) = self.password {
            req = req.basic_auth("opencode", Some(pw));
        }
        req
    }

    pub async fn create_session(&self) -> Result<String> {
        let resp = self
            .request(reqwest::Method::POST, "/session")
            .json(&serde_json::json!({}))
            .send()
            .await
            .context("ACP: failed to POST /session")?
            .error_for_status()
            .context("ACP: create session error status")?;

        let session: AcpSession = resp
            .json()
            .await
            .context("ACP: failed to parse session response")?;
        Ok(session.id)
    }

    pub async fn send_message(&self, session_id: &str, prompt: &str, model: &str) -> Result<()> {
        let body = PromptAsyncBody {
            parts: vec![MessagePart {
                part_type: "text".to_string(),
                text: prompt.to_string(),
            }],
            model: parse_model_string(model),
        };

        self.request(
            reqwest::Method::POST,
            &format!("/session/{}/prompt_async", session_id),
        )
        .json(&body)
        .send()
        .await
        .context("ACP: failed to POST prompt_async")?
        .error_for_status()
        .context("ACP: prompt_async error status")?;

        Ok(())
    }

    pub async fn get_session_status(&self) -> Result<HashMap<String, AcpSessionStatus>> {
        let resp = self
            .request(reqwest::Method::GET, "/session/status")
            .send()
            .await
            .context("ACP: failed to GET /session/status")?
            .error_for_status()
            .context("ACP: session status error status")?;

        resp.json()
            .await
            .context("ACP: failed to parse session status response")
    }

    pub async fn delete_session(&self, session_id: &str) -> Result<()> {
        self.request(
            reqwest::Method::DELETE,
            &format!("/session/{}", session_id),
        )
        .send()
        .await
        .context("ACP: failed to DELETE session")?
        .error_for_status()
        .context("ACP: delete session error status")?;

        Ok(())
    }

    pub async fn health_check(&self) -> bool {
        self.get_session_status().await.is_ok()
    }
}

fn parse_model_string(model: &str) -> Option<ModelSpec> {
    if model.is_empty() {
        return None;
    }
    if let Some((provider, model_id)) = model.split_once('/') {
        Some(ModelSpec {
            provider_id: provider.to_string(),
            model_id: model_id.to_string(),
        })
    } else {
        Some(ModelSpec {
            provider_id: "anthropic".to_string(),
            model_id: model.to_string(),
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_model_with_slash() {
        let spec = parse_model_string("anthropic/claude-sonnet-4-20250514").unwrap();
        assert_eq!(spec.provider_id, "anthropic");
        assert_eq!(spec.model_id, "claude-sonnet-4-20250514");
    }

    #[test]
    fn parse_model_no_slash_defaults_anthropic() {
        let spec = parse_model_string("claude-sonnet-4-20250514").unwrap();
        assert_eq!(spec.provider_id, "anthropic");
        assert_eq!(spec.model_id, "claude-sonnet-4-20250514");
    }

    #[test]
    fn parse_model_empty_returns_none() {
        assert!(parse_model_string("").is_none());
    }

    #[test]
    fn prompt_async_body_no_model_skipped() {
        let body = PromptAsyncBody {
            parts: vec![MessagePart {
                part_type: "text".to_string(),
                text: "hello".to_string(),
            }],
            model: None,
        };
        let json = serde_json::to_value(&body).unwrap();
        assert!(json.get("model").is_none());
        assert_eq!(json["parts"][0]["type"], "text");
        assert_eq!(json["parts"][0]["text"], "hello");
    }

    #[test]
    fn prompt_async_body_with_model_serializes_correctly() {
        let body = PromptAsyncBody {
            parts: vec![MessagePart {
                part_type: "text".to_string(),
                text: "test".to_string(),
            }],
            model: parse_model_string("anthropic/claude-opus-4-5"),
        };
        let json = serde_json::to_value(&body).unwrap();
        assert_eq!(json["model"]["providerID"], "anthropic");
        assert_eq!(json["model"]["modelID"], "claude-opus-4-5");
    }
}
