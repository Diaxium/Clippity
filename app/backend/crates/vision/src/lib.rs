//! Vision — the on-device AI subsystem.
//!
//! Isolated into its own crate so its heavy, slow-compiling dependencies
//! (ONNX Runtime via `ort`, `ndarray`) build in parallel with the rest of
//! the workspace and cache independently of ordinary app-layer edits.
//!
//!   vision_service — object detection (ONNX inference, Object mode)
//!   model_service  — on-device model download / install / remove + registry
//!
//! Both depend only on `clippity-domain` + `clippity-infra`; nothing in
//! `clippity-services` depends on this crate (the app layer wires them).

pub mod model_service;
pub mod vision_service;
