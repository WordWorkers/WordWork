//! Errors carry an HTTP-like status so the frontend can keep treating them as
//! before (404 not found, 409 conflict, 400 bad input, 500 internal …).

use serde::Serialize;

#[derive(Debug, Clone, Serialize, thiserror::Error)]
#[error("{detail}")]
pub struct Error {
    pub status: u16,
    pub detail: String,
}

impl Error {
    pub fn new(status: u16, detail: impl Into<String>) -> Self {
        Self { status, detail: detail.into() }
    }
    pub fn bad_request(detail: impl Into<String>) -> Self {
        Self::new(400, detail)
    }
    pub fn not_found(detail: impl Into<String>) -> Self {
        Self::new(404, detail)
    }
    pub fn conflict(detail: impl Into<String>) -> Self {
        Self::new(409, detail)
    }
    pub fn internal(detail: impl Into<String>) -> Self {
        Self::new(500, detail)
    }
    pub fn bad_gateway(detail: impl Into<String>) -> Self {
        Self::new(502, detail)
    }
}

pub type Result<T> = std::result::Result<T, Error>;
