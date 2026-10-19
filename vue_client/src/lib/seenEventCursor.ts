// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// The highest event id this client has observed in any buffer. useSocket keeps
// a separate safe resume checkpoint until snapshot consumption completes.
// A module of its own so the buffers store can read it too — a detaching buffer takes it as
// the floor of what it has already seen (buffers.ts noteLiveTail) — without the
// store depending on the socket module (and every test that mocks it).

let cursor = 0;

export function seenEventCursor(): number {
  return cursor;
}

export function setSeenEventCursor(id: number): void {
  cursor = id;
}
