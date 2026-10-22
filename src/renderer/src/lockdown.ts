// Primer import de main.tsx: se evalúa antes que React y cualquier otra dependencia del bundle
// (docs/DESIGN.md §5.4, punto 5). APIs de red que no pasan por webRequest ni por la CSP. Las
// interfaces WebIDL son propiedades configurables del objeto global, así que se pueden borrar.
for (const k of [
  'RTCPeerConnection',
  'webkitRTCPeerConnection',
  'RTCDataChannel',
  'RTCSessionDescription',
  'RTCIceCandidate',
] as const) {
  delete (globalThis as Record<string, unknown>)[k];
}

export {};
