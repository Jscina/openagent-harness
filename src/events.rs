use serde::Deserialize;

#[derive(Debug, Deserialize)]
pub struct PluginEvent {
    #[serde(rename = "type")]
    pub event_type: String,
    pub session_id: String,
    #[serde(default)]
    pub payload: serde_json::Value,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn deserialize_session_idle() {
        let json = r#"{
            "type": "session.idle",
            "session_id": "ses_abc123",
            "payload": {"sessionID": "ses_abc123"}
        }"#;
        let e: PluginEvent = serde_json::from_str(json).unwrap();
        assert_eq!(e.event_type, "session.idle");
        assert_eq!(e.session_id, "ses_abc123");
    }

    #[test]
    fn deserialize_missing_payload_defaults_null() {
        let json = r#"{"type":"session.idle","session_id":"ses_xyz"}"#;
        let e: PluginEvent = serde_json::from_str(json).unwrap();
        assert!(e.payload.is_null());
    }

    #[test]
    fn deserialize_tool_before() {
        let json = r#"{
            "type": "tool.execute.before",
            "session_id": "ses_123",
            "payload": {"tool": "bash", "callID": "call_1", "args": {"command": "ls"}}
        }"#;
        let e: PluginEvent = serde_json::from_str(json).unwrap();
        assert_eq!(e.event_type, "tool.execute.before");
        assert_eq!(e.payload["tool"], "bash");
    }
}
