// Custody module (M2 Wave 2, ROADMAP #15/#16): real BYOK key custody.
//
// Step 10: the implementation moved VERBATIM to packages/custody so the
// WORKER — where the MCP client opens superpower grants — can use the same
// envelope without a token-bearing API existing. This re-export keeps every
// server import path working unchanged; the BYOK suite moved with the code
// and passes unchanged (the relocation is additive by test, not by intent).
export * from '@potion/custody';
