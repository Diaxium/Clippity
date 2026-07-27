/**
 * Countdown wire-format contracts — mirror Rust `domain::countdown`.
 */

export interface CountdownRequest {
  seconds: number;
}

export interface CountdownStartEvent {
  seconds: number;
}
